package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
)

// ─── 白号登录号池(claude.ai sessionKey)客户端租约 ─────────────────────────────
//
// 接管 claude.ai 时,向服务端租一个白号(sessionKey + 绑定的静态出口代理),用 utls(绕 CF)
// + 该静态出口【客户端实测】sessionKey 是否有效,然后回报服务端(能用/不能用都报)。usable 的
// 才设为 current,供 mitm_claudeai.go 的 Director 注入 Cookie、出口走该号静态 IP(借号)。
//
// 为什么验证放客户端而非服务端:claude.ai 在 Cloudflare 后,服务端任何非浏览器 TLS 指纹(含
// curl/Node fetch)都被 403 challenge;唯一过得了 CF 的是本进程的 utls 路径(同 Code/Cowork 接管)。

// 服务端白号租约接口(与 OAuth 号池 lease-token 分开)。可经 BCAI_ANTHROPIC_WEB_REMOTE_BASE
// 显式覆盖;默认从 ANTHROPIC_REMOTE_BASE 派生(把 .../anthropic 换成 .../anthropic-web),
// 这样 dev(本地 127.0.0.1:3001)/prod(api.bcai.lol)对 anthropic base 的任何覆盖都自动跟随,
// 无需再单独配一个 env。
var ANTHROPIC_WEB_REMOTE_BASE = getEnvOrDefault(
	"BCAI_ANTHROPIC_WEB_REMOTE_BASE",
	strings.TrimSuffix(ANTHROPIC_REMOTE_BASE, "/anthropic")+"/anthropic-web",
)

const (
	claudeAiOrgsURL = "https://claude.ai/api/organizations"
	claudeWebUA     = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
	sessionMaxTries = 3 // 一次接管最多连试几个白号,直到一个实测可用
)

type SessionLease struct {
	LeaseId    string
	AccountId  int
	Email      string
	SessionKey string
	ProxyURL   string
	OrgId      string
}

type sessionLeaseResp struct {
	Ok              bool   `json:"ok"`
	Error           string `json:"error"`
	LeaseId         string `json:"leaseId"`
	AccountId       int    `json:"accountId"`
	Email           string `json:"email"`
	SessionKey      string `json:"sessionKey"`
	AccountProxyUrl string `json:"accountProxyUrl"`
	OrgId           string `json:"orgId"`
}

type ClaudeSessionLeaser struct {
	mu       sync.Mutex
	current  *SessionLease
	notice   string // 一次性提示(借号失败时设,GetStats 读取即清 → 前端 toast)
	card     string // 借号授权(UserToken):租号时记下,供会话轮换上报复用
	upstream string // 上游 base 选择:同上,供轮换上报走同一通道
}

var globalClaudeSessionLeaser = &ClaudeSessionLeaser{}

func GetClaudeSessionLeaser() *ClaudeSessionLeaser { return globalClaudeSessionLeaser }

func (l *ClaudeSessionLeaser) Current() *SessionLease {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.current
}

// CurrentSessionKey / CurrentProxyURL 供 mitm 层 Director / transport 实时读取借号身份与出口。
func (l *ClaudeSessionLeaser) CurrentSessionKey() string {
	if c := l.Current(); c != nil {
		return c.SessionKey
	}
	return ""
}

func (l *ClaudeSessionLeaser) CurrentProxyURL() string {
	if c := l.Current(); c != nil {
		return c.ProxyURL
	}
	return ""
}

// Clear 取消借号(还原接管时调用),claude.ai 立即退回透传用户自己的登录态。
func (l *ClaudeSessionLeaser) Clear() {
	l.mu.Lock()
	l.current = nil
	l.mu.Unlock()
}

// setNotice / TakeNotice:借号失败的一次性提示。借号失败不阻塞接管(claude.ai 退回用户自己
// 登录态),但要让前端 toast 告知用户「借号没成,请自行登录 claude.ai」。GetStats 读取即清。
func (l *ClaudeSessionLeaser) setNotice(msg string) {
	l.mu.Lock()
	l.notice = msg
	l.mu.Unlock()
}

func (l *ClaudeSessionLeaser) TakeNotice() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	m := l.notice
	l.notice = ""
	return m
}

func (l *ClaudeSessionLeaser) leaseOnce(card, upstream string) (*SessionLease, error) {
	payload := map[string]interface{}{
		"reason":        "claude-ai-takeover",
		"clientVersion": AppVersion,
	}
	body, status, err := postBcaiBaseWithFallback(ANTHROPIC_WEB_REMOTE_BASE, "/lease-session", payload, card, upstream)
	if err != nil {
		return nil, err
	}
	if status >= 400 {
		return nil, fmt.Errorf("lease-session HTTP %d: %s", status, string(body))
	}
	var r sessionLeaseResp
	if e := json.Unmarshal(body, &r); e != nil {
		return nil, fmt.Errorf("lease-session 解析失败: %w", e)
	}
	if !r.Ok {
		if r.Error == "" {
			r.Error = "lease-session 返回 ok=false"
		}
		return nil, errors.New(r.Error)
	}
	if r.SessionKey == "" {
		return nil, errors.New("lease-session 返回空 sessionKey")
	}
	return &SessionLease{
		LeaseId:    r.LeaseId,
		AccountId:  r.AccountId,
		Email:      r.Email,
		SessionKey: r.SessionKey,
		ProxyURL:   r.AccountProxyUrl,
		OrgId:      r.OrgId,
	}, nil
}

