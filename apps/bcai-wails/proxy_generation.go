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

// shouldRotateOnTransportError 判断:当 client.Do 返回传输层错误(EOF / 连接重置,即
// 根本没拿到任何 HTTP 响应)时,该不该像 429 一样换号重试,而不是一根死连接就整单 502。
// 死的 keep-alive 连接、或上游边缘直接丢 socket,都不该在号池还有没试过的号时打死整个请求。
// 绑定卡没有备号,无法换号。仅在还有 attempt 余量且非绑定卡时才轮换。
func shouldRotateOnTransportError(attempt, maxAttempts int, bound bool) bool {
	return attempt < maxAttempts && !bound
}

// poolExhaustionHint 把"轮换用尽后仍失败"的 problemReason 翻译成给 IDE/用户看的【显眼】
// 中文提示 + 建议的 Retry-After 秒数。否则 IDE 只会收到上游那句没头没脑的英文
// "Resource has been exhausted" 或裸 502。retryAfterSec 给 Retry-After 头,让 IDE 退避而不是
// 立刻重试又烧一轮号池。hinted=false → 没有特别提示,走原样转发上游响应。
func poolExhaustionHint(reason string) (msg string, retryAfterSec int, hinted bool) {
	r := strings.ToLower(reason)
	switch {
	case strings.Contains(r, "credits_balance"): // INSUFFICIENT_G1_CREDITS_BALANCE
		return "Claude 付费信用额度已耗尽(已尝试多个账号均无余额),请稍后重试,或切换到 Gemini 模型继续。", 1800, true
	case strings.Contains(r, "resource_exhausted"),
		strings.Contains(r, "quota"),
		strings.Contains(r, "rate_limit"):
		return "当前模型额度已用尽、号池暂无可用账号,请稍后重试或切换模型。", 600, true
	case strings.Contains(r, "capacity"):
		return "上游容量繁忙,号池暂时排不到空位,请稍后重试。", 60, true
	}
	return "", 0, false
}

