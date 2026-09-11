package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

const (
	codexMaxImageUploadBytes  int64 = 64 * 1024 * 1024
	codexMaxImageRequestBytes int64 = 256 * 1024 * 1024
	codexMultipartMemoryBytes int64 = 32 * 1024 * 1024
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

// buildCodexImageEditRequest 把 OpenAI edits 的 multipart/JSON 输入转换成 hosted
// image_generation edit 请求。Codex 内置 image_gen 使用的是 multipart/form-data；JSON
// 形式也保留给兼容客户端使用。
func buildCodexImageEditRequest(w http.ResponseWriter, r *http.Request) ([]byte, string, error) {
	contentType := strings.TrimSpace(r.Header.Get("Content-Type"))
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return nil, "", fmt.Errorf("invalid Content-Type: %w", err)
	}

	switch strings.ToLower(mediaType) {
	case "multipart/form-data":
		r.Body = http.MaxBytesReader(w, r.Body, codexMaxImageRequestBytes)
		if err := r.ParseMultipartForm(codexMultipartMemoryBytes); err != nil {
			return nil, "", fmt.Errorf("invalid multipart image edit request: %w", err)
		}
		if r.MultipartForm != nil {
			defer r.MultipartForm.RemoveAll()
		}

		prompt := strings.TrimSpace(r.FormValue("prompt"))
		if prompt == "" {
			return nil, "", fmt.Errorf("prompt is required")
		}
		payload := map[string]interface{}{"prompt": prompt}
		for _, field := range []string{"model", "size", "quality", "background", "output_format", "moderation", "input_fidelity"} {
			if value := strings.TrimSpace(r.FormValue(field)); value != "" {
				payload[field] = value
			}
		}
		for _, field := range []string{"output_compression", "partial_images"} {
			if value := strings.TrimSpace(r.FormValue(field)); value != "" {
				n, err := strconv.ParseInt(value, 10, 64)
				if err != nil {
					return nil, "", fmt.Errorf("%s must be an integer", field)
				}
				payload[field] = n
			}
		}

		files := append([]*multipart.FileHeader(nil), r.MultipartForm.File["image[]"]...)
		files = append(files, r.MultipartForm.File["image"]...)
		if len(files) == 0 {
			return nil, "", fmt.Errorf("image is required")
		}
		images := make([]string, 0, len(files))
		for _, file := range files {
			dataURL, err := codexMultipartImageDataURL(file)
			if err != nil {
				return nil, "", err
			}
			images = append(images, dataURL)
		}

		var mask string
		if masks := r.MultipartForm.File["mask"]; len(masks) > 0 {
			mask, err = codexMultipartImageDataURL(masks[0])
			if err != nil {
				return nil, "", err
			}
		}
		rawJSON, err := json.Marshal(payload)
		if err != nil {
			return nil, "", err
		}
		return buildCodexImagesResponsesBodyWithInputs(rawJSON, "edit", images, mask), codexResolveImageModel(rawJSON), nil

	case "application/json":
		rawJSON, err := io.ReadAll(io.LimitReader(r.Body, codexMaxImageRequestBytes+1))
		if err != nil {
			return nil, "", err
		}
		if int64(len(rawJSON)) > codexMaxImageRequestBytes {
			return nil, "", fmt.Errorf("image edit request exceeds %d bytes", codexMaxImageRequestBytes)
		}
		if !json.Valid(rawJSON) {
			return nil, "", fmt.Errorf("body must be valid JSON")
		}
		prompt := strings.TrimSpace(gjson.GetBytes(rawJSON, "prompt").String())
		if prompt == "" {
			return nil, "", fmt.Errorf("prompt is required")
		}
		images := codexJSONImageURLs(rawJSON)
		if len(images) == 0 {
			return nil, "", fmt.Errorf("image or images[].image_url is required")
		}
		mask := strings.TrimSpace(gjson.GetBytes(rawJSON, "mask.image_url").String())
		return buildCodexImagesResponsesBodyWithInputs(rawJSON, "edit", images, mask), codexResolveImageModel(rawJSON), nil

	default:
		return nil, "", fmt.Errorf("unsupported Content-Type %q", contentType)
	}
}

func codexJSONImageURLs(rawJSON []byte) []string {
	var images []string
	if image := strings.TrimSpace(gjson.GetBytes(rawJSON, "image").String()); image != "" {
		images = append(images, image)
	}
	gjson.GetBytes(rawJSON, "images").ForEach(func(_, value gjson.Result) bool {
		var image string
		if value.Type == gjson.String {
			image = value.String()
		} else {
			image = value.Get("image_url").String()
		}
		if image = strings.TrimSpace(image); image != "" {
			images = append(images, image)
		}
		return true
	})
	return images
}

