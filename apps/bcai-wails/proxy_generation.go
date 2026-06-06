package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"
)

func (p *ProxyServer) handleGenerationRequest(w http.ResponseWriter, r *http.Request, body []byte, card, deviceId string, upstream string, reqId int64) {

	// 一次代理只出一条日志:全程累积到 audit,defer 时统一输出(含元信息+完整正文+打码token)。
	audit := newProxyAudit("antigravity", reqId, "生成", r.Method, r.URL.Path)
	defer audit.emit()
	audit.reqBody = body

	// 1. Validate: either card (remote) or pool accounts (local) required
	if card == "" {
		audit.note = "未配置账号卡"
		p.sendJsonError(w, 503, "BingchaAI: Please configure and activate your account card first.")
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		return
	}

	// 2. Fail-closed check: JSON body must contain project or projectId field
	var parsedBody interface{}
	if err := json.Unmarshal(body, &parsedBody); err != nil {
		audit.note = "请求体非法 JSON"
		p.sendJsonError(w, 400, "Invalid JSON body")
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		return
	}

	hasProject := hasProjectField(parsedBody)

	// P0: Extract model key from request body (e.g. "gemini-2.5-pro")
	requestModelKey := extractModelKeyFromBody(body)
	audit.model = requestModelKey

	// 按模型选上游:Claude/GPT 第三方模型走 daily-cloudcode-pa,Gemini 走 cloudcode-pa。
	targetUrl, _ := url.Parse(cloudCodeEndpointForModel(requestModelKey) + r.URL.Path + "?" + r.URL.RawQuery)
	audit.target = targetUrl.Host + targetUrl.Path
	// 生成请求使用无全局超时的 streaming client，避免 120s 截断长响应
	client := createStreamingHttpClient(upstream)

	var resp *http.Response
	var lease *TokenLease
	attemptSessionId := fmt.Sprintf("%d-%d", time.Now().UnixMilli(), reqId)

	// ====== REMOTE LEASE MODE (original) ======
	leaser := GetLeaser()
	// 本地额度检查
	if ok, waitMs, reason := leaser.CheckLocalQuota(requestModelKey); !ok {
		audit.note += "; 本地额度不足:" + reason
		w.Header().Set("Retry-After", fmt.Sprintf("%d", waitMs/1000))
		p.sendJsonError(w, 429, fmt.Sprintf("BingchaAI: %s", reason))
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		return
	}
	// P1④: Dynamic max attempts — start with default, update from server retryPolicy
	remoteMaxAttempts := MaxCloudCodeGenerationAttempts
	accumulatedCapacityWaitMs := int64(0)
	const maxCapacityWaitMs = int64(60000) // P2⑩: Max 60s total capacity wait
	// 记录本次请求中已失败的 accountId，防止 report-result 还没到服务端时又租到同一个号
	var excludeAccountIds []int
	for attempt := 1; attempt <= remoteMaxAttempts; attempt++ {
		var err error
		leaseOptions := map[string]interface{}{
			"attemptSessionId": attemptSessionId,
			"modelKey":         requestModelKey,
		}
		if len(excludeAccountIds) > 0 {
			leaseOptions["excludeAccountIds"] = excludeAccountIds
		}
		lease, err = leaser.LeaseToken(card, deviceId, attempt > 1, leaseOptions, upstream)
		if err != nil {
			audit.note += fmt.Sprintf("; 租号失败:%v", err)
			p.sendJsonError(w, 503, fmt.Sprintf("租号服务暂时不可用，请稍后重试: %v", err))
			atomic.AddInt64(&p.stats.TotalErrors, 1)
			return
		}
		// P1④: Update maxAttempts from server retryPolicy
		if lease.RetryPolicy != nil && lease.RetryPolicy.MaxAttempts > 0 {
			remoteMaxAttempts = lease.RetryPolicy.MaxAttempts
			if remoteMaxAttempts > 99 {
				remoteMaxAttempts = 99
			}
		}
		audit.accountID = lease.AccountId
		audit.token = lease.AccessToken

		rewrittenBody, _ := rewriteProjectFields(parsedBody, lease.ProjectId)
		// 生成请求必须有 project 字段，没有则注入
		if !hasProject {
			if bodyMap, ok := rewrittenBody.(map[string]interface{}); ok {
				bodyMap["project"] = lease.ProjectId
				rewrittenBody = bodyMap
			}
		}
		// 注入 enabledCreditTypes: GOOGLE_ONE_AI（默认消耗积分，与 token-proxy.js 行为一致）
		if bodyMap, ok := rewrittenBody.(map[string]interface{}); ok {
			credits, _ := bodyMap["enabledCreditTypes"].([]interface{})
			hasGoogleOneAI := false
			for _, c := range credits {
				if s, ok := c.(string); ok && s == "GOOGLE_ONE_AI" {
					hasGoogleOneAI = true
					break
				}
			}
			if !hasGoogleOneAI {
				bodyMap["enabledCreditTypes"] = append(credits, "GOOGLE_ONE_AI")
				rewrittenBody = bodyMap
			}
		}
		newBodyBytes, err := json.Marshal(rewrittenBody)
		if err != nil {
			audit.note += fmt.Sprintf("; body序列化失败:%v", err)
			p.sendJsonError(w, 500, "Internal rewrite error")
			atomic.AddInt64(&p.stats.TotalErrors, 1)
			return
		}

		req, err := http.NewRequest(r.Method, targetUrl.String(), bytes.NewReader(newBodyBytes))
		if err != nil {
			audit.note += fmt.Sprintf("; 构造请求失败:%v", err)
			p.sendJsonError(w, 500, "Internal request creation error")
			atomic.AddInt64(&p.stats.TotalErrors, 1)
			return
		}

		// Copy headers and inject the leased bearer token
		for k, v := range r.Header {
			lower := strings.ToLower(k)
			if lower == "authorization" ||
				lower == "host" ||
				lower == "content-length" ||
				lower == "x-goog-api-key" ||
				lower == "x-goog-user-project" {
				continue
			}
			for _, val := range v {
				req.Header.Add(k, val)
			}
		}
		req.Header.Set("Authorization", "Bearer "+lease.AccessToken)
		req.Header.Set("Host", targetUrl.Host)
		req.Header.Set("Content-Length", fmt.Sprintf("%d", len(newBodyBytes)))

		resp, err = client.Do(req)
		if err != nil {
			audit.note += fmt.Sprintf("; 上游请求失败:%v", err)
			p.sendJsonError(w, 502, fmt.Sprintf("Upstream gateway error: %v", err))
			atomic.AddInt64(&p.stats.TotalErrors, 1)
			return
		}

		problemReason := ""
		errorBody := ""
		if resp.StatusCode == http.StatusUnauthorized ||
			resp.StatusCode == http.StatusTooManyRequests ||
			resp.StatusCode == http.StatusForbidden ||
			resp.StatusCode == http.StatusServiceUnavailable ||
			resp.StatusCode == http.StatusInternalServerError ||
			resp.StatusCode == http.StatusBadRequest {
			respBytes := readAndResetResponseBody(resp)
			errorBody = string(respBytes)
			problemReason = cloudCodeAccountProblemReason(resp.StatusCode, errorBody)
		}
		if problemReason == "" {
			break
		}

		// P0: Parse retryAfterMs from 429 error body
		retryAfterMs := extractQuotaResetDelayMs(errorBody)
		// P0: Extract model from error response (503 capacity errors contain model name)
		errorModelKey := extractCapacityModelKey(errorBody)
		if errorModelKey == "" {
			errorModelKey = requestModelKey
		}

		// P0: Build enriched report details
		reportDetails := ReportDetails{
			StatusCode:   resp.StatusCode,
			ModelKey:     errorModelKey,
			Reason:       problemReason,
			RetryAfterMs: retryAfterMs,
			ErrorText:    errorBody,
		}

		// P2⑪: Verification challenge → report + rotate to another account
		// (mirrors token-proxy.js L1812-L1822: shouldRetryRemoteError → continue)
		if resp.StatusCode == http.StatusForbidden && isVerificationChallengeError(errorBody) {
			audit.note += fmt.Sprintf("; 验证挑战#%d(%d/%d)", lease.AccountId, attempt, remoteMaxAttempts)
			leaser.ReportProblemWithDetails(card, deviceId, reportDetails, upstream, lease)
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			resp = nil
			// 绑定卡:没有别的号可换 —— 验证挑战只能由账号所有者去 Google 完成验证。
			// 把上游 403 原文(含 "Verify your account" + validation_url)原样回给 IDE,
			// 触发 Antigravity 自带的验证流程,而不是吞成"繁忙"误导用户。
			if lease.Bound {
				audit.status = http.StatusForbidden
				audit.note += "; 绑定卡透传验证详情"
				p.passthroughUpstreamError(w, http.StatusForbidden, errorBody)
				atomic.AddInt64(&p.stats.TotalErrors, 1)
				return
			}
			excludeAccountIds = append(excludeAccountIds, lease.AccountId)
			if attempt < remoteMaxAttempts {
				atomic.AddInt64(&p.stats.TotalRetries, 1)
				GetUsageStats().AddRetry()
				time.Sleep(remoteRetryDelayForStatus(attempt, http.StatusForbidden))
				continue
			}
			// 池子模式所有号都撞验证 → 也把真实详情透传,而不是含糊的 503。
			audit.status = http.StatusForbidden
			audit.note += "; 全部撞验证→透传"
			p.passthroughUpstreamError(w, http.StatusForbidden, errorBody)
			atomic.AddInt64(&p.stats.TotalErrors, 1)
			return
		}

		// P1④: Check if this status is retryable per server retryPolicy
		// #5: Use statusMaxAttempts to expand retry limit for specific status codes
		effectiveMaxAttempts := remoteMaxAttempts
		if lease.RetryPolicy != nil && lease.RetryPolicy.StatusMaxAttempts != nil {
			if statusLimit, ok := lease.RetryPolicy.StatusMaxAttempts[resp.StatusCode]; ok && statusLimit > effectiveMaxAttempts {
				effectiveMaxAttempts = statusLimit
				if effectiveMaxAttempts > 99 {
					effectiveMaxAttempts = 99
				}
			}
		}
		// 绑定卡没有别的号可换 → 禁掉"换到别的号"的轮转。同一个号的瞬时错误等待重试
		// (上面的 503 容量 / 短 429 路径)不受影响,绑定卡仍会适当重试。
		canRetry := attempt < effectiveMaxAttempts && !lease.Bound
		if lease.RetryPolicy != nil && len(lease.RetryPolicy.RetryableStatuses) > 0 {
			statusRetryable := false
			for _, s := range lease.RetryPolicy.RetryableStatuses {
				if s == resp.StatusCode {
					statusRetryable = true
					break
				}
			}
			if !statusRetryable {
				canRetry = false
			}
		}

		// #3: Short rate-limit (<5s RATE_LIMIT_EXCEEDED) — wait and retry SAME account
		// (mirrors token-proxy.js L1744-L1752)
		if resp.StatusCode == http.StatusTooManyRequests &&
			retryAfterMs > 0 && retryAfterMs < 5000 &&
			strings.Contains(errorBody, "RATE_LIMIT_EXCEEDED") &&
			attempt < effectiveMaxAttempts+2 {
			waitMs := retryAfterMs + 500
			audit.note += fmt.Sprintf("; 短429等待%dms重试#%d", waitMs, lease.AccountId)
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			resp = nil
			time.Sleep(time.Duration(waitMs) * time.Millisecond)
			// Don't add to excludeAccountIds — retry same account
			continue
		}

		// P2⑩: 503 capacity wait — wait and retry instead of immediate rotate
		if resp.StatusCode == http.StatusServiceUnavailable &&
			strings.Contains(strings.ToLower(errorBody), "capacity") &&
			accumulatedCapacityWaitMs < maxCapacityWaitMs {
			waitMs := int64(5000) // default 5s
			if retryAfterMs > 0 && retryAfterMs < 30000 {
				waitMs = retryAfterMs
			}
			accumulatedCapacityWaitMs += waitMs
			audit.note += fmt.Sprintf("; 503容量等待%dms(累计%dms)", waitMs, accumulatedCapacityWaitMs)
			leaser.ReportProblemWithDetails(card, deviceId, reportDetails, upstream, lease)
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			resp = nil
			time.Sleep(time.Duration(waitMs) * time.Millisecond)
			continue
		}

		if canRetry {
			respStatus := resp.StatusCode
			audit.note += fmt.Sprintf("; 轮换#%d(%d %s)", lease.AccountId, respStatus, problemReason)
			leaser.ReportProblemWithDetails(card, deviceId, reportDetails, upstream, lease)
			// 将失败的 accountId 加入排除列表，防止异步 report 还没到时又租到同一个号
			excludeAccountIds = append(excludeAccountIds, lease.AccountId)
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			resp = nil
			atomic.AddInt64(&p.stats.TotalRetries, 1)
			GetUsageStats().AddRetry()
			// P1: Exponential backoff between retries
			time.Sleep(remoteRetryDelayForStatus(attempt, respStatus))
			continue
		}

		audit.note += fmt.Sprintf("; 终止%d(%d %s)", attempt, resp.StatusCode, problemReason)
		leaser.ReportProblemWithDetails(card, deviceId, reportDetails, upstream, lease)
		break
	}
	if resp == nil {
		audit.note += "; 重试后无响应"
		p.sendJsonError(w, 502, "Upstream gateway error: no response after retries")
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		return
	}
	defer resp.Body.Close()
	audit.status = resp.StatusCode

	// [P3 TIMO-STYLE] 首 chunk 缓冲：在 WriteHeader 之前先读第一个 chunk
	// 如果第一个 chunk 就是 quota/capacity 错误（Google 返回 200 但 body 是错误），
	// 此时还没有向 IDE 发送任何数据，可以换号重试
	isStreaming := strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") ||
		strings.Contains(r.URL.Path, "streamGenerateContent")
	var firstChunk []byte
	if isStreaming {
		buf := make([]byte, 8192) // 读大一点以覆盖完整的错误 JSON
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			firstChunk = make([]byte, n)
			copy(firstChunk, buf[:n])
			if reason, mk, retryMs := checkStreamingQuotaError(string(firstChunk)); reason != "" {
				// 首 chunk 就是错误！关闭连接，上报，不向 IDE 发送任何数据
				audit.note += fmt.Sprintf("; 首chunk错误(%s model=%s retry=%dms)", reason, mk, retryMs)
				audit.respBody = firstChunk
				_ = resp.Body.Close()
				// 上报错误
				if lease != nil {
					statusCode := 429
					if reason == "capacity" {
						statusCode = 503
					}
					GetLeaser().ReportProblemWithDetails(card, deviceId, ReportDetails{
						StatusCode: statusCode, ModelKey: mk, Reason: reason, RetryAfterMs: retryMs,
					}, upstream, lease)
				}
				// 返回结构化错误给 IDE（此时还能设置正确的 status code）
				p.sendJsonError(w, 429, fmt.Sprintf("Account quota exhausted (%s), please retry", reason))
				atomic.AddInt64(&p.stats.TotalErrors, 1)
				return
			}
		}
		if readErr != nil && readErr != io.EOF {
			audit.note += fmt.Sprintf("; 首chunk读错误:%v", readErr)
		}
	}

	// 首 chunk 正常 → 提交 HTTP 响应头（此后不可逆）
	w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(resp.StatusCode)

	// 设置当前模型 key（streaming 时使用）
	p.mu.Lock()
	p.lastModelKey = requestModelKey
	p.mu.Unlock()

	var tokenResult TokenUsageResult
	if isStreaming {
		// 把流式响应同时 tee 到审计缓冲(保留 flush,不破坏流式),供这条日志输出完整响应体。
		tee := newAuditTee(w)
		// 先写出已缓冲的首 chunk
		if len(firstChunk) > 0 {
			_, _ = tee.Write(firstChunk)
			tee.Flush()
		}
		// Streaming response: parse remaining chunks on the fly
		tokenResult = p.streamResponse(tee, resp.Body, reqId)
		audit.respBody = tee.captured()
		// 将首 chunk 的 bytes 也计入 token 解析
		if len(firstChunk) > 0 {
			tokenResult.StreamBytes += int64(len(firstChunk))
		}
	} else {
		// Single response: read all and parse
		respBytes, err := io.ReadAll(resp.Body)
		if err == nil {
			_, _ = w.Write(respBytes)
			audit.respBody = respBytes
			tokenResult = p.parseAndAddTokenUsage(respBytes, resp.Header.Get("Content-Encoding"), requestModelKey)
		}
	}
	audit.inTokens, audit.outTokens = tokenResult.InputTokens, tokenResult.OutputTokens

	// [TIMO-STYLE] 流式中途 quota 错误：上报 + 标记账号
	if tokenResult.StreamError {
		audit.note += fmt.Sprintf("; 流中途quota(%s model=%s)", tokenResult.StreamErrorReason, tokenResult.StreamErrorModel)
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		GetUsageStats().AddError()
		if lease != nil {
			leaser := GetLeaser()
			statusCode := 429
			if tokenResult.StreamErrorReason == "capacity" {
				statusCode = 503
			}
			leaser.ReportProblemWithDetails(card, deviceId, ReportDetails{
				StatusCode:   statusCode,
				ModelKey:     tokenResult.StreamErrorModel,
				Reason:       tokenResult.StreamErrorReason,
				RetryAfterMs: tokenResult.StreamRetryAfterMs,
			}, upstream, lease)
		}
		return
	}

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		atomic.AddInt64(&p.stats.TotalSuccessfulGenerations, 1)
		GetUsageStats().AddGeneration()
		// 上报成功请求的 token 用量到服务器，不释放 lease（保持账号粘性）
		if lease != nil {
			leaser := GetLeaser()
			// 本地记账
			if tokenResult.BillableTotalTokens > 0 {
				leaser.RecordLocalUsage(requestModelKey, int64(tokenResult.BillableTotalTokens))
			}
			leaser.ReportUsage(card, deviceId, ReportDetails{
				StatusCode:          resp.StatusCode,
				ModelKey:            requestModelKey,
				InputTokens:         tokenResult.InputTokens,
				OutputTokens:        tokenResult.OutputTokens,
				CachedInputTokens:   tokenResult.CachedInputTokens,
				RawTotalTokens:      tokenResult.RawTotalTokens,
				BillableTotalTokens: tokenResult.BillableTotalTokens,
			}, upstream, lease)
			// 影子校验通道
			if tokenResult.RawTotalTokens > 0 {
				go leaser.syncMetrics(card, lease,
					tokenResult.InputTokens, tokenResult.OutputTokens,
					tokenResult.CachedInputTokens, tokenResult.RawTotalTokens,
					tokenResult.StreamBytes, requestModelKey, upstream)
			}
		}
	} else {
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		GetUsageStats().AddError()
	}
}