// peekEmbeddedStreamError 在 WriteHeader 之前预读 2xx 流式响应的首个 chunk(≤8KB),
// 检测 Google "HTTP 200 + 流体内嵌配额/容量错误"的情况。返回读到的首块(干净则留作
// 转发),以及若是内嵌错误时分类出的 reason/model/retry —— 调用方据此【像 HTTP 错误
// 一样换号】,而不是直接给 IDE 回 429。非流式响应返回空。
func peekEmbeddedStreamError(resp *http.Response, isStreaming bool) (firstChunk []byte, reason, modelKey string, retryAfterMs int64) {
	if !isStreaming {
		return nil, "", "", 0
	}
	buf := make([]byte, 8192)
	n, _ := resp.Body.Read(buf)
	if n > 0 {
		firstChunk = make([]byte, n)
		copy(firstChunk, buf[:n])
		reason, modelKey, retryAfterMs = checkStreamingQuotaError(string(firstChunk))
	}
	return firstChunk, reason, modelKey, retryAfterMs
}

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
	// 生成请求使用无全局超时的 streaming client（避免 120s 截断长响应）。
	// 实际出口在每次 attempt 内按所租账号的绑定代理(egress)构建,见下方 resolveEgress。
	var client *http.Client

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
	remoteMaxAttempts := MaxCloudCodeGenerationAttempts
	accumulatedCapacityWaitMs := int64(0)
	const maxCapacityWaitMs = int64(60000) // P2⑩: Max 60s total capacity wait
	// 记录本次请求中已失败的 accountId，防止 report-result 还没到服务端时又租到同一个号
	var excludeAccountIds []int
	// 首 chunk 在重试循环内预读(用于 200-内嵌错误换号);干净则带出循环供流式转发。
	var firstChunk []byte
	// 轮换用尽时最后一次失败的原因,用于给 IDE 一个【显眼】的中文提示(见 poolExhaustionHint)。
	var lastProblemReason string
	isStreaming := false
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
			// 卡额度用完 → 标准 429 + Retry-After(让 IDE 退避/停),而非 503(会被当临时故障狂试)。
			if writeQuotaExhausted(w, err) {
				atomic.AddInt64(&p.stats.TotalErrors, 1)
				return
			}
			p.sendJsonError(w, 503, fmt.Sprintf("租号服务暂时不可用，请稍后重试: %v", err))
			atomic.AddInt64(&p.stats.TotalErrors, 1)
			return
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

		// 出口:优先走所租账号绑定的住宅代理;没绑定则本地直连(用户代理→系统→直连)。
		egress, _ := resolveEgress(lease.EgressInfo, upstream) // antigravity optional,从不 blocked
		client = createStreamingHttpClient(egress)
		resp, err = client.Do(req)
		if err != nil {
			// optional 策略:绑定代理传输失败 → 降级本地直连重试一次,再不行才 502。
			if strings.TrimSpace(lease.EgressInfo.ProxyURL) != "" && !lease.EgressInfo.EgressRequired {
				audit.note += fmt.Sprintf("; 绑定代理失败降级本地:%v", err)
				retryReq, _ := http.NewRequest(req.Method, req.URL.String(), bytes.NewReader(newBodyBytes))
				retryReq.Header = req.Header.Clone()
				resp, err = createStreamingHttpClient(upstream).Do(retryReq)
			}
			if err != nil {
				audit.note += fmt.Sprintf("; 上游请求失败:%v", err)
				// 传输层错误(EOF/连接重置,根本没拿到 HTTP 响应)= 这个号的连接坏了/上游边缘丢了
				// socket。号池还有没试过的号时,像 429 一样换号,而不是一根死连接就整单 502。
				// 报为瞬时错误(服务端按阈值计数,单次不封号),并排除本号防本请求内又租到它。
				if shouldRotateOnTransportError(attempt, remoteMaxAttempts, lease.Bound) {
					audit.note += fmt.Sprintf("; 传输错误换号#%d", lease.AccountId)
					leaser.ReportProblemWithDetails(card, deviceId, ReportDetails{
						StatusCode: http.StatusBadGateway,
						ModelKey:   requestModelKey,
						Reason:     "transport_error",
						ErrorText:  err.Error(),
					}, upstream, lease)
					excludeAccountIds = append(excludeAccountIds, lease.AccountId)
					atomic.AddInt64(&p.stats.TotalRetries, 1)
					GetUsageStats().AddRetry()
					time.Sleep(remoteRetryDelayForStatus(attempt, http.StatusBadGateway))
					continue
				}
				p.sendJsonError(w, 502, fmt.Sprintf("Upstream gateway error: %v", err))
				atomic.AddInt64(&p.stats.TotalErrors, 1)
				return
			}
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
			// HTTP 2xx。但 Google 有时回 200、把配额/容量错误塞进【首个流 chunk】里。
			// 在循环内预读首块:若是内嵌错误 → 像 HTTP 错误一样换号(而不是循环外直接回
			// 429,那样号池里还有好号用户却失败)。干净则带 firstChunk 出循环转发。
			isStreaming = strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") ||
				strings.Contains(r.URL.Path, "streamGenerateContent")
			fc, emReason, emModel, emRetry := peekEmbeddedStreamError(resp, isStreaming)
			firstChunk = fc
			if emReason != "" {
				if emModel == "" {
					emModel = requestModelKey
				}
				statusForReport := 429
				if emReason == "capacity" {
					statusForReport = 503
				}
				reportDetails := ReportDetails{
					StatusCode: statusForReport, ModelKey: emModel, Reason: emReason,
					RetryAfterMs: emRetry, ErrorText: string(firstChunk),
				}
				leaser.ReportProblemWithDetails(card, deviceId, reportDetails, upstream, lease)
				if attempt < remoteMaxAttempts && !lease.Bound {
					audit.note += fmt.Sprintf("; 200内嵌%s换号#%d", emReason, lease.AccountId)
					excludeAccountIds = append(excludeAccountIds, lease.AccountId)
					_ = resp.Body.Close()
					resp = nil
					firstChunk = nil
					atomic.AddInt64(&p.stats.TotalRetries, 1)
					GetUsageStats().AddRetry()
					time.Sleep(remoteRetryDelayForStatus(attempt, statusForReport))
					continue
				}
				// 绑定卡无备号 / 已试满 → 回配额错误给 IDE(头未提交,可设正确状态码)。
				audit.status = statusForReport
				audit.respBody = firstChunk
				audit.note += fmt.Sprintf("; 200内嵌%s终止#%d", emReason, lease.AccountId)
				_ = resp.Body.Close()
				p.sendJsonError(w, statusForReport, fmt.Sprintf("Account quota exhausted (%s), please retry", emReason))
				atomic.AddInt64(&p.stats.TotalErrors, 1)
				return
			}
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

		effectiveMaxAttempts := remoteMaxAttempts
		// 绑定卡没有别的号可换 → 禁掉"换到别的号"的轮转。同一个号的瞬时错误等待重试
		// (上面的 503 容量 / 短 429 路径)不受影响,绑定卡仍会适当重试。
		canRetry := attempt < effectiveMaxAttempts && !lease.Bound

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
		lastProblemReason = problemReason
		leaser.ReportProblemWithDetails(card, deviceId, reportDetails, upstream, lease)
		break
	}
	if resp == nil {
		audit.note += "; 重试后无响应"
		p.sendJsonError(w, 502, "Upstream gateway error: no response after retries")
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		return
	}
	// 轮换用尽仍是配额/信用/容量类失败 → 不把上游那句英文 "Resource has been exhausted" 原样
	// 丢给 IDE,而是回一个【显眼】的中文提示 + Retry-After,让用户看懂、让 IDE 退避而非立刻又烧一轮号池。
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable {
		if msg, retrySec, hinted := poolExhaustionHint(lastProblemReason); hinted {
			audit.note += "; 池级耗尽提示"
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			w.Header().Set("Retry-After", fmt.Sprintf("%d", retrySec))
			p.sendJsonError(w, resp.StatusCode, msg)
			atomic.AddInt64(&p.stats.TotalErrors, 1)
			return
		}
	}
	defer resp.Body.Close()
	audit.status = resp.StatusCode

	// 首 chunk 的 200-内嵌错误检测 + 换号已在上面的重试循环里完成(problemReason=="" 分支)。
	// 走到这里:firstChunk 要么为空(非流式),要么是已确认【干净】的首块,直接转发。

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
		// 首 chunk 已写出 → streamResponse 进入时即视为"已转发过正常内容"，
		// 此后中途的 quota 匹配只当软信号、不掐流（避免截断工具调用）。
		tokenResult = p.streamResponse(tee, resp.Body, reqId, len(firstChunk) > 0)
		// auditTee 不缓存流式正文(captured()==nil);出错时用首 chunk 兜底,便于日志记录错误正文
		if captured := tee.captured(); len(captured) > 0 {
			audit.respBody = captured
		} else if audit.status >= 400 {
			audit.respBody = firstChunk
		}
		// 将首 chunk 的 bytes 也计入 token 解析
		if len(firstChunk) > 0 {
			tokenResult.StreamBytes += int64(len(firstChunk))
		}
		noteStreamAbort(audit, tokenResult)
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

	// 流末才出现的 quota/capacity 信号:本次已完整转发，不当错误处理。
	// 仅记日志（裸子串可能误判，不据此惩罚账号；真耗尽会在下次请求首 chunk 体现）。
	if tokenResult.StreamQuotaSoft {
		audit.note += fmt.Sprintf("; 流末额度信号(%s model=%s,已完整转发未掐流)", tokenResult.StreamErrorReason, tokenResult.StreamErrorModel)
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
	// 实际出口在每次 attempt 内按所租账号的绑定代理(egress)构建,见下方 resolveEgress。
	var client *http.Client
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
	// 首 chunk 在重试循环内预读(用于 200-内嵌错误换号);干净则带出循环供流式转发。
	var firstChunk []byte
	// 轮换用尽时最后一次失败的原因,用于给 IDE 一个【显眼】的中文提示(见 poolExhaustionHint)。
	var lastProblemReason string
	isStreaming := false

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
			// 卡额度用完 → 标准 429 + Retry-After(让 IDE 退避/停),而非 503(会被当临时故障狂试)。
			if writeQuotaExhausted(w, err) {
				atomic.AddInt64(&p.stats.TotalErrors, 1)
				return
			}
			p.sendJsonError(w, 503, fmt.Sprintf("租号服务暂时不可用，请稍后重试: %v", err))
			atomic.AddInt64(&p.stats.TotalErrors, 1)
			return
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

		// 出口:优先走所租账号绑定的住宅代理;没绑定则本地直连(用户代理→系统→直连)。
		egress, _ := resolveEgress(lease.EgressInfo, upstream) // antigravity optional,从不 blocked
		client = createStreamingHttpClient(egress)
		resp, err = client.Do(req)
		if err != nil {
			// optional 策略:绑定代理传输失败 → 降级本地直连重试一次,再不行才 502。
			if strings.TrimSpace(lease.EgressInfo.ProxyURL) != "" && !lease.EgressInfo.EgressRequired {
				audit.note += fmt.Sprintf("; 绑定代理失败降级本地:%v", err)
				retryReq, _ := http.NewRequest(req.Method, req.URL.String(), bytes.NewReader(body))
				retryReq.Header = req.Header.Clone()
				resp, err = createStreamingHttpClient(upstream).Do(retryReq)
			}
			if err != nil {
				audit.note += fmt.Sprintf("; 上游请求失败:%v", err)
				// 传输层错误(EOF/连接重置,根本没拿到 HTTP 响应)= 这个号的连接坏了/上游边缘丢了
				// socket。号池还有没试过的号时,像 429 一样换号,而不是一根死连接就整单 502。
				// 报为瞬时错误(服务端按阈值计数,单次不封号),并排除本号防本请求内又租到它。
				if shouldRotateOnTransportError(attempt, remoteMaxAttempts, lease.Bound) {
					audit.note += fmt.Sprintf("; 传输错误换号#%d", lease.AccountId)
					leaser.ReportProblemWithDetails(card, deviceId, ReportDetails{
						StatusCode: http.StatusBadGateway,
						ModelKey:   requestModelKey,
						Reason:     "transport_error",
						ErrorText:  err.Error(),
					}, upstream, lease)
					excludeAccountIds = append(excludeAccountIds, lease.AccountId)
					atomic.AddInt64(&p.stats.TotalRetries, 1)
					GetUsageStats().AddRetry()
					time.Sleep(remoteRetryDelayForStatus(attempt, http.StatusBadGateway))
					continue
				}
				p.sendJsonError(w, 502, fmt.Sprintf("Upstream gateway error: %v", err))
				atomic.AddInt64(&p.stats.TotalErrors, 1)
				return
			}
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
			// HTTP 2xx 但 Google 可能在【首个流 chunk】里塞配额/容量错误。循环内预读首块:
			// 内嵌错误 → 像 HTTP 错误一样换号(不再循环外直接回 429);干净则带出循环转发。
			isStreaming = strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") ||
				strings.Contains(strings.ToLower(r.URL.Path), "streamgeneratecontent")
			fc, emReason, emModel, emRetry := peekEmbeddedStreamError(resp, isStreaming)
			firstChunk = fc
			if emReason != "" {
				if emModel == "" {
					emModel = requestModelKey
				}
				statusForReport := 429
				if emReason == "capacity" {
					statusForReport = 503
				}
				reportDetails := ReportDetails{
					StatusCode: statusForReport, ModelKey: emModel, Reason: emReason,
					RetryAfterMs: emRetry, ErrorText: string(firstChunk),
				}
				leaser.ReportProblemWithDetails(card, deviceId, reportDetails, upstream, lease)
				if attempt < remoteMaxAttempts && !lease.Bound {
					audit.note += fmt.Sprintf("; 200内嵌%s换号#%d", emReason, lease.AccountId)
					excludeAccountIds = append(excludeAccountIds, lease.AccountId)
					_ = resp.Body.Close()
					resp = nil
					firstChunk = nil
					atomic.AddInt64(&p.stats.TotalRetries, 1)
					GetUsageStats().AddRetry()
					time.Sleep(remoteRetryDelayForStatus(attempt, statusForReport))
					continue
				}
				audit.status = statusForReport
				audit.respBody = firstChunk
				audit.note += fmt.Sprintf("; 200内嵌%s终止#%d", emReason, lease.AccountId)
				_ = resp.Body.Close()
				p.sendJsonError(w, statusForReport, fmt.Sprintf("Account quota exhausted (%s), please retry", emReason))
				atomic.AddInt64(&p.stats.TotalErrors, 1)
				return
			}
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

		effectiveMaxAttempts := remoteMaxAttempts
		// 绑定卡没有别的号可换 → 禁掉"换到别的号"的轮转。同一个号的瞬时错误等待重试
		// (上面的 503 容量 / 短 429 路径)不受影响,绑定卡仍会适当重试。
		canRetry := attempt < effectiveMaxAttempts && !lease.Bound

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
		lastProblemReason = problemReason
		leaser.ReportProblemWithDetails(card, deviceId, reportDetails, upstream, lease)
		break
	}

	if resp == nil {
		audit.note += "; 重试后无响应"
		p.sendJsonError(w, 502, "Upstream gateway error: no response after retries")
		atomic.AddInt64(&p.stats.TotalErrors, 1)
		return
	}
	// 轮换用尽仍是配额/信用/容量类失败 → 不把上游那句英文 "Resource has been exhausted" 原样
	// 丢给 IDE,而是回一个【显眼】的中文提示 + Retry-After,让用户看懂、让 IDE 退避而非立刻又烧一轮号池。
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable {
		if msg, retrySec, hinted := poolExhaustionHint(lastProblemReason); hinted {
			audit.note += "; 池级耗尽提示"
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			w.Header().Set("Retry-After", fmt.Sprintf("%d", retrySec))
			p.sendJsonError(w, resp.StatusCode, msg)
			atomic.AddInt64(&p.stats.TotalErrors, 1)
			return
		}
	}
	defer resp.Body.Close()
	audit.status = resp.StatusCode

	// 首 chunk 的 200-内嵌错误检测 + 换号已在上面的重试循环里完成(problemReason=="" 分支)。
	// 走到这里:firstChunk 要么为空(非流式),要么是已确认【干净】的首块,直接转发。

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
		// 首 chunk 已写出 → streamResponse 进入时即视为"已转发过正常内容"，
		// 此后中途的 quota 匹配只当软信号、不掐流（避免截断工具调用）。
		tokenResult = p.streamResponse(tee, resp.Body, reqId, len(firstChunk) > 0)
		// auditTee 不缓存流式正文(captured()==nil);出错时用首 chunk 兜底,便于日志记录错误正文
		if captured := tee.captured(); len(captured) > 0 {
			audit.respBody = captured
		} else if audit.status >= 400 {
			audit.respBody = firstChunk
		}
		if len(firstChunk) > 0 {
			tokenResult.StreamBytes += int64(len(firstChunk))
		}
		noteStreamAbort(audit, tokenResult)
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

	// 流末才出现的 quota/capacity 信号:本次已完整转发，不当错误处理。
	// 仅记日志（裸子串可能误判，不据此惩罚账号；真耗尽会在下次请求首 chunk 体现）。
	if tokenResult.StreamQuotaSoft {
		audit.note += fmt.Sprintf("; 流末额度信号(%s model=%s,已完整转发未掐流)", tokenResult.StreamErrorReason, tokenResult.StreamErrorModel)
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
