package main

import (
	"net/http"
	"strings"
)

// ─── Claude 桌面端 Code/Cowork 接管：MITM 请求分派 ───────────────────────────
//
// 桌面端在 spawn Code/Cowork 子进程时硬覆盖 ANTHROPIC_BASE_URL=api.anthropic.com，
// 无视 ~/.claude/settings.json，因此 env 注入接管对它无效，只能在网络层 MITM。
// 本文件负责「拦哪些域名 / 哪些端点 mock / 哪些透传」的纯决策逻辑。

// mitmHostOnly 去掉 host 里的 :port。
func mitmHostOnly(host string) string {
	if i := strings.IndexByte(host, ':'); i >= 0 {
		return host[:i]
	}
	return host
}

// mitmShouldIntercept 判断某域名是否需要 MITM 解密。
//   - api.anthropic.com：Code/Cowork 推理 + oauth authorize。
//   - claude.ai：仅为改写「Code 资格判定端点」(current_user_access / cowork_settings)。
//
// ⚠ claude.ai 一律【字节级原样透传】,只对上述极少数判定端点重写;绝不碰会话/bootstrap/login,
// 否则触发 account_session_invalid(claude.ai 对会话有完整性校验)。见 mitmModifyClaudeAiResponse。
func mitmShouldIntercept(host string) bool {
	h := mitmHostOnly(host)
	return h == "api.anthropic.com" || h == "claude.ai"
}

// mitmRouter 是被拦截连接(api.anthropic.com)上每条解密请求的分派器：
//   - /v1/messages*      → claudeHandler（复用 ClaudeProxy 换号池 token + 计费）
//   - 鉴权端点(mock 开启时) → mockHandler（伪造已登录 pro，给未登录用户；默认开，对齐 reclaude）
//   - 其余                → forwardHandler（透传真实上游，沿用用户自己的登录态）
//
// mockHandler 为 nil 时，鉴权端点也走 forwardHandler（关掉 mock 时保留用户真实身份）。
// mitmShouldPoolAuthorize 判断是否把请求走 ClaudeProxy(换号池 Pro token)。
// 收窄到【只匹配 .../authorize】—— Code/Cowork 的付费闸是 POST /v1/oauth/{org}/authorize,
// 用免费号 token 调它会 403「requires Pro or Max」,改用号池 Pro token 授权即放行。
//
// ⚠ 绝不能用 /v1/oauth/ 整个前缀:那会把 Desktop 自身的【会话 token 交换】(如 .../token)
// 也劫持成号池 token → claude.ai 判会话非法 → account_session_invalid、踢回登录页(已踩坑)。
func mitmShouldPoolAuthorize(path string) bool {
	return strings.HasPrefix(path, "/v1/oauth/") && strings.HasSuffix(path, "/authorize")
}

func mitmRouter(claudeHandler, mockHandler, forwardHandler http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isClaudeAPIRequest(r.URL.Path) || mitmShouldPoolAuthorize(r.URL.Path) {
			claudeHandler.ServeHTTP(w, r)
			return
		}
		if mockHandler != nil && mitmShouldMock(r.URL.Path) {
			mockHandler.ServeHTTP(w, r)
			return
		}
		forwardHandler.ServeHTTP(w, r)
	})
}