// fault 区分失败归因:"account"=号本身坏(sessionKey 失效)→ 服务端标 unusable 不再下发;
// "egress"=代理/CF 的问题(出口 IP 过不了 claude.ai 的 Cloudflare,号未必坏)→ 服务端【不】
// 标 unusable,只记 lastError,下次照常可租,免得因为代理烂烧掉好号。
type probeResult struct {
	ok     bool
	orgId  string
	errMsg string
	fault  string // "" | "account" | "egress"
}

func (l *ClaudeSessionLeaser) report(card, upstream string, accountId int, r probeResult) {
	payload := map[string]interface{}{
		"accountId": accountId,
		"ok":        r.ok,
		"error":     r.errMsg,
		"orgId":     r.orgId,
		"fault":     r.fault,
	}
	if _, _, err := postBcaiBaseWithFallback(ANTHROPIC_WEB_REMOTE_BASE, "/report-session", payload, card, upstream); err != nil {
		Log("[session-leaser] 回报失败(不影响本机使用): %v", err)
	}
}

// LeaseAndVerify 接管时拉白号 + 客户端 utls 实测 + 回报,然后决定注入哪个号:
//   - probe ok(实测能用)            → 立即注入,最佳。
//   - probe 被 CF 拦(egress,无头探不动)→ 记为「待 Chromium 试」候选;真浏览器能解 JS 挑战,
//     所以全部探完若没有 ok 的,就注入这个候选交给 Chromium。
//   - sessionKey 失效(account)      → 跳过,换下一个。
//
// 连试 sessionMaxTries 个(每个号有各自静态出口)。
func (l *ClaudeSessionLeaser) LeaseAndVerify(card, deviceId, upstream string) error {
	l.mu.Lock()
	l.card, l.upstream = card, upstream // 记下授权/通道,供后续会话轮换上报复用
	l.mu.Unlock()
	var lastErr error
	var cfFallback *SessionLease // probe 被 CF 拦但号未必坏,留给真 Chromium 解挑战试
	for i := 0; i < sessionMaxTries; i++ {
		lease, err := l.leaseOnce(card, upstream)
		if err != nil {
			break // 池子空了 / 网络错:没号可再试,跳出去看有没有 CF 候选兜底。
		}
		r := probeSessionKey(lease.SessionKey, lease.ProxyURL)
		l.report(card, upstream, lease.AccountId, r)
		if r.ok {
			if r.orgId != "" {
				lease.OrgId = r.orgId
			}
			l.setCurrent(lease)
			Log("[session-leaser] ✓ 白号 #%d (%s) 实测可用,已注入借号", lease.AccountId, lease.Email)
			return nil
		}
		if r.fault == "egress" {
			if cfFallback == nil {
				cfFallback = lease
			}
			Log("[session-leaser] ⚠ 白号 #%d (%s) 无头 probe 被 CF 拦(号未必坏): %s", lease.AccountId, lease.Email, r.errMsg)
		} else {
			Log("[session-leaser] ✗ 白号 #%d (%s) sessionKey 失效: %s,换下一个", lease.AccountId, lease.Email, r.errMsg)
		}
		lastErr = errors.New(r.errMsg)
	}

	// 没有实测能用的,但有被 CF 拦的候选:仍注入,交给真 Chromium 去解 CF 挑战 + 验号。
	// 真用不了会在实际 claude.ai 请求里暴露(那时退回/换号由后续迭代处理)。
	if cfFallback != nil {
		l.setCurrent(cfFallback)
		Log("[session-leaser] ⚠ probe 均被 CF 拦,仍注入 #%d (%s) —— 交给 Chromium 解挑战试", cfFallback.AccountId, cfFallback.Email)
		return nil
	}
	return fmt.Errorf("无可用白号: %v", lastErr)
}

func (l *ClaudeSessionLeaser) setCurrent(lease *SessionLease) {
	l.mu.Lock()
	l.current = lease
	l.mu.Unlock()
}