// codexDirectImageModelName returns the canonical model name accepted by the
// native Codex image endpoint. Provider-qualified names such as
// "codex/gpt-image-2" are accepted from clients but must be unqualified
// upstream.
func codexDirectImageModelName(rawJSON []byte) string {
	model := strings.ToLower(strings.TrimSpace(gjson.GetBytes(rawJSON, "model").String()))
	if idx := strings.LastIndex(model, "/"); idx >= 0 && idx < len(model)-1 {
		model = strings.TrimSpace(model[idx+1:])
	}
	switch model {
	case "gpt-image-1.5", "gpt-image-2":
		return model
	default:
		return ""
	}
}

func codexDirectImageModel(rawJSON []byte) bool {
	return codexDirectImageModelName(rawJSON) != ""
}

func codexMultipartImageDataURL(fileHeader *multipart.FileHeader) (string, error) {
	if fileHeader == nil {
		return "", fmt.Errorf("image upload is nil")
	}
	if fileHeader.Size > codexMaxImageUploadBytes {
		return "", fmt.Errorf("image upload exceeds %d bytes", codexMaxImageUploadBytes)
	}
	file, err := fileHeader.Open()
	if err != nil {
		return "", err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, codexMaxImageUploadBytes+1))
	if err != nil {
		return "", err
	}
	if int64(len(data)) > codexMaxImageUploadBytes {
		return "", fmt.Errorf("image upload exceeds %d bytes", codexMaxImageUploadBytes)
	}
	mediaType := strings.TrimSpace(fileHeader.Header.Get("Content-Type"))
	if mediaType == "" || mediaType == "application/octet-stream" {
		mediaType = http.DetectContentType(data)
	}
	return "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

