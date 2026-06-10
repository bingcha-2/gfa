package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ─── 接管前置闸:出口探测(Windows / macOS 共用)──────────────────────────────
//
// 背景:配了「每号静态/住宅出口代理」的产品(anthropic 恒 required;codex/antigravity
// 绑了代理也算),接管后的官方流量必须从【代理 IP】出去,绝不能从用户真实(大陆)IP 直连
// —— 否则带账号 token 的请求暴露真实 IP → 反滥用信号 → 封号(见 egress 铁律)。
//
// 现实坑:egress 那一跳是裸 net.Dialer 直连账号代理,不走系统 HTTP 代理(7897);用户没开
// Clash TUN(全局)时,会从真实大陆 IP 裸连代理 → 部分代理直接 403「Mainland China IP banned」。
//
// 因此接管前先做一次「安全探测」:用该号的 proxyUrl 经代理 GET 一个【中立回显 IP 服务】
// (不是 Anthropic,全程不碰官方、不带 token,零封号风险),看能不能从代理出去:
//   - 200 + 拿到出口 IP → 链路通,放行接管;
//   - CONNECT 403 / banned → 代理拒了你的来源 IP → 拒绝接管,提示开 TUN;
//   - 连不上 / 超时          → 代理被墙或挂了 → 拒绝接管(fail-closed:没通过不准接管)。
//
// 关键:回显服务看到的来源 IP == Anthropic 将来会看到的 IP(同一台代理连出去的),所以这一探
// 精确回答了「能不能从代理 IP 出去」,且不需要任何自建服务端。

var (
	// errEgressBanned:代理在入口按来源 IP 拒绝(403 / banned),通常是没开 TUN、真实大陆 IP 裸连。
	errEgressBanned = errors.New("出口代理拒绝来源 IP(banned)")
	// errEgressNoExit:200 但没回显出 IP —— 视作不可信,按未通过处理。
	errEgressNoExit = errors.New("回显服务未返回出口 IP")
)

// egressEchoEndpoints:中立的「回显调用方 IP」服务,纯文本返回一行 IP。主 + 备,避免单点挂掉误判。
var egressEchoEndpoints = []string{
	"https://api.ipify.org",
	"https://ifconfig.me/ip",
}

// egressPreflightTimeout:单个回显端点的超时。两个端点串行,最坏 ~2×。设小是为了让 UI 不久等。
const egressPreflightTimeout = 6 * time.Second

// looksBanned 判断错误/响应文本是否是「按来源 IP 封禁」类信号(大小写无关)。
// 覆盖 CONNECT 403、显式 banned、以及上游那台代理给的「Mainland China IP ... banned」。
func looksBanned(s string) bool {
	s = strings.ToLower(s)
	for _, kw := range []string{"403", "forbidden", "banned", "mainland china"} {
		if strings.Contains(s, kw) {
			return true
		}
	}
	return false
}

// classifyEgressError 把 client.Do 的传输层错误归类:像封禁 → errEgressBanned;否则原样包成「连不通」。
func classifyEgressError(err error) error {
	if err == nil {
		return nil
	}
	if looksBanned(err.Error()) {
		return errEgressBanned
	}
	return fmt.Errorf("账号出口代理连不通: %w", err)
}

// egressPreflight 用账号代理 proxyURL 经代理 GET 回显服务,返回探到的出口 IP。
// 失败返回 (",", err):errEgressBanned=被代理按 IP 拒;其它=连不通/超时/异常。
func egressPreflight(proxyURL string) (string, error) {
	scheme, u, err := parseEgressProxy(proxyURL)
	if err != nil || scheme == "" {
		return "", fmt.Errorf("无效的账号出口代理地址: %v", err)
	}
	// http.Transport.Proxy 原生支持 http/https/socks5 的 CONNECT/拨号;parseEgressProxy 已校验过 scheme。
	client := &http.Client{
		Timeout: egressPreflightTimeout,
		Transport: &http.Transport{
			Proxy:                 http.ProxyURL(u),
			TLSHandshakeTimeout:   egressPreflightTimeout,
			ResponseHeaderTimeout: egressPreflightTimeout,
			DisableKeepAlives:     true,
		},
	}
	var lastErr error
	for _, endpoint := range egressEchoEndpoints {
		ip, perr := egressProbeOnce(client, endpoint)
		if perr == nil {
			return ip, nil
		}
		// 明确「被 ban」是确定性结论(换个回显端点也一样),无需再试备用,直接返回。
		if errors.Is(perr, errEgressBanned) {
			return "", perr
		}
		lastErr = perr
	}
	if lastErr == nil {
		lastErr = errors.New("账号出口探测失败")
	}
	return "", lastErr
}

