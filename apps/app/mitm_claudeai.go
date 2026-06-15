package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
)

// ─── claude.ai 解密 + 订阅改写(掀翻 Desktop Code/Cowork 付费墙)──────────────
//
// Desktop 的 Chromium UI 通过 claude.ai 查账号订阅态来决定是否放行 Code/Cowork(付费功能)。
// 该判定不在 api.anthropic.com(实测 /api/hello 根本没被调),只能解密 claude.ai、把订阅相关
// 字段改写成"已订阅"。claude.ai 在 Cloudflare 后面,必须用 utls(浏览器指纹)转发,否则 403。
//
// 转发携带用户真实 claude.ai cookie(ReverseProxy 默认透传请求头)→ 真 claude.ai 返回该用户
// (免费号)的真实订阅 → 我们改写订阅字段 → Chromium 以为已订阅 → 放行 Code/Cowork。
//
// 诊断期:打印每个 claude.ai 端点的路径 + 响应体(截断),用来定位订阅判定端点/字段后精修。

const claudeAiBase = "https://claude.ai"

// mitmIsClaudeAiHost 判断是否 claude.ai(主 API 域;a.claude.ai 等子域暂仍透传)。
func mitmIsClaudeAiHost(host string) bool {
	return mitmHostOnly(host) == "claude.ai"
}

// mitmClaudeAiHandler 经 utls 把 claude.ai 请求转发到真实 claude.ai(绕 Cloudflare),
// 读响应、打印、并把订阅字段改写成已订阅。
//
// sessionKeyFn:借号注入。返回非空时,把请求 Cookie 里的 sessionKey 顶替成租到的白号 ——
// 让所有 claude.ai 流量都以白号身份发出(借号)。返回 "" 则不改 Cookie(透传用户自己的登录态,
// 保持原有行为)。其余 cookie(CF clearance 等)一律保留,只换 sessionKey。
func mitmClaudeAiHandler(transport http.RoundTripper, sessionKeyFn func() string) http.Handler {
	target, _ := url.Parse(claudeAiBase)
	if transport == nil {
		transport = newClaudeUpstreamTransport("") // utls 指纹绕 Cloudflare
	}
	return &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host
			req.Host = target.Host
			req.Header.Del("Accept-Encoding") // 要明文才好改写
			if sessionKeyFn != nil {
				if sk := sessionKeyFn(); sk != "" {
					mitmInjectSessionKeyCookie(req, sk)
				}
			}
		},
		Transport:      transport,
		ModifyResponse: mitmModifyClaudeAiResponse,
	}
}

// mitmIsCloudflareChallenge 判断响应是不是 Cloudflare 的挑战/拦截(而非 claude.ai 业务响应)。
// 命中则整段原样透传,交给真 Chromium 自己解。靠 CF 专有响应头判定,不用读 body:
//   - cf-mitigated:CF 明确标注「已拦截/挑战」
//   - server-timing: chlray;… :挑战页特征(我们实测 403 时就带这个)
//   - 403/503 + Server: cloudflare + text/html:CF 托管挑战页(claude.ai 自身错误是 JSON,不会命中)
func mitmIsCloudflareChallenge(resp *http.Response) bool {
	if resp == nil {
		return false
	}
	if resp.Header.Get("Cf-Mitigated") != "" {
		return true
	}
	if st := strings.ToLower(resp.Header.Get("Server-Timing")); strings.Contains(st, "chlray") {
		return true
	}
	switch resp.StatusCode {
	case http.StatusForbidden, http.StatusServiceUnavailable, http.StatusTooManyRequests:
		if strings.EqualFold(resp.Header.Get("Server"), "cloudflare") &&
			strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "text/html") {
			return true
		}
	}
	return false
}

// mitmStripSessionKeySetCookie 只从 Set-Cookie 里剔掉 claude.ai 的 sessionKey(借号身份不落
// 用户浏览器,保护用户自己的号),其余 cookie(尤其 CF 的 cf_clearance/__cf_bm/cf_chl_*)全保留。
func mitmStripSessionKeySetCookie(h http.Header) {
	vals := h.Values("Set-Cookie")
	if len(vals) == 0 {
		return
	}
	var kept []string
	for _, v := range vals {
		name := v
		if i := strings.IndexByte(v, '='); i >= 0 {
			name = v[:i]
		}
		if strings.EqualFold(strings.TrimSpace(name), "sessionKey") {
			continue // 丢掉白号 sessionKey 的 Set-Cookie
		}
		kept = append(kept, v)
	}
	h.Del("Set-Cookie")
	for _, v := range kept {
		h.Add("Set-Cookie", v)
	}
}