func (p *ProxyServer) handleGeminiGenerationRequest(w http.ResponseWriter, r *http.Request, body []byte, card, deviceId string, upstream string, reqId int64) {

	// 一次代理只出一条日志:全程累积到 audit,defer 时统一输出(含元信息+完整正文+打码token)。
	audit := newProxyAudit("antigravity", reqId, "Gemini", r.Method, r.URL.Path)
	defer audit.emit()
	audit.reqBody = body

	// 提取模型 key（Gemini API 路径包含模型名）
	requestModelKey := extractModelKeyFromPath(r.URL.Path)
	if requestModelKey == "" {
		requestModelKey = extractModelKeyFromBody(body)
	}
	audit.model = requestModelKey

	if card == "" {
		audit.note = "未配置账号卡"
		p.sendJsonError(w, 503, "BingchaAI: Please configure and activate your account card first.")
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		return
	}

	targetUrl, _ := url.Parse(DefaultGeminiEndpoint + r.URL.Path + "?" + r.URL.RawQuery)
	audit.target = targetUrl.Host + targetUrl.Path
	query := targetUrl.Query()
	if _, ok := query["key"]; ok {
		query.Del("key")
		targetUrl.RawQuery = query.Encode()
	}
	client := createStreamingHttpClient(upstream)
	attemptSessionId := fmt.Sprintf("%d-%d", time.Now().UnixMilli(), reqId)

	var resp *http.Response
	var lease *TokenLease

	// ====== REMOTE LEASE MODE with retry (aligned with Cloud Code path) ======
	leaser := GetLeaser()
	// 本地额度检查
	if ok, waitMs, reason := leaser.CheckLocalQuota(requestModelKey); !ok {
		audit.note += "; 本地额度不足:" + reason
		w.Header().Set("Retry-After", fmt.Sprintf("%d", waitMs/1000))
		p.sendJsonError(w, 429, fmt.Sprintf("BingchaAI: %s", reason))
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		return
	}
	remoteMaxAttempts := MaxCloudCodeGenerationAttempts
	accumulatedCapacityWaitMs := int64(0)
	const maxCapacityWaitMs = int64(60000)
	var excludeAccountIds []int

	for attempt := 1; attempt <= remoteMaxAttempts; attempt++ {
		leaseOptions := map[string]interface{}{
			"attemptSessionId": attemptSessionId,
			"modelKey":         requestModelKey,
		}
		if len(excludeAccountIds) > 0 {
			leaseOptions["excludeAccountIds"] = excludeAccountIds
		}
		var err error
		lease, err = leaser.LeaseToken(card, deviceId, attempt > 1, leaseOptions, upstream)
		if err != nil {
			audit.note += fmt.Sprintf("; 租号失败:%v", err)
			p.sendJsonError(w, 503, fmt.Sprintf("租号服务暂时不可用，请稍后重试: %v", err))
			atomic.AddInt64(&p.stats.TotalErrors, 1)
			return
		}
		if lease.RetryPolicy != nil && lease.RetryPolicy.MaxAttempts > 0 {
			remoteMaxAttempts = lease.RetryPolicy.MaxAttempts
			if remoteMaxAttempts > 99 {
				remoteMaxAttempts = 99
			}
		}
		audit.accountID = lease.AccountId
		audit.token = lease.AccessToken

		req, err := http.NewRequest(r.Method, targetUrl.String(), bytes.NewReader(body))
		if err != nil {
			audit.note += fmt.Sprintf("; 构造请求失败:%v", err)
			p.sendJsonError(w, 500, "Internal request creation error")
			atomic.AddInt64(&p.stats.TotalErrors, 1)
			return
		}
		for k, v := range r.Header {
			lower := strings.ToLower(k)
			if lower == "authorization" || lower == "host" || lower == "content-length" ||
				lower == "x-goog-api-key" || lower == "x-goog-user-project" {
				continue
			}
			for _, val := range v {
				req.Header.Add(k, val)
			}
		}
		req.Header.Set("Authorization", "Bearer "+lease.AccessToken)
		if lease.ProjectId != "" {
			req.Header.Set("X-Goog-User-Project", lease.ProjectId)
		}
		req.Header.Set("Host", targetUrl.Host)
		req.Header.Set("Content-Length", fmt.Sprintf("%d", len(body)))

		resp, err = client.Do(req)
		if err != nil {
			audit.note += fmt.Sprintf("; 上游请求失败:%v", err)
			p.sendJsonError(w, 502, fmt.Sprintf("Upstream gateway error: %v", err))
			atomic.AddInt64(&p.stats.TotalErrors, 1)
			return
		}

		problemReason := ""
		errorBody := ""
		if resp.StatusCode == http.StatusUnauthorized ||
			resp.StatusCode == http.StatusTooManyRequests ||
			resp.StatusCode == http.StatusForbidden ||
			resp.StatusCode == http.StatusServiceUnavailable ||
			resp.StatusCode == http.StatusInternalServerError ||
			resp.StatusCode == http.StatusBadRequest {
			respBytes := readAndResetResponseBody(resp)
			errorBody = string(respBytes)
			problemReason = cloudCodeAccountProblemReason(resp.StatusCode, errorBody)
		}
		if problemReason == "" {
			break
		}

		retryAfterMs := extractQuotaResetDelayMs(errorBody)
		errorModelKey := extractCapacityModelKey(errorBody)
		if errorModelKey == "" {
			errorModelKey = requestModelKey
		}
		reportDetails := ReportDetails{
			StatusCode:   resp.StatusCode,
			ModelKey:     errorModelKey,
			Reason:       problemReason,
			RetryAfterMs: retryAfterMs,
			ErrorText:    errorBody,
		}

		// Verification challenge → report + rotate to another account
		if resp.StatusCode == http.StatusForbidden && isVerificationChallengeError(errorBody) {
			audit.note += fmt.Sprintf("; 验证挑战#%d(%d/%d)", lease.AccountId, attempt, remoteMaxAttempts)
			leaser.ReportProblemWithDetails(card, deviceId, reportDetails, upstream, lease)
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			resp = nil
			// 绑定卡:无备号 → 透传 Google 验证详情(含 validation_url)给 IDE,触发其验证流程。
			if lease.Bound {
				audit.status = http.StatusForbidden
				audit.note += "; 绑定卡透传验证详情"
				p.passthroughUpstreamError(w, http.StatusForbidden, errorBody)
				atomic.AddInt64(&p.stats.TotalErrors, 1)
				return
			}
			excludeAccountIds = append(excludeAccountIds, lease.AccountId)
			if attempt < remoteMaxAttempts {
				atomic.AddInt64(&p.stats.TotalRetries, 1)
				GetUsageStats().AddRetry()
				time.Sleep(remoteRetryDelayForStatus(attempt, http.StatusForbidden))
				continue
			}
			audit.status = http.StatusForbidden
			audit.note += "; 全部撞验证→透传"
			p.passthroughUpstreamError(w, http.StatusForbidden, errorBody)
			atomic.AddInt64(&p.stats.TotalErrors, 1)
			return
		}

		// Check retryability from server policy
		// #5: Use statusMaxAttempts to expand retry limit for specific status codes
		effectiveMaxAttempts := remoteMaxAttempts
		if lease.RetryPolicy != nil && lease.RetryPolicy.StatusMaxAttempts != nil {
			if statusLimit, ok := lease.RetryPolicy.StatusMaxAttempts[resp.StatusCode]; ok && statusLimit > effectiveMaxAttempts {
				effectiveMaxAttempts = statusLimit
				if effectiveMaxAttempts > 99 {
					effectiveMaxAttempts = 99
				}
			}
		}
		// 绑定卡没有别的号可换 → 禁掉"换到别的号"的轮转。同一个号的瞬时错误等待重试
		// (上面的 503 容量 / 短 429 路径)不受影响,绑定卡仍会适当重试。
		canRetry := attempt < effectiveMaxAttempts && !lease.Bound
		if lease.RetryPolicy != nil && len(lease.RetryPolicy.RetryableStatuses) > 0 {
			statusRetryable := false
			for _, s := range lease.RetryPolicy.RetryableStatuses {
				if s == resp.StatusCode {
					statusRetryable = true
					break
				}
			}
			if !statusRetryable {
				canRetry = false
			}
		}

		// #3: Short rate-limit (<5s RATE_LIMIT_EXCEEDED) — wait and retry SAME account
		if resp.StatusCode == http.StatusTooManyRequests &&
			retryAfterMs > 0 && retryAfterMs < 5000 &&
			strings.Contains(errorBody, "RATE_LIMIT_EXCEEDED") &&
			attempt < effectiveMaxAttempts+2 {
			waitMs := retryAfterMs + 500
			audit.note += fmt.Sprintf("; 短429等待%dms重试#%d", waitMs, lease.AccountId)
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			resp = nil
			time.Sleep(time.Duration(waitMs) * time.Millisecond)
			continue
		}

		// 503 capacity wait — wait and retry instead of immediate rotate
		if resp.StatusCode == http.StatusServiceUnavailable &&
			strings.Contains(strings.ToLower(errorBody), "capacity") &&
			accumulatedCapacityWaitMs < maxCapacityWaitMs {
			waitMs := int64(5000)
			if retryAfterMs > 0 && retryAfterMs < 30000 {
				waitMs = retryAfterMs
			}
			accumulatedCapacityWaitMs += waitMs
			audit.note += fmt.Sprintf("; 503容量等待%dms(累计%dms)", waitMs, accumulatedCapacityWaitMs)
			leaser.ReportProblemWithDetails(card, deviceId, reportDetails, upstream, lease)
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			resp = nil
			time.Sleep(time.Duration(waitMs) * time.Millisecond)
			continue
		}

		if canRetry {
			respStatus := resp.StatusCode
			audit.note += fmt.Sprintf("; 轮换#%d(%d %s)", lease.AccountId, respStatus, problemReason)
			leaser.ReportProblemWithDetails(card, deviceId, reportDetails, upstream, lease)
			excludeAccountIds = append(excludeAccountIds, lease.AccountId)
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			resp = nil
			atomic.AddInt64(&p.stats.TotalRetries, 1)
			GetUsageStats().AddRetry()
			time.Sleep(remoteRetryDelayForStatus(attempt, respStatus))
			continue
		}

		audit.note += fmt.Sprintf("; 终止%d(%d %s)", attempt, resp.StatusCode, problemReason)
		leaser.ReportProblemWithDetails(card, deviceId, reportDetails, upstream, lease)
		break
	}

	if resp == nil {
		audit.note += "; 重试后无响应"
		p.sendJsonError(w, 502, "Upstream gateway error: no response after retries")
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		return
	}
	defer resp.Body.Close()
	audit.status = resp.StatusCode

	// [P3 TIMO-STYLE] 首 chunk 缓冲：在 WriteHeader 之前先读第一个 chunk
	isStreaming := strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") ||
		strings.Contains(strings.ToLower(r.URL.Path), "streamgeneratecontent")
	var firstChunk []byte
	if isStreaming {
		buf := make([]byte, 8192)
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			firstChunk = make([]byte, n)
			copy(firstChunk, buf[:n])
			if reason, mk, retryMs := checkStreamingQuotaError(string(firstChunk)); reason != "" {
				audit.note += fmt.Sprintf("; 首chunk错误(%s model=%s retry=%dms)", reason, mk, retryMs)
				audit.respBody = firstChunk
				_ = resp.Body.Close()
				if lease != nil {
					statusCode := 429
					if reason == "capacity" {
						statusCode = 503
					}
					GetLeaser().ReportProblemWithDetails(card, deviceId, ReportDetails{
						StatusCode: statusCode, ModelKey: mk, Reason: reason, RetryAfterMs: retryMs,
					}, upstream, lease)
				}
				p.sendJsonError(w, 429, fmt.Sprintf("Account quota exhausted (%s), please retry", reason))
				atomic.AddInt64(&p.stats.TotalErrors, 1)
				return
			}
		}
		if readErr != nil && readErr != io.EOF {
			audit.note += fmt.Sprintf("; 首chunk读错误:%v", readErr)
		}
	}

	w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(resp.StatusCode)

	p.mu.Lock()
	p.lastModelKey = requestModelKey
	p.mu.Unlock()

	var tokenResult TokenUsageResult
	if isStreaming {
		// 把流式响应同时 tee 到审计缓冲(保留 flush,不破坏流式),供这条日志输出完整响应体。
		tee := newAuditTee(w)
		if len(firstChunk) > 0 {
			_, _ = tee.Write(firstChunk)
			tee.Flush()
		}
		tokenResult = p.streamResponse(tee, resp.Body, reqId)
		audit.respBody = tee.captured()
		if len(firstChunk) > 0 {
			tokenResult.StreamBytes += int64(len(firstChunk))
		}
	} else {
		respBytes, err := io.ReadAll(resp.Body)
		if err == nil {
			_, _ = w.Write(respBytes)
			audit.respBody = respBytes
			tokenResult = p.parseAndAddTokenUsage(respBytes, resp.Header.Get("Content-Encoding"), requestModelKey)
		}
	}
	audit.inTokens, audit.outTokens = tokenResult.InputTokens, tokenResult.OutputTokens

	// [TIMO-STYLE] 流式中途 quota 错误：上报 + 标记账号
	if tokenResult.StreamError {
		audit.note += fmt.Sprintf("; 流中途quota(%s model=%s)", tokenResult.StreamErrorReason, tokenResult.StreamErrorModel)
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		GetUsageStats().AddError()
		if lease != nil {
			leaser := GetLeaser()
			statusCode := 429
			if tokenResult.StreamErrorReason == "capacity" {
				statusCode = 503
			}
			leaser.ReportProblemWithDetails(card, deviceId, ReportDetails{
				StatusCode:   statusCode,
				ModelKey:     tokenResult.StreamErrorModel,
				Reason:       tokenResult.StreamErrorReason,
				RetryAfterMs: tokenResult.StreamRetryAfterMs,
			}, upstream, lease)
		}
		return
	}

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		atomic.AddInt64(&p.stats.TotalSuccessfulGenerations, 1)
		GetUsageStats().AddGeneration()
		// 上报成功请求的 token 用量到服务器，不释放 lease（保持账号粘性）
		if lease != nil {
			leaser := GetLeaser()
			// 本地记账
			if tokenResult.BillableTotalTokens > 0 {
				leaser.RecordLocalUsage(requestModelKey, int64(tokenResult.BillableTotalTokens))
			}
			leaser.ReportUsage(card, deviceId, ReportDetails{
				StatusCode:          resp.StatusCode,
				ModelKey:            requestModelKey,
				InputTokens:         tokenResult.InputTokens,
				OutputTokens:        tokenResult.OutputTokens,
				CachedInputTokens:   tokenResult.CachedInputTokens,
				RawTotalTokens:      tokenResult.RawTotalTokens,
				BillableTotalTokens: tokenResult.BillableTotalTokens,
			}, upstream, lease)
			// 影子校验通道
			if tokenResult.RawTotalTokens > 0 {
				go leaser.syncMetrics(card, lease,
					tokenResult.InputTokens, tokenResult.OutputTokens,
					tokenResult.CachedInputTokens, tokenResult.RawTotalTokens,
					tokenResult.StreamBytes, requestModelKey, upstream)
			}
		}
	} else {
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		GetUsageStats().AddError()
	}
}
