package main

import (
	"net/http"
	"strings"
	"sync"
)

// ─── 凭证感知出口决策(出口铁律的结构化保证)──────────────────────────────────
//
// 两条铁律:
//   ① 带「我们号池 token」的请求 → 必走该号绑定的静态 IP;无代理则 fail-closed 拒连,
//      绝不回落到本机直连/用户代理(否则号池 token 在静态 IP 与本机 IP 间跳变 → 风控)。
//   ② 带「用户自己凭证」(自己的 OAuth token / cookie)的请求 → 一律走用户网络,
//      绝不碰静态 IP(否则用户账号被关联到号池出口 IP)。
//
// 判据是「这个 token 是不是我们发的」,而不是 path / handler —— 因为同一组 api.anthropic.com
// 端点上,号池 token 与用户自己的 token 是混着来的(付费用户、OAuth 接管生效前)。按 path 决定
// 出口必然误伤其中一类。号池 token 我们认得出(LeaseToken 下发时登记),认得出的才走静态 IP,
// 其余一律当用户的、走用户网络。
//
// 用在 forward / entitlement 这些「明文、看得到 Authorization」的出网点;passthrough(隧道、
// 看不到凭证)不可能是号池 token(号池 token 只走被解密的 api.anthropic.com),固定走用户网络。

// poolTokenRegistry 登记我们下发过的号池 token → 其绑定的静态出口代理 URL。
// 保留多个(FIFO 上限)以覆盖 token 轮换窗口与多卡并发,避免「旧 token 在途请求被误判成用户的」。
type poolTokenRegistry struct {
	mu    sync.RWMutex
	proxy map[string]string // accessToken → proxyURL("" = 该号未下发代理)
	order []string          // FIFO,超上限淘汰最老的
}

const poolTokenRegistryMax = 64

var globalPoolTokens = &poolTokenRegistry{proxy: map[string]string{}}

// registerPoolToken 在 LeaseToken 成功下发号池 token 时调用,登记 token→静态代理。幂等。
func registerPoolToken(accessToken, proxyURL string) {
	accessToken = strings.TrimSpace(accessToken)
	if accessToken == "" {
		return
	}
	r := globalPoolTokens
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.proxy[accessToken]; !ok {
		r.order = append(r.order, accessToken)
		for len(r.order) > poolTokenRegistryMax {
			delete(r.proxy, r.order[0])
			r.order = r.order[1:]
		}
	}
	r.proxy[accessToken] = proxyURL
}

// lookupPoolToken 判断 token 是不是我们发的号池 token。是 → 返回其静态代理(可能为 "")。
func lookupPoolToken(accessToken string) (proxyURL string, isPool bool) {
	accessToken = strings.TrimSpace(accessToken)
	if accessToken == "" {
		return "", false
	}
	r := globalPoolTokens
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.proxy[accessToken]
	return p, ok
}

// bearerToken 取 "Authorization: Bearer xxx" 里的 xxx;非 Bearer / 空 → ""。大小写不敏感。
func bearerToken(authHeader string) string {
	v := strings.TrimSpace(authHeader)
	if len(v) >= 7 && strings.EqualFold(v[:7], "Bearer ") {
		return strings.TrimSpace(v[7:])
	}
	return ""
}

// resolveCredentialEgress 按请求凭证决定出口代理(纯函数,便于单测):
//   号池 token            → (该号静态代理, blocked=该号无代理, isPool=true)  —— 铁律①
//   非号池(用户凭证/无)  → (userProxy,    false,             isPool=false) —— 铁律②
// blocked=true 表示号池 token 却无静态 IP,调用方必须拒连,绝不回落直连。
func resolveCredentialEgress(authHeader, userProxy string) (proxy string, blocked, isPool bool) {
	if p, ok := lookupPoolToken(bearerToken(authHeader)); ok {
		if strings.TrimSpace(p) == "" {
			return "", true, true // 号池 token 无静态 IP → fail-closed
		}
		return p, false, true
	}
	return userProxy, false, false
}

// credentialAwareTransport 是按请求凭证选出口的 RoundTripper,用于 forward / entitlement。
// userProxyFn 实时取用户网络(m.upstream → 系统代理);transportFor 按 proxy 复用底层出口 transport。
type credentialAwareTransport struct {
	userProxyFn func() string

	mu    sync.Mutex
	cache map[string]http.RoundTripper // proxyURL → 出口 transport(复用连接池)
}

func newCredentialAwareTransport(userProxyFn func() string) *credentialAwareTransport {
	return &credentialAwareTransport{userProxyFn: userProxyFn, cache: map[string]http.RoundTripper{}}
}

func (t *credentialAwareTransport) transportFor(proxy string) http.RoundTripper {
	t.mu.Lock()
	defer t.mu.Unlock()
	if rt, ok := t.cache[proxy]; ok {
		return rt
	}
	rt := newClaudeUpstreamTransport(proxy) // utls 指纹 + 经 proxy 出站;proxy="" 即直连
	t.cache[proxy] = rt
	return rt
}

func (t *credentialAwareTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	userProxy := ""
	if t.userProxyFn != nil {
		userProxy = t.userProxyFn()
	}
	proxy, blocked, _ := resolveCredentialEgress(req.Header.Get("Authorization"), userProxy)
	if blocked {
		// 号池 token 但该号无静态出口 → 拒连,绝不从本机/用户 IP 漏号池 token 出去。
		return nil, errEgressRequired
	}
	return t.transportFor(proxy).RoundTrip(req)
}
