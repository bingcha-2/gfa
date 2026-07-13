package main

import (
	"net/http"
	"strings"
	"sync/atomic"
)

// isOpenAIImageRequest 判断是否是 OpenAI 图像接口(generations / edits / variations)。
// 和 /v1/responses、/v1/models 一样注入租号 OAuth 令牌后发到 chatgpt.com(原样 /v1/images/* 路径),
// 而非被 antigravity 兜底瞎发到 Google。
func isOpenAIImageRequest(path string) bool {
	switch strings.ToLower(path) {
	case "/v1/images/generations", "/v1/images/edits", "/v1/images/variations":
		return true
	default:
		return false
	}
}


// ServeImages 处理 OpenAI 图像接口,与 /v1/responses、/v1/models 同一套出口逻辑:
// 租号 → 注入 OAuth 令牌 + ChatGPT 身份头 → 原样 /v1/images/* 路径 → 走账号绑定出口
// 发到 chatgpt.com,后端返回什么就回什么(不预判、不拦截)。
//
// 与 /v1/responses 生成路径的差异(有意做纯透传):图像请求体可能是 multipart/form-data
// (edits/variations 带图片文件),故不改写请求体、不强设 JSON Content-Type;响应不解析
// SSE/usage,直接流式回写。copyCodexHeaders 原样保留 Content-Type/boundary 并剥离出口敏感头
// (含 x-oai-attestation)。出口沿用 doUpstreamWithFallback(账号住宅代理 → 本地直连回落),
// 绝不经本地网关出口。
func (p *CodexProxy) ServeImages(w http.ResponseWriter, r *http.Request, card, deviceId, upstreamProxy string) {
	reqID := atomic.AddInt64(&p.totalRequests, 1)
	audit := newProxyAudit("codex", reqID, "图像", r.Method, r.URL.Path)
	defer audit.emit()

	// chatgpt.com 的 codex 后端没有 /v1/images/* REST 端点:实测(uTLS 真号)只回一坨网页
	// HTML(HTTP 200),根本不出图。以前原样透传 → 客户端拿到 HTML 被误导为“成功”。
	// 生图已改由 /v1/responses 内联注入 hosted image_generation 工具实现(见 codex_imagegen.go),
	// 故这里明确回 404,不再把 HTML 当图像响应回给客户端。
	audit.status = http.StatusNotFound
	audit.note = "图像 REST 端点不支持(生图改走 responses 内联工具)"
	p.sendJSONError(w, http.StatusNotFound, "image endpoint not supported; images are generated inline via /v1/responses")
}
