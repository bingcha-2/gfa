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
func mitmClaudeAiHandler(transport http.RoundTripper) http.Handler {
	target, _ := url.Parse(claudeAiBase)
	if transport == nil {
		transport = newClaudeUpstreamTransport("") // utls 指纹绕 Cloudflare
	}
	return &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			Log("[mitm-claudeai] → 转发 %s %s", req.Method, req.URL.Path)
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host
			req.Host = target.Host
			req.Header.Del("Accept-Encoding") // 要明文才好改写
		},
		Transport:      transport,
		ModifyResponse: mitmModifyClaudeAiResponse,
	}
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
			Log("[mitm-claudeai] ✏ 改写 current_user_access:Code/Cowork → available")
		}
	case strings.HasSuffix(path, "/cowork_settings"):
		if patched, ok := patchJSON(body, patchCoworkSettings); ok {
			newBody = patched
			Log("[mitm-claudeai] ✏ 改写 cowork_settings:enabled → true")
		}
	case isClaudeAiOrgRootPath(path) || strings.HasSuffix(path, "/app_start"):
		// org 根 / bootstrap:把 capabilities/rate_limit_tier/billing_type 升级成 Max(UI 付费墙主信号)。
		if patched, ok := patchJSON(body, patchSubscriptionTree); ok {
			newBody = patched
			Log("[mitm-claudeai] ✏ 改写 %s:订阅信号 → claude_max", path)
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