// egressProbeOnce 对单个回显端点探一次,解析出口 IP 或归类错误。
func egressProbeOnce(client *http.Client, endpoint string) (string, error) {
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", classifyEgressError(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
	if resp.StatusCode == http.StatusOK {
		ip := strings.TrimSpace(string(body))
		if ip == "" {
			return "", errEgressNoExit
		}
		return ip, nil
	}
	if resp.StatusCode == http.StatusForbidden || looksBanned(string(body)) {
		return "", errEgressBanned
	}
	return "", fmt.Errorf("回显服务返回 HTTP %d", resp.StatusCode)
}

// anthropicProbeTarget:anthropic 真实可达性探测的目标(host:port)。
const anthropicProbeTarget = "api.anthropic.com:443"

// egressAnthropicReachable 经账号代理对 api.anthropic.com:443 做一次【裸 CONNECT】:走和真实请求
// 完全相同的出口路径(dialRawThroughProxy → ConnectViaProxy / SOCKS5),只建隧道、不发 TLS、不带
// token,成功立刻关闭。anthropic 侧只会看到一个空闲 TCP 连接,零封号信号。
//
// 为什么 ipify 探测不够:节点可能「能上网(ipify 通)却对 anthropic 定向拦截/污染」——明文 CONNECT
// 被中间盒子注一个假的 400。ipify 那一探永远发现不了,于是给坏节点开绿灯、接管后每个真实请求才 502。
// 这一探用真实目标 + 真实出口路径,把这种坏路径在接管前就拦下。
func egressAnthropicReachable(proxyURL string) error {
	// 铁律 fail-closed:proxyURL 为空时 dialRawThroughProxy 会回落【直连】，会从本机真实 IP 裸连
	// anthropic → 暴露真实 IP 封号风险。这里硬拒，绝不直连 —— 即使调用点漏了非空校验也兜得住。
	if strings.TrimSpace(proxyURL) == "" {
		return errors.New("anthropic 出口探测拒绝：无出口代理，不允许从本机直连")
	}
	ctx, cancel := context.WithTimeout(context.Background(), egressPreflightTimeout)
	defer cancel()
	conn, err := dialRawThroughProxy(ctx, anthropicProbeTarget, proxyURL)
	if err != nil {
		return err
	}
	_ = conn.Close()
	return nil
}

// ─── 接管闸:把出口探测接到 InjectSelected 上 ────────────────────────────────

// egressGateMarker:错误前缀,让前端识别这是「出口未通过」、弹专门的强提示框(开 TUN 引导),
// 而不是泛化的「操作失败」。前端会剥掉本前缀再展示。
const egressGateMarker = "EGRESS_BLOCKED:"

// egressInfoForTakeover 取目标产品当前账号的出口策略(proxyUrl + egressRequired)。
// 走各自 leaser 的 LeaseToken(force=false,复用缓存):这是控制面请求(走 bcai.space),
// 即使账号出口代理被 ban 也能拿到 —— 我们正是要先拿到 proxyUrl 才能去探它。
func egressInfoForTakeover(product string, cfg Config) (EgressInfo, error) {
	card, dev, up := cfg.AccountCard, cfg.DeviceId, cfg.UpstreamProxy
	switch product {
	case "anthropic":
		lease, err := GetClaudeLeaser().LeaseToken(card, dev, false, nil, up)
		if err != nil {
			return EgressInfo{}, err
		}
		return lease.EgressInfo, nil
	case "codex":
		lease, err := GetCodexLeaser().LeaseToken(card, dev, false, nil, up)
		if err != nil {
			return EgressInfo{}, err
		}
		return lease.EgressInfo, nil
	case "antigravity":
		lease, err := GetLeaser().LeaseToken(card, dev, false, nil, up)
		if err != nil {
			return EgressInfo{}, err
		}
		return lease.EgressInfo, nil
	default:
		return EgressInfo{}, nil
	}
}