// mitmInjectSessionKeyCookie 重建请求 Cookie 头:【只留 Cloudflare 的 cookie】+ 注入白号 sessionKey。
// 用户自己账号的 claude.ai cookie(sessionKey/org/device/活动会话等)一律丢掉 —— 否则白号的
// sessionKey 与用户自己账号的其它 cookie 混在一起,claude.ai 判会话不一致、直接 account_session_invalid。
// (实测:只发 sessionKey 一个 cookie → 200;带上别的账号 cookie → 失效。)
// CF 的 __cf_bm/cf_clearance 等与账号无关、是过 CF 必需的,保留。
func mitmInjectSessionKeyCookie(req *http.Request, sk string) {
	existing := req.Header.Get("Cookie")
	var kept []string
	for _, part := range strings.Split(existing, ";") {
		p := strings.TrimSpace(part)
		if p == "" {
			continue
		}
		name := p
		if i := strings.IndexByte(p, '='); i >= 0 {
			name = p[:i]
		}
		if isCloudflareCookie(name) {
			kept = append(kept, p) // 只保留 CF cookie
		}
	}
	kept = append(kept, "sessionKey="+sk)
	req.Header.Set("Cookie", strings.Join(kept, "; "))
}

// isCloudflareCookie 判断 cookie 名是否属于 Cloudflare(过 CF/bot 管理用,与 claude.ai 账号身份无关)。
func isCloudflareCookie(name string) bool {
	n := strings.ToLower(strings.TrimSpace(name))
	return strings.HasPrefix(n, "__cf") || strings.HasPrefix(n, "cf_") || strings.HasPrefix(n, "__cflb")
}

// patchUserAccessFeatures 把 current_user_access 里 code/cowork 相关 feature 的 status 放成 available。
// 只放开这几类,避免误开平台真不支持的项(如 haystack=blocked_by_platform)。
func patchUserAccessFeatures(v interface{}) bool {
	m, ok := v.(map[string]interface{})
	if !ok {
		return false
	}
	feats, ok := m["features"].([]interface{})
	if !ok {
		return false
	}
	changed := false
	for _, f := range feats {
		fm, ok := f.(map[string]interface{})
		if !ok {
			continue
		}
		name, _ := fm["feature"].(string)
		st, _ := fm["status"].(string)
		if st == "available" {
			continue
		}
		if strings.HasPrefix(name, "claude_code") || name == "cowork" || name == "dittos" || name == "skills" {
			fm["status"] = "available"
			changed = true
		}
	}
	return changed
}

// patchCoworkSettings 把 cowork_settings 的开关打开。
func patchCoworkSettings(v interface{}) bool {
	m, ok := v.(map[string]interface{})
	if !ok {
		return false
	}
	changed := false
	for _, k := range []string{"enabled", "can_be_enabled", "dittos_enabled"} {
		if b, ok := m[k].(bool); !ok || !b {
			m[k] = true
			changed = true
		}
	}
	return changed
}

// mitmClaudeAiIsGateEndpoint 命中 Code/Cowork 资格判定端点,需要改写。其余 claude.ai 端点
// (会话/login/纯 statsig bootstrap 等)一律字节级原样透传,绝不读取或重写,避免破坏会话完整性。
//   - current_user_access:feature 准入(claude_code/cowork → available)
//   - cowork_settings:cowork 开关
//   - /api/organizations/{uuid}(org 根):capabilities/rate_limit_tier/billing_type(UI 判付费墙的主信号)
//   - /edge-api/bootstrap/{org}/app_start:内嵌 account+org,同样含上述订阅信号
func mitmClaudeAiIsGateEndpoint(path string) bool {
	return strings.Contains(path, "/current_user_access") ||
		strings.HasSuffix(path, "/cowork_settings") ||
		isClaudeAiOrgRootPath(path) ||
		strings.HasSuffix(path, "/app_start")
}

// isClaudeAiOrgRootPath 精确匹配 /api/organizations/{uuid}(无后续子路径)。
func isClaudeAiOrgRootPath(path string) bool {
	const p = "/api/organizations/"
	if !strings.HasPrefix(path, p) {
		return false
	}
	rest := strings.TrimPrefix(path, p)
	return rest != "" && !strings.Contains(rest, "/")
}

// patchSubscriptionTree 递归把订阅信号升级到 Max:capabilities 补 claude_max、
// rate_limit_tier→max、billing_type 非空、subscription_type→max、has_claude_*→true。
// 只在资格端点上调用(org 根 / app_start),不全局,避免误伤。返回是否有改动。
func patchSubscriptionTree(v interface{}) bool {
	changed := false
	switch t := v.(type) {
	case map[string]interface{}:
		for k, val := range t {
			switch k {
			case "rate_limit_tier":
				if s, ok := val.(string); ok && s != "default_claude_max_20x" {
					t[k] = "default_claude_max_20x"
					changed = true
				}
			case "capabilities":
				if arr, ok := val.([]interface{}); ok {
					has := false
					for _, e := range arr {
						if e == "claude_max" {
							has = true
						}
					}
					if !has {
						t[k] = append(arr, "claude_max")
						changed = true
					}
				}
			case "organization_type":
				if val != "claude_max" {
					t[k] = "claude_max"
					changed = true
				}
			case "billing_type":
				if val == nil || val == "" {
					t[k] = "google_play_subscription"
					changed = true
				}
			case "has_claude_pro", "has_claude_max":
				if val != true {
					t[k] = true
					changed = true
				}
			default:
				if patchSubscriptionTree(val) {
					changed = true
				}
			}
		}
	case []interface{}:
		for _, e := range t {
			if patchSubscriptionTree(e) {
				changed = true
			}
		}
	}
	return changed
}

