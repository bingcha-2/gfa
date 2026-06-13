package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ─── 接管前置闸:出口可达性探测(Windows / macOS 共用)──────────────────────────
//
// 背景:配了「每号静态/住宅出口代理」的产品(anthropic 恒 required;codex/antigravity
// 绑了代理也算),接管后的官方流量必须从【代理 IP】出去,绝不能从用户真实(大陆)IP 直连
// —— 否则带账号 token 的请求暴露真实 IP → 反滥用信号 → 封号(见 egress 铁律)。
//
// 现实坑:egress 那一跳是裸 net.Dialer 直连账号代理,不走系统 HTTP 代理(7897);用户没开
// Clash TUN(全局)时,会从真实大陆 IP 裸连代理 → 部分代理直接 403「Mainland China IP banned」。
//
// 判据 = 「经该号的 proxyUrl 能不能裸 CONNECT 上【该产品的官方 host】」:
//   - CONNECT 通       → 真实流量这条路走得通、出口就是代理 IP,放行接管;
//   - CONNECT 403/ban  → 代理按来源 IP 拒了你 → 拒绝接管,提示开 TUN;
//   - 连不上 / 超时     → 代理被墙或挂了 → 拒绝接管(fail-closed:没通过不准接管)。
//
// 为什么探官方 host、而不是 GET 第三方回显站(ipify/ifconfig):真实流量就是经这条代理去官方,
// CONNECT 官方才精确回答「能不能从代理出去到官方」;第三方回显站会因自身限流/抖动误判,把本可
// 成功的接管拦掉(这正是之前频繁误拦的根因)。CONNECT 全程不带 token、建通即关,零封号风险。
//
// 容错:失败重试到 egressProbeAttempts 次;http(s) 代理先试 SOCKS5 再回落原协议(部分住宅代理
// 实际走 socks5),探通后把可用协议写入 scheme 缓存,供真实出口路径(resolveEgressProxyURL)复用。

// errEgressBanned:代理在入口按来源 IP 拒绝(403 / banned),通常是没开 TUN、真实大陆 IP 裸连。
var errEgressBanned = errors.New("出口代理拒绝来源 IP(banned)")

// egressProbeTimeout:单次出口可达性探测(CONNECT)的超时。设大一点更宽容,容住宅代理的高时延。
const egressProbeTimeout = 12 * time.Second

// egressProbeAttempts:出口可达性探测的最大尝试次数。代理/网络偶发抖动是常态,一次没过就拦太脆
// —— 失败重试,任一次通过即放行,显著减少误拦。
const egressProbeAttempts = 3

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

// classifyEgressError 把一次代理探测的传输层错误归类:像「按来源 IP 封禁(403/banned)」→
// errEgressBanned;其它原样返回(连不通/超时)。前缀由上层用户文案统一负责,这里不再包装。
func classifyEgressError(err error) error {
	if err == nil {
		return nil
	}
	if looksBanned(err.Error()) {
		return errEgressBanned
	}
	return err
}

// productProbeTarget 返回各产品出口可达性探测的目标 host:port(真实流量要去的官方)。
// 返回 "" 表示未知产品(不探)。
func productProbeTarget(product string) string {
	switch product {
	case "anthropic":
		return "api.anthropic.com:443"
	case "codex":
		return "chatgpt.com:443"
	case "antigravity":
		return "cloudcode-pa.googleapis.com:443"
	default:
		return ""
	}
}

// dialProbeOnce 经代理对 target 建一次裸 CONNECT,建通即关(不带 token、不发请求,零封号风险)。
func dialProbeOnce(target, proxyURL string) error {
	ctx, cancel := context.WithTimeout(context.Background(), egressProbeTimeout)
	defer cancel()
	conn, err := dialRawThroughProxy(ctx, target, proxyURL)
	if err != nil {
		return err
	}
	_ = conn.Close()
	return nil
}

// egressReachable 经账号代理对 target(官方 host:port)做裸 CONNECT 可达性探测,带重试与协议回落。
// 返回 nil=可达(放行);errEgressBanned=被代理按来源 IP 拒(需开 TUN);其它=连不通/超时。
func egressReachable(target, proxyURL string) error {
	scheme, u, perr := parseEgressProxy(proxyURL)
	if perr != nil || scheme == "" {
		return fmt.Errorf("无效的账号出口代理地址: %v", perr)
	}
	// 候选协议:http(s) 代理先试 SOCKS5 再回落原协议;本就是 socks5 直接用。
	candidates := []string{proxyURL}
	if scheme == "http" || scheme == "https" {
		socksURL := "socks5://"
		if u.User != nil {
			socksURL += u.User.String() + "@"
		}
		socksURL += u.Host
		candidates = []string{socksURL, proxyURL}
	}

	var lastErr error
	for attempt := 1; attempt <= egressProbeAttempts; attempt++ {
		for _, cand := range candidates {
			err := dialProbeOnce(target, cand)
			if err == nil {
				// 记下能用的协议,供真实出口路径(resolveEgressProxyURL)复用,省去再探。
				if cScheme, cu, e := parseEgressProxy(cand); e == nil && cu != nil {
					setProxySchemeCache(cu.Host, cScheme)
				}
				return nil
			}
			// 「被按来源 IP 拒(403/banned)」是确定性结论:换协议/重试都一样,立即返回。
			if cerr := classifyEgressError(err); errors.Is(cerr, errEgressBanned) {
				return errEgressBanned
			}
			lastErr = err
		}
		Log("[egress-gate] 出口可达性探测第 %d/%d 次未通过(target=%s, proxy=%s):%v",
			attempt, egressProbeAttempts, target, maskProxyURL(proxyURL), lastErr)
	}
	if lastErr == nil {
		lastErr = errors.New("出口可达性探测失败")
	}
	return lastErr
}