// enforceEgressGate 是接管的硬前置闸:配了静态出口代理的产品,出口探测必须通过,否则拒绝接管。
// 返回 nil=放行;返回 error=拒绝(带 egressGateMarker)。
//
// 闸判定的依据是【产品】(anthropic/codex/antigravity),与卡的类型无关 —— 池子卡和绑定卡
// 一视同仁:池子卡接管时一样会先租到一个号、拿到【那个号的 proxyUrl】再探,探不通照样拒。
// 不存在「池子卡免检」。
//
// product=="" 只在「接管目标映射不到任何已知产品」时发生(targetRequiredProduct 的 default
// 分支),是防御性兜底,正常流程走不到 —— 真·未知目标早在 findTakeoverTarget 就被过滤掉了。
func enforceEgressGate(product string, cfg Config) error {
	if product == "" {
		return nil
	}
	label := productLabel(product)
	eg, err := egressInfoForTakeover(product, cfg)
	if err != nil {
		return fmt.Errorf("%s接管前置检查:无法获取「%s」账号的出口配置(%v)。为避免暴露真实 IP 被封号,已拒绝接管,请稍后重试。",
			egressGateMarker, label, err)
	}
	proxyURL := strings.TrimSpace(eg.ProxyURL)
	if proxyURL == "" {
		// 没配静态出口代理:required(anthropic)硬拒(否则会从真实 IP 直连官方);optional 放行(本就无静态 IP 可保护)。
		if eg.EgressRequired {
			return fmt.Errorf("%s「%s」账号未下发静态出口代理,无法安全接管 —— 接管后会从你的真实 IP 直连官方,有封号风险。请联系运营在后台为该号配置出口代理。",
				egressGateMarker, label)
		}
		return nil
	}
	exitIP, perr := egressPreflight(proxyURL)
	if perr != nil {
		if errors.Is(perr, errEgressBanned) {
			Log("[egress-gate] %s 出口探测被拒(banned),拦截接管。proxy=%s", product, proxyURL)
			return fmt.Errorf("%s接管已拦截:你的网络出口是大陆 IP、被账号代理拒绝(banned)。\n\n请先在 Clash / Mihomo 里开启【TUN 模式(建议全局)】,让流量从境外节点出去,再重新接管。\n否则你的真实 IP 会暴露给官方,有封号风险。",
				egressGateMarker)
		}
		Log("[egress-gate] %s 出口探测失败,拦截接管:%v。proxy=%s", product, perr, proxyURL)
		return fmt.Errorf("%s接管已拦截:账号出口代理连不通(%v)。\n\n为避免从你的真实 IP 直连官方被封号,未通过出口检查就不允许接管。请检查网络 / 开启 TUN 后重试。",
			egressGateMarker, perr)
	}
	Log("[egress-gate] %s 出口探测通过,代理出口 IP=%s", product, exitIP)
	// anthropic 额外做一次【真实目标】可达性探测:ipify 通不代表 anthropic 通(节点可能对 anthropic
	// 定向拦截/污染)。走和真实请求相同的出口路径裸 CONNECT,失败就拒绝接管、提示换节点。
	if product == "anthropic" {
		if aerr := egressAnthropicReachable(proxyURL); aerr != nil {
			Log("[egress-gate] %s 到 api.anthropic.com 的 CONNECT 探测失败,拦截接管:%v。proxy=%s", product, aerr, proxyURL)
			return fmt.Errorf("%s接管已拦截:出口能上网,但连不到 api.anthropic.com(%v)。\n\n多半是当前代理节点对 anthropic 做了拦截/污染,请按顺序排查:\n1. 确认 Clash 已开启 TUN 模式(建议全局);\n2. 换一个干净的境外节点(日本/新加坡等)后重试。\n\n实在没有可用节点,可自购:https://xn--cp3a08l.com/#/plan(不赚钱、无广告)。",
				egressGateMarker, aerr)
		}
		Log("[egress-gate] %s 到 api.anthropic.com 的 CONNECT 探测通过", product)
	}
	return nil
}