// ServeImages 处理 OpenAI 图像接口(/v1/images/generations 和 /v1/images/edits)。
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
	var respBody []byte
	var rawGenerationBody []byte
	var directImage bool
	var imageModel string
	path := strings.ToLower(r.URL.Path)
	switch path {
	case "/v1/images/generations":
		rawReq, err := io.ReadAll(r.Body)
		if err != nil {
			audit.note = "读请求体失败:" + err.Error()
			p.sendJSONError(w, http.StatusBadRequest, "failed to read request body")
			return
		}
		rawGenerationBody = rawReq
		// Recent CLIProxyAPI releases use Codex's native REST image endpoint for
		// the built-in image models. Keep the older hosted-tool translation for
		// custom models and requests without an explicit model for compatibility.
		directImage = codexDirectImageModel(rawReq) && p.currentRelay() == nil
		if directImage {
			imageModel = codexDirectImageModelName(rawReq)
			respBody = rewriteCodexModel(rawReq, imageModel)
		} else {
			respBody = buildCodexImagesResponsesBody(rawReq)
			imageModel = codexResolveImageModel(rawReq)
		}
	case "/v1/images/edits":
		var err error
		respBody, imageModel, err = buildCodexImageEditRequest(w, r)
		if err != nil {
			audit.note = "解析图片编辑请求失败:" + err.Error()
			p.sendJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
	case "/v1/images/variations":
		p.sendJSONError(w, http.StatusNotImplemented, "/v1/images/variations is not supported")
		return
	default:
		p.sendJSONError(w, http.StatusNotFound, "image endpoint not found")
		return
	}
	GetUsageStats().AddRequest()

	// 翻译:/v1/images/generations|edits → codex responses body(内联生图工具 + tool_choice)。
	// edit body 内含参考图 base64，不放进审计对象，避免无意义地长期持有大块副本。
	// 日志/计量按【真正画图的模型】(gpt-image-2),而非触发工具的主持人模型 gpt-5.4-mini。
	audit.model = imageModel

	leaseFunc := p.leaseToken
	if leaseFunc == nil {
		leaseFunc = GetCodexLeaser().LeaseToken
	}
	leaseModel := codexImagesMainModel
	if directImage {
		leaseModel = imageModel
	}
	lease, err := leaseFunc(card, deviceId, false, map[string]interface{}{"modelKey": leaseModel, "bodyBytes": len(respBody)}, upstreamProxy)
	if err != nil {
		atomic.AddInt64(&p.totalErrors, 1)
		audit.note = "lease 失败:" + err.Error()
		if writeQuotaExhausted(w, err) {
			return
		}
		p.sendJSONError(w, http.StatusBadGateway, fmt.Sprintf("Codex token lease failed: %v", err))
		return
	}
	relayLease := lease.IsRelay()
	if directImage && relayLease {
		// A relay lease can be selected during a hot config transition even when
		// the earlier relay snapshot was empty. Relay providers speak Responses,
		// so rebuild the hosted-tool payload before applying relay model mapping.
		directImage = false
		respBody = buildCodexImagesResponsesBody(rawGenerationBody)
	}
	if relayLease {
		// 套餐开启中转时没有母号 token。生图与普通 /responses 必须使用同一份
		// 服务端下发的中转 URL/API Key；日志仍保持官方 Codex 的展示口径。
		audit.accountID = 900000001
		audit.token = codexRelayAuditToken
		audit.hideErrorBody = true
		mappedHostModel := mapRelayModel(&CodexRelayConfig{ModelMap: lease.Relay.ModelMap}, codexImagesMainModel)
		if mappedHostModel != codexImagesMainModel {
			respBody = rewriteCodexModel(respBody, mappedHostModel)
		}
	} else {
		audit.accountID = lease.AccountId
		audit.token = lease.AccessToken
	}

	var targetURL string
	if relayLease {
		targetURL = strings.TrimRight(strings.TrimSpace(lease.Relay.BaseURL), "/") + "/responses"
		audit.target = DefaultCodexEndpoint + "/backend-api/codex/responses"
	} else if directImage {
		base := p.upstreamBase
		if base == "" {
			base = DefaultCodexEndpoint
		}
		targetURL = strings.TrimRight(base, "/") + "/backend-api/codex/images/generations"
		audit.target = targetURL
	} else {
		base := p.upstreamBase
		if base == "" {
			base = DefaultCodexEndpoint
		}
		targetURL = strings.TrimRight(base, "/") + "/backend-api/codex/responses"
		audit.target = targetURL
	}
	req, err := http.NewRequest(http.MethodPost, targetURL, bytes.NewReader(respBody))
	if err != nil {
		p.sendJSONError(w, http.StatusInternalServerError, "failed to build upstream request")
		return
	}
	copyCodexHeaders(req.Header, r.Header)
	credential := lease.AccessToken
	if relayLease {
		credential = lease.Relay.APIKey
	}
	req.Header.Set("Authorization", "Bearer "+credential)
	if directImage && !gjson.GetBytes(respBody, "stream").Bool() {
		req.Header.Set("Accept", "application/json")
	} else {
		req.Header.Set("Accept", "text/event-stream")
	}
	req.Header.Set("Content-Type", "application/json")
	if relayLease {
		applyCodexRelayHeaders(req.Header, r.Header)
		req.Header.Del("ChatGPT-Account-Id")
	} else {
		applyCodexOfficialHeaders(req.Header, r.Header)
		if accountID := extractChatGPTAccountId(lease.AccessToken); accountID != "" {
			req.Header.Set("ChatGPT-Account-Id", accountID)
		} else {
			req.Header.Del("ChatGPT-Account-Id")
		}
	}

	var resp *http.Response
	if relayLease {
		resp, err = createCodexStreamingHttpClient("direct").Do(req)
	} else {
		resp, err = doUpstreamWithFallback(lease.EgressInfo, upstreamProxy, respBody, req, createCodexStreamingHttpClient)
	}
	if err != nil {
		atomic.AddInt64(&p.totalErrors, 1)
		audit.status = http.StatusBadGateway
		audit.note = "上游请求失败:" + err.Error()
		p.sendJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer resp.Body.Close()
	audit.status = resp.StatusCode
	if directImage && resp.StatusCode >= 200 && resp.StatusCode < 300 && isCodexStreamingResponse(resp) {
		// Native image streaming responses already use the OpenAI image SSE
		// protocol. Preserve partial-image events instead of buffering the whole
		// generated image before returning it to the client.
		p.writeResponseHeaders(w, resp)
		w.WriteHeader(resp.StatusCode)
		streamBody := decodeCodexResponseStream(resp)
		streamDiagnostic := codexStreamDiagnostic{RequestID: resp.Header.Get("X-Request-Id")}
		actualModel, input, output, cached, total, copyErr := copyStreamingCodexResponse(w, streamBody, &streamDiagnostic)
		if actualModel != "" {
			imageModel = actualModel
		}
		audit.inTokens, audit.outTokens = input, output
		details := codexDetailsFrom(resp.StatusCode, imageModel, input, output, cached, total)
		if copyErr != nil {
			audit.note = streamDiagnostic.summary(copyErr)
			details.StatusCode = http.StatusBadGateway
			details.Reason = "stream_copy_error"
			details.ErrorText = copyErr.Error()
			p.reportProblemSafe(card, deviceId, details, upstreamProxy, lease)
		} else if details.RawTotalTokens > 0 {
			if p.reportResult != nil {
				p.reportResult(card, deviceId, details, upstreamProxy, lease)
			} else {
				GetCodexLeaser().ReportUsage(card, deviceId, details, upstreamProxy, lease)
			}
		}
		return
	}

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
	if directImage {
		// Native image endpoints already return the OpenAI response shape (JSON
		// for non-streaming calls, SSE for streaming calls). Do not run the
		// hosted-tool extractor against that response or it will look like a
		// successful request with no image and incorrectly return 502.
		details := codexReportDetails(resp.StatusCode, imageModel, data)
		audit.inTokens, audit.outTokens = details.InputTokens, details.OutputTokens
		if details.RawTotalTokens > 0 {
			if p.reportResult != nil {
				p.reportResult(card, deviceId, details, upstreamProxy, lease)
			} else {
				GetCodexLeaser().ReportUsage(card, deviceId, details, upstreamProxy, lease)
			}
		}
		p.writeResponseHeaders(w, resp)
		w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
		w.WriteHeader(http.StatusOK)
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