// ─── 接管闸:把出口探测接到 InjectSelected 上 ────────────────────────────────

// egressGateMarker:错误前缀,让前端识别这是「出口未通过」、弹专门的强提示框(开 TUN 引导),
// 而不是泛化的「操作失败」。前端会剥掉本前缀再展示。
const egressGateMarker = "EGRESS_BLOCKED:"

// egressInfoForTakeover 取目标产品当前账号的出口策略(proxyUrl + egressRequired)。
// 走各自 leaser 的 LeaseToken(force=false,复用缓存):这是控制面请求(走 bcai.space),
// 即使账号出口代理被 ban 也能拿到 —— 我们正是要先拿到 proxyUrl 才能去探它。
func egressInfoForTakeover(product string, cfg Config) (EgressInfo, error) {
	card, dev, up := cfg.AccountCard, cfg.DeviceId, ""
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

// enforceEgressGate 是接管的硬前置闸:配了静态出口代理的产品,出口可达性探测必须通过,否则拒绝接管。
// 返回 nil=放行;返回 error=拒绝(带 egressGateMarker)。
//
// 闸判定的依据是【产品】(anthropic/codex/antigravity),与卡的类型无关 —— 池子卡和绑定卡
// 一视同仁:池子卡接管时一样会先租到一个号、拿到【那个号的 proxyUrl】再探,探不通照样拒。
//
// product=="" 只在「接管目标映射不到任何已知产品」时发生(防御性兜底,正常流程走不到)。
func enforceEgressGate(product string, cfg Config) error {
	if product == "" {
		return nil
	}
	Log("[egress-gate] 开始执行出口闸检查: product=%s, card=%s", product, cfg.AccountCard)
	label := productLabel(product)
	eg, err := egressInfoForTakeover(product, cfg)
	if err != nil {
		return fmt.Errorf("%s接管前置检查:无法获取「%s」账号的出口配置(%v)。为避免暴露真实 IP 被封号,已拒绝接管,请稍后重试。",
			egressGateMarker, label, err)
	}
	proxyURL := strings.TrimSpace(eg.ProxyURL)
	if proxyURL == "" {
		// 没下发静态出口代理:required(anthropic 恒 required)硬拒(否则会从真实 IP 直连官方);
		// optional(codex/antigravity 没绑代理)放行 —— 本就无静态 IP 可保护,不必探。
		if eg.EgressRequired {
			return fmt.Errorf("%s「%s」账号未下发静态出口代理,无法安全接管 —— 接管后会从你的真实 IP 直连官方,有封号风险。请联系运营在后台为该号配置出口代理。",
				egressGateMarker, label)
		}
		Log("[egress-gate] %s 无出口代理且非 required,放行(不探)。", product)
		return nil
	}

	// 有静态代理:判据 = 经这条代理能不能 CONNECT 上该产品官方。真实流量就走这条路。
	target := productProbeTarget(product)
	if target == "" {
		Log("[egress-gate] %s 无已知探测目标,放行(防御兜底)。", product)
		return nil
	}
	Log("[egress-gate] %s 出口可达性探测开始 target=%s, proxy=%s", product, target, maskProxyURL(proxyURL))
	if rerr := egressReachable(target, proxyURL); rerr != nil {
		if errors.Is(rerr, errEgressBanned) {
			Log("[egress-gate] %s 出口被拒(banned),拦截接管。proxy=%s", product, maskProxyURL(proxyURL))
			return fmt.Errorf("%s接管已拦截:你的网络出口是大陆 IP、被账号代理拒绝(banned)。\n\n请先在 Clash / Mihomo 里开启【TUN 模式(建议全局)】,让流量从境外节点出去,再重新接管。\n否则你的真实 IP 会暴露给官方,有封号风险。",
				egressGateMarker)
		}
		Log("[egress-gate] %s 出口可达性探测失败,拦截接管:%v。proxy=%s", product, rerr, maskProxyURL(proxyURL))
		return fmt.Errorf("%s接管已拦截:经账号代理连不到 %s(%v)。\n\n请按顺序排查:\n1. 确认 Clash 已开启 TUN 模式(建议全局);\n2. 换一个干净的境外节点(日本/新加坡等)后重试。\n\n若换了节点仍连不上,可能是当前机场已被列入黑名单,需自行更换机场。",
			egressGateMarker, strings.TrimSuffix(target, ":443"), rerr)
	}
	Log("[egress-gate] %s 出口可达性探测通过,放行接管。proxy=%s", product, maskProxyURL(proxyURL))
	return nil
}
