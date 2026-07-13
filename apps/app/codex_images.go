package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/tidwall/sjson"
)

// isOpenAIImageRequest 判断是否是 OpenAI 图像接口(generations / edits / variations)。
func isOpenAIImageRequest(path string) bool {
	switch strings.ToLower(path) {
	case "/v1/images/generations", "/v1/images/edits", "/v1/images/variations":
		return true
	default:
		return false
	}
}

// ServeImages 处理 OpenAI 图像接口(/v1/images/generations)。
//
// chatgpt.com 的 codex 后端【没有】REST 图像端点(实测 uTLS 真号只回网页 HTML),Codex 的
// 生图技能调的又正是这个 REST 接口。所以正确做法不是傻转发,也不是往正常请求里注入(那会打断
// 聊天),而是把图像请求【翻译】成 /backend-api/codex/responses + 内联 image_generation 工具
// (那个能出图),读流拿到生成的 base64 图,再翻回图像接口 JSON 返回。
//
// 关键安全性:此翻译【只作用于 /v1/images/*】——这些请求 100% 是画图请求,绝不碰正常
// /v1/responses 生成请求,因此不可能打断正常聊天。出口沿用 doUpstreamWithFallback(账号住宅
// 代理 → 本地直连回落),绝不经本地网关出口。对齐 cockpit codex_openai_images.go。
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
	// 目前只翻译 generations(edits/variations 带图片文件,后续按需扩)。
	if !strings.HasSuffix(strings.ToLower(r.URL.Path), "/generations") {
		p.sendJSONError(w, http.StatusNotImplemented, "only /v1/images/generations is supported")
		return
	}

	rawReq, err := io.ReadAll(r.Body)
	if err != nil {
		audit.note = "读请求体失败:" + err.Error()
		p.sendJSONError(w, http.StatusBadRequest, "failed to read request body")
		return
	}
	GetUsageStats().AddRequest()

	// 翻译:/v1/images/generations → codex responses body(内联生图工具 + tool_choice)。
	respBody := buildCodexImagesResponsesBody(rawReq)
	audit.reqBody = respBody
	// 日志/计量按【真正画图的模型】(gpt-image-2),而非触发工具的主持人模型 gpt-5.4-mini。
	imageModel := codexResolveImageModel(rawReq)
	audit.model = imageModel

	leaseFunc := p.leaseToken
	if leaseFunc == nil {
		leaseFunc = GetCodexLeaser().LeaseToken
	}
	lease, err := leaseFunc(card, deviceId, false, map[string]interface{}{"modelKey": codexImagesMainModel, "bodyBytes": len(respBody)}, upstreamProxy)
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

	base := p.upstreamBase
	if base == "" {
		base = DefaultCodexEndpoint
	}
	targetURL := strings.TrimRight(base, "/") + "/backend-api/codex/responses"
	audit.target = targetURL
	req, err := http.NewRequest(http.MethodPost, targetURL, bytes.NewReader(respBody))
	if err != nil {
		p.sendJSONError(w, http.StatusInternalServerError, "failed to build upstream request")
		return
	}
	copyCodexHeaders(req.Header, r.Header)
	req.Header.Set("Authorization", "Bearer "+lease.AccessToken)
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Content-Type", "application/json")
	applyCodexOfficialHeaders(req.Header, r.Header)
	if accountID := extractChatGPTAccountId(lease.AccessToken); accountID != "" {
		req.Header.Set("ChatGPT-Account-Id", accountID)
	} else {
		req.Header.Del("ChatGPT-Account-Id")
	}

	resp, err := doUpstreamWithFallback(lease.EgressInfo, upstreamProxy, respBody, req, createCodexStreamingHttpClient)
	if err != nil {
		atomic.AddInt64(&p.totalErrors, 1)
		audit.status = http.StatusBadGateway
		audit.note = "上游请求失败:" + err.Error()
		p.sendJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer resp.Body.Close()
	audit.status = resp.StatusCode

	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		atomic.AddInt64(&p.totalErrors, 1)
		audit.respBody = data
		// 原样把上游错误回给客户端(JSON)。
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(data)
		return
	}

	images, completed := scanCodexImageStream(data)

	// 计量:从 completed 事件折算(含 tool_usage.image_gen 生图 token),经租约上报。
	if len(completed) > 0 {
		details := codexReportDetails(resp.StatusCode, imageModel, completed)
		audit.inTokens, audit.outTokens = details.InputTokens, details.OutputTokens
		if p.reportResult != nil {
			p.reportResult(card, deviceId, details, upstreamProxy, lease)
		} else {
			GetCodexLeaser().ReportUsage(card, deviceId, details, upstreamProxy, lease)
		}
	}

	if len(images) == 0 {
		atomic.AddInt64(&p.totalErrors, 1)
		audit.note = "上游未返回图像输出"
		p.sendJSONError(w, http.StatusBadGateway, "upstream did not return image output")
		return
	}

	// 翻回 OpenAI 图像接口 JSON:{"created":...,"data":[{"b64_json":...,"revised_prompt":...}]}。
	out := []byte(`{"created":0,"data":[]}`)
	out, _ = sjson.SetBytes(out, "created", time.Now().Unix())
	for i, img := range images {
		out, _ = sjson.SetBytes(out, fmt.Sprintf("data.%d.b64_json", i), img.B64)
		if img.RevisedPrompt != "" {
			out, _ = sjson.SetBytes(out, fmt.Sprintf("data.%d.revised_prompt", i), img.RevisedPrompt)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(out)
}