// OnRotatedSessionKey claude.ai 在借号会话里下发新 sessionKey(会话轮换)时调用。
// claude.ai 的 web 会话会轮换 sessionKey 并作废旧的;旧版把轮换的新 sk 直接 strip 丢弃,
// 导致旧 sk 失效后"第二次未登录"、号还被烧成 unusable。这里改为:
//   ① 本地把 current 的 sk 顶替成新值 —— 后续请求继续以活的 sk 发出,本会话不掉线;
//   ② 异步上报服务端把号池存的 sk 也更新掉 —— 下次租约(本机或他人)拿到的是活号而非死号。
// newSk 为空、当前未借号、或与当前相同 → 忽略(天然去重,避免无谓上报)。
// 注意:仍由调用方负责把这条 Set-Cookie strip 掉,新 sk 绝不落进 Chromium profile。
func (l *ClaudeSessionLeaser) OnRotatedSessionKey(newSk string) {
	if newSk == "" {
		return
	}
	l.mu.Lock()
	if l.current == nil || l.current.SessionKey == newSk {
		l.mu.Unlock()
		return
	}
	accountId, email := l.current.AccountId, l.current.Email
	card, upstream := l.card, l.upstream
	l.current.SessionKey = newSk
	l.mu.Unlock()

	Log("[session-leaser] ⟳ 白号 #%d (%s) sessionKey 轮换,已本地顶替", accountId, email)
	if card == "" {
		return // 没授权凭证就只本地顶替,不上报(借号期理论上一定有 card)
	}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				Log("[session-leaser] 轮换上报 goroutine panic: %v", r)
			}
		}()
		l.reportRotation(card, upstream, accountId, newSk)
	}()
}

// reportRotation 把轮换后的新 sessionKey 推给服务端号池(/rotate-session),让存储的号也更新成活的。
func (l *ClaudeSessionLeaser) reportRotation(card, upstream string, accountId int, newSk string) {
	payload := map[string]interface{}{
		"accountId":  accountId,
		"sessionKey": newSk,
	}
	if _, status, err := postBcaiBaseWithFallback(ANTHROPIC_WEB_REMOTE_BASE, "/rotate-session", payload, card, upstream); err != nil {
		Log("[session-leaser] 轮换上报失败(不影响本机使用): %v", err)
	} else {
		Log("[session-leaser] 轮换上报完成 #%d → HTTP %d", accountId, status)
	}
}

// probeSessionKey 用 utls(绕 CF)+ 白号静态出口探 sessionKey 是否有效。
// 无静态出口直接判失败(不准裸连)。非 200 时抓响应体区分 CF 拦截(egress)与鉴权失败(account)。
func probeSessionKey(sessionKey, proxyURL string) probeResult {
	if proxyURL == "" {
		return probeResult{errMsg: "白号未配置静态出口代理(不准裸连)", fault: "egress"}
	}
	client := newClaudeUpstreamClient(proxyURL)
	req, err := http.NewRequest(http.MethodGet, claudeAiOrgsURL, nil)
	if err != nil {
		return probeResult{errMsg: "构造请求失败: " + err.Error(), fault: "egress"}
	}
	req.Header.Set("Cookie", "sessionKey="+sessionKey)
	req.Header.Set("User-Agent", claudeWebUA)
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		// 连不上 = 代理/网络问题,不是号的问题。
		return probeResult{errMsg: "请求失败: " + err.Error(), fault: "egress"}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	snippet := strings.TrimSpace(string(body))
	if len(snippet) > 200 {
		snippet = snippet[:200]
	}

	if resp.StatusCode == http.StatusOK {
		var orgs []struct {
			Uuid string `json:"uuid"`
		}
		_ = json.Unmarshal(body, &orgs)
		orgId := ""
		if len(orgs) > 0 {
			orgId = orgs[0].Uuid
		}
		return probeResult{ok: true, orgId: orgId}
	}

	// 抓 body 区分 CF 挑战 vs claude.ai 鉴权错误。日志带 snippet 便于现场诊断。
	ct := resp.Header.Get("Content-Type")
	isCloudflare := looksLikeCloudflare(ct, body)
	Log("[session-leaser] probe HTTP %d ct=%q cf=%v body=%q", resp.StatusCode, ct, isCloudflare, snippet)
	if isCloudflare {
		return probeResult{
			errMsg: fmt.Sprintf("Cloudflare 拦截 HTTP %d(代理 IP 可能被 claude.ai 风控)", resp.StatusCode),
			fault:  "egress",
		}
	}
	// 非 CF 的 4xx(401/403 带 JSON 等)= sessionKey 失效/无权,判号坏。
	return probeResult{
		errMsg: fmt.Sprintf("HTTP %d: %s", resp.StatusCode, snippet),
		fault:  "account",
	}
}

// looksLikeCloudflare 判断响应是否 Cloudflare 的挑战/拦截页(而非 claude.ai 的业务响应)。
func looksLikeCloudflare(contentType string, body []byte) bool {
	low := strings.ToLower(string(body))
	for _, m := range []string{"just a moment", "challenge-platform", "cf-mitigated", "cf-chl", "/cdn-cgi/", "cloudflare", "attention required"} {
		if strings.Contains(low, m) {
			return true
		}
	}
	// claude.ai 的 API 错误是 JSON;CF 挑战页是 HTML。HTML + 非 200 基本就是被挡在 CF。
	return strings.Contains(strings.ToLower(contentType), "text/html")
}
