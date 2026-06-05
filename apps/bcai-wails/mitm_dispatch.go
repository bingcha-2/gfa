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
// 只拦 api.anthropic.com（Code/Cowork 的推理/鉴权端点都在此）；其余透传。
func mitmShouldIntercept(host string) bool {
	return mitmHostOnly(host) == "api.anthropic.com"
}

// mitmRouter 是被拦截连接(api.anthropic.com)上每条解密请求的分派器：
//   - /v1/messages*      → claudeHandler（复用 ClaudeProxy 换号池 token + 计费）
//   - 鉴权端点(且开启mock) → mockHandler（伪造已登录 pro，给未登录用户）
//   - 其余                → forwardHandler（透传真实上游，沿用用户自己的登录态）
//
// mockHandler 为 nil 时，鉴权端点也走 forwardHandler（默认：登录用户保持真实身份）。
func mitmRouter(claudeHandler, mockHandler, forwardHandler http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isClaudeAPIRequest(r.URL.Path) {
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
