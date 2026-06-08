package main

import (
	"fmt"
	"net/http"
	"strings"
)

// ─── 代理审计:每个被代理的请求只输出【一条】日志 ───────────────────────────
//
// 目标(产品要求):所有被接管/代理的请求都要能看到,但「一次代理只输出一条」——
// 把原先分散在请求生命周期里的多行日志(req / 上游头 / 成功 / 失败 …)收敛成一条,
// 内含元信息 + 完整请求/响应正文。access token 一律打码(只替换其中 5 位)。
//
// 用法:在每个代理 handler 开头 `audit := newProxyAudit(...)` + `defer audit.emit()`,
// 中途把字段填上(model / 账号 / token / 状态码 / tokens / 备注),最终统一出一条。
// access token 在日志里也只输出不可还原的脱敏串(redactToken),绝不打印原文。

// auditTee 是 http.ResponseWriter 的薄透传包裹(保留 Flush 以维持 SSE 逐块流式)。
// 正文不再进日志,故这里不缓冲任何字节;保留它只是让流式调用点写法统一、改动最小。
// 实现完整 http.ResponseWriter,可直接传给 copyStreamingCodexResponse(需 ResponseWriter)
// 和 copyStreamingClaudeResponse(需 io.Writer)。
type auditTee struct {
	w http.ResponseWriter
}

func newAuditTee(w http.ResponseWriter) *auditTee {
	return &auditTee{w: w}
}

func (t *auditTee) Header() http.Header         { return t.w.Header() }
func (t *auditTee) WriteHeader(status int)      { t.w.WriteHeader(status) }
func (t *auditTee) Write(p []byte) (int, error) { return t.w.Write(p) }
func (t *auditTee) Flush() {
	if f, ok := t.w.(http.Flusher); ok {
		f.Flush()
	}
}
func (t *auditTee) captured() []byte { return nil }

// proxyAudit 累积一次被代理请求的全部信息,在 defer emit() 时一次性输出成一条日志。
type proxyAudit struct {
	product   string // claude / codex / antigravity
	reqID     int64
	kind      string // 生成 / 辅助 / 中转 …
	method    string
	path      string
	target    string // 实际转发到的上游地址(发送到哪里)
	model     string
	accountID int
	token     string // access token(emit 时打码)
	status    int
	inTokens  int64
	outTokens int64
	// cachedTokens/billableTokens 仅用于日志显示真实口径(尤其 claude 命中缓存时,
	// in 只是 net 新增、计费按缓存 1/10 折后)。0 时不显示,不影响上报。
	cachedTokens   int64
	billableTokens int64
	reqBody        []byte
	respBody       []byte
	note           string // 错误/补充说明(被拒/流中断/lease 失败 …)
	emitted        bool
}

func newProxyAudit(product string, reqID int64, kind, method, path string) *proxyAudit {
	return &proxyAudit{product: product, reqID: reqID, kind: kind, method: method, path: path}
}

func (a *proxyAudit) emit() {
	if a == nil || a.emitted {
		return
	}
	a.emitted = true

	var b strings.Builder
	kind := a.kind
	if kind == "" {
		kind = "代理"
	}
	fmt.Fprintf(&b, "[%s-proxy] #%d [%s] %s %s", a.product, a.reqID, kind, a.method, a.path)
	if a.target != "" {
		fmt.Fprintf(&b, " → %s", a.target)
	}
	if a.model != "" {
		fmt.Fprintf(&b, " model=%s", a.model)
	}
	if a.accountID > 0 {
		fmt.Fprintf(&b, " acct=%d", a.accountID)
	}
	if a.token != "" {
		fmt.Fprintf(&b, " token=%s", redactToken(a.token))
	}
	if a.status > 0 {
		fmt.Fprintf(&b, " 码=%d", a.status)
	}
	if a.inTokens > 0 || a.outTokens > 0 || a.cachedTokens > 0 {
		fmt.Fprintf(&b, " tokens(in=%d", a.inTokens)
		if a.cachedTokens > 0 {
			fmt.Fprintf(&b, " cache=%d", a.cachedTokens)
		}
		fmt.Fprintf(&b, " out=%d", a.outTokens)
		if a.billableTokens > 0 {
			fmt.Fprintf(&b, " 计费=%d", a.billableTokens)
		}
		b.WriteString(")")
	}
	if a.note != "" {
		fmt.Fprintf(&b, " 备注=%s", a.note)
	}
	// 正常请求只记一行元信息,正文省略;但出错(>=400)时附带上游错误正文(截断),便于定位 400/403/5xx 原因。
	if a.status >= 400 && len(a.respBody) > 0 {
		snippet := strings.ReplaceAll(string(a.respBody), "\n", " ")
		if rs := []rune(snippet); len(rs) > 500 {
			snippet = string(rs[:500]) + "…(截断)"
		}
		fmt.Fprintf(&b, " 错误正文=%s", snippet)
	}
	Log("%s", b.String())
}
