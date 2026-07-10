package main

import (
	"bytes"
	"fmt"
	"io"
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

// imageTargetURL 把图像请求发到 chatgpt.com 的**原样路径**:/v1/images/edits 直接透传,
// 不加 /backend-api/codex/ 前缀(图像接口就挂在 /v1/images/* 上,不走 codex 后端命名空间)。
func (p *CodexProxy) imageTargetURL(r *http.Request) string {
	base := p.upstreamBase
	if base == "" {
		base = DefaultCodexEndpoint
	}
	target := strings.TrimRight(base, "/") + r.URL.Path
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	return target
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

	if r.Method != http.MethodPost {
		p.sendJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if card == "" {
		// 与生成路径一致:绝不回 401(codex 客户端收到 401 会触发重新登录),用 503 让其稍后重试。
		p.sendJSONError(w, http.StatusServiceUnavailable, "Codex account card is not configured")
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		audit.note = "读请求体失败:" + err.Error()
		p.sendJSONError(w, http.StatusBadRequest, "failed to read request body")
		return
	}
	audit.reqBody = body
	GetUsageStats().AddRequest()

	leaseFunc := p.leaseToken
	if leaseFunc == nil {
		leaseFunc = GetCodexLeaser().LeaseToken
	}
	lease, err := leaseFunc(card, deviceId, false, map[string]interface{}{"bodyBytes": len(body)}, upstreamProxy)
	if err != nil {
		atomic.AddInt64(&p.totalErrors, 1)
		audit.note = "lease 失败:" + err.Error()
		if writeQuotaExhausted(w, err) {
			return
		}
		p.sendJSONError(w, http.StatusBadGateway, fmt.Sprintf("Codex token lease failed: %v", err))
		return
	}
	audit.accountID = lease.AccountId
	audit.token = lease.AccessToken

	targetURL := p.imageTargetURL(r)
	audit.target = targetURL
	req, err := http.NewRequest(r.Method, targetURL, bytes.NewReader(body))
	if err != nil {
		p.sendJSONError(w, http.StatusInternalServerError, "failed to build upstream request")
		return
	}
	copyCodexHeaders(req.Header, r.Header)
	req.Header.Set("Authorization", "Bearer "+lease.AccessToken)
	req.Header.Set("Host", mustParseURL(targetURL).Host)
	applyCodexOfficialHeaders(req.Header, r.Header)
	if accountID := extractChatGPTAccountId(lease.AccessToken); accountID != "" {
		req.Header.Set("ChatGPT-Account-Id", accountID)
	} else {
		req.Header.Del("ChatGPT-Account-Id")
	}

	resp, err := doUpstreamWithFallback(lease.EgressInfo, upstreamProxy, body, req, createCodexStreamingHttpClient)
	if err != nil {
		atomic.AddInt64(&p.totalErrors, 1)
		audit.status = http.StatusBadGateway
		audit.note = "上游请求失败:" + err.Error()
		p.sendJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer resp.Body.Close()
	audit.status = resp.StatusCode

	for key, values := range resp.Header {
		if isHopByHopHeader(key) {
			continue
		}
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}