func mitmModifyClaudeAiResponse(resp *http.Response) error {
	path := ""
	if resp.Request != nil && resp.Request.URL != nil {
		path = resp.Request.URL.Path
	}

	// ★ Cloudflare 挑战/拦截响应:整段【原样透传】,绝不注入脚本、删 CSP 或删 Cookie。
	//   CF 的 JS 挑战要靠它自己的脚本 + CSP + cf_clearance/__cf_bm/cf_chl_* cookie 才能在
	//   Chromium 里解开;一旦我们改写,真 Chromium 也会永远卡在「Just a moment」进不去。
	//   (借号走数据中心代理 IP 时 claude.ai 常发 CF 挑战 —— 让浏览器自己解。)
	if mitmIsCloudflareChallenge(resp) {
		return nil
	}

	// ★ 借号期:只删 claude.ai 的 sessionKey Set-Cookie —— 防白号 sessionKey 被 Chromium 存进
	//   用户 profile、覆盖用户自己的(否则取消接管回不去)。CF 的 cf_clearance/__cf_bm 等必须保留,
	//   否则 Chromium 解完挑战存不下、反复被挑战。借号身份本身活在 in-flight 注入的请求头里。
	//   未借号时不动 Set-Cookie,用户自己的会话照常刷新。
	if GetClaudeSessionLeaser().CurrentSessionKey() != "" {
		mitmStripSessionKeySetCookie(resp.Header)
	}

	// ★ 顶层 HTML 文档(仅 2xx 正常页):注入「隐藏 chat」守卫脚本(chat/code UI 都来自 claude.ai 网页)。
	//   只认 text/html、且只对 2xx —— 错误页/CF 挑战页(403/503)绝不注入。见 mitm_claudeai_inject.go。
	if resp.StatusCode == http.StatusOK && mitmIsClaudeAiHTMLDocument(resp) {
		return mitmInjectHideChat(resp)
	}

	// ★ 非资格端点:直接 return nil,ReverseProxy 会把上游响应【字节级原样】流回客户端
	//   (不读 body、不解 gzip、不重序列化),从而完全不触碰会话/bootstrap,保住登录态。
	if !mitmClaudeAiIsGateEndpoint(path) {
		return nil
	}

	body, err := readMaybeGzip(resp)
	if err != nil {
		return nil
	}
	if !strings.Contains(resp.Header.Get("Content-Type"), "json") || len(body) == 0 {
		// 不是 JSON 就原样写回(已读出 body,需回填)。
		resp.Body = io.NopCloser(bytes.NewReader(body))
		resp.ContentLength = int64(len(body))
		resp.Header.Set("Content-Length", strconv.Itoa(len(body)))
		resp.Header.Del("Content-Encoding")
		return nil
	}

	newBody := body
	switch {
	case strings.Contains(path, "/current_user_access"):
		if patched, ok := patchJSON(body, patchUserAccessFeatures); ok {
			newBody = patched
		}
	case strings.HasSuffix(path, "/cowork_settings"):
		if patched, ok := patchJSON(body, patchCoworkSettings); ok {
			newBody = patched
		}
	case isClaudeAiOrgRootPath(path) || strings.HasSuffix(path, "/app_start"):
		// org 根 / bootstrap:把 capabilities/rate_limit_tier/billing_type 升级成 Max(UI 付费墙主信号)。
		if patched, ok := patchJSON(body, patchSubscriptionTree); ok {
			newBody = patched
		}
	}

	resp.Body = io.NopCloser(bytes.NewReader(newBody))
	resp.ContentLength = int64(len(newBody))
	resp.Header.Set("Content-Length", strconv.Itoa(len(newBody)))
	resp.Header.Del("Content-Encoding")
	return nil
}

// patchJSON 解析 body、跑 fn 改写、再序列化。fn 返回是否有改动。无改动/解析失败 → (原body,false)。
func patchJSON(body []byte, fn func(interface{}) bool) ([]byte, bool) {
	var v interface{}
	if json.Unmarshal(body, &v) != nil {
		return body, false
	}
	if !fn(v) {
		return body, false
	}
	out, err := json.Marshal(v)
	if err != nil {
		return body, false
	}
	return out, true
}
