package main

import (
	"net/http"
	"strings"
	"testing"
)

func TestInjectHideChatHTML_InsertsBeforeHead(t *testing.T) {
	html := []byte("<!doctype html><html><head><title>x</title></head><body>hi</body></html>")
	out, ok := injectHideChatHTML(html)
	if !ok {
		t.Fatal("应注入")
	}
	s := string(out)
	if !strings.Contains(s, bcaiHideChatMarker) {
		t.Error("缺少幂等标记")
	}
	if !strings.Contains(s, "__bcai_hide_chat_js__") {
		t.Error("缺少守卫脚本")
	}
	// 注入点必须在 </head> 之前。
	if strings.Index(s, "__bcai_hide_chat_js__") > strings.Index(s, "</head>") {
		t.Error("脚本应插在 </head> 之前")
	}
}

func TestInjectHideChatHTML_Idempotent(t *testing.T) {
	html := []byte("<html><head></head><body></body></html>")
	once, ok := injectHideChatHTML(html)
	if !ok {
		t.Fatal("首次应注入")
	}
	twice, ok2 := injectHideChatHTML(once)
	if ok2 {
		t.Error("二次注入应被幂等标记拦下")
	}
	if string(twice) != string(once) {
		t.Error("二次注入不应改动内容")
	}
	if strings.Count(string(twice), bcaiHideChatMarker) != 1 {
		t.Error("标记应只出现一次")
	}
}

func TestInjectHideChatHTML_FallbackToBody(t *testing.T) {
	// 无 </head>,但有 <html> 与 </body> → 退到 </body> 前。
	html := []byte("<html><body>only body</body></html>")
	out, ok := injectHideChatHTML(html)
	if !ok {
		t.Fatal("应注入(走 </body> 兜底)")
	}
	s := string(out)
	if strings.Index(s, "__bcai_hide_chat_js__") > strings.Index(s, "</body>") {
		t.Error("脚本应插在 </body> 之前")
	}
}

func TestInjectHideChatHTML_SkipsNonDocument(t *testing.T) {
	// 没有 <head>/<html> 的片段(如 JSON 误判、纯文本)不应被注入。
	for _, b := range []string{`{"ok":true}`, "plain text", "<div>fragment</div>"} {
		out, ok := injectHideChatHTML([]byte(b))
		if ok {
			t.Errorf("非文档不应注入: %q", b)
		}
		if string(out) != b {
			t.Errorf("非文档应原样返回: %q", b)
		}
	}
}

func TestInsertBeforeTagCI_CaseInsensitive(t *testing.T) {
	out, ok := insertBeforeTagCI("<HTML><HEAD></HEAD></HTML>", "</head>", "X")
	if !ok {
		t.Fatal("大写 </HEAD> 也应命中")
	}
	if !strings.Contains(out, "X</HEAD>") {
		t.Errorf("插入位置错误: %s", out)
	}
}

func TestInsertBeforeTagCI_NotFound(t *testing.T) {
	out, ok := insertBeforeTagCI("<p>no head here</p>", "</head>", "X")
	if ok {
		t.Error("找不到 tag 应返回 false")
	}
	if out != "<p>no head here</p>" {
		t.Error("找不到 tag 应原样返回")
	}
}

func TestMitmIsClaudeAiHTMLDocument(t *testing.T) {
	mk := func(ct string) *http.Response {
		h := http.Header{}
		if ct != "" {
			h.Set("Content-Type", ct)
		}
		return &http.Response{Header: h}
	}
	if !mitmIsClaudeAiHTMLDocument(mk("text/html; charset=utf-8")) {
		t.Error("text/html 应判为文档")
	}
	if !mitmIsClaudeAiHTMLDocument(mk("TEXT/HTML")) {
		t.Error("大小写不敏感")
	}
	if mitmIsClaudeAiHTMLDocument(mk("application/json")) {
		t.Error("JSON 不是文档")
	}
	if mitmIsClaudeAiHTMLDocument(mk("")) {
		t.Error("无 Content-Type 不是文档")
	}
	if mitmIsClaudeAiHTMLDocument(nil) {
		t.Error("nil 响应应为 false")
	}
}

func TestNeutralizeMetaCSP(t *testing.T) {
	cases := []struct {
		in       string
		stillCSP bool
	}{
		{`<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`, false},
		{`<meta http-equiv='content-security-policy-report-only' content="x">`, false},
		{`<META HTTP-EQUIV="Content-Security-Policy" CONTENT="y">`, false},
		{`<meta charset="utf-8">`, false}, // 无 CSP meta,保持原样(本就无 csp)
	}
	for _, c := range cases {
		out := neutralizeMetaCSP(c.in)
		hasCSP := strings.Contains(strings.ToLower(out), `http-equiv="content-security-policy`) ||
			strings.Contains(strings.ToLower(out), `http-equiv='content-security-policy`)
		if hasCSP {
			t.Errorf("CSP meta 未被中和: %s -> %s", c.in, out)
		}
	}
	// 中和后注入的脚本不会被文档内 CSP meta 拦下:整篇注入流程验证。
	html := []byte(`<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'"></head><body></body></html>`)
	out, ok := injectHideChatHTML(html)
	if !ok {
		t.Fatal("应注入")
	}
	if strings.Contains(strings.ToLower(string(out)), `http-equiv="content-security-policy"`) {
		t.Error("注入后文档内 CSP meta 应已被中和")
	}
}

func TestStripCSPHeaders(t *testing.T) {
	h := http.Header{}
	h.Set("Content-Security-Policy", "default-src 'self'")
	h.Set("Content-Security-Policy-Report-Only", "default-src 'self'")
	h.Set("Content-Type", "text/html")
	stripCSPHeaders(h)
	if h.Get("Content-Security-Policy") != "" || h.Get("Content-Security-Policy-Report-Only") != "" {
		t.Error("CSP 头应被删除")
	}
	if h.Get("Content-Type") != "text/html" {
		t.Error("不应误删其它头")
	}
}
