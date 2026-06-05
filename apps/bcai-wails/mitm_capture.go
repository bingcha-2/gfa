package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
)

// ─── 临时抓取模式:看 /v1/oauth/*/authorize 等的真实响应全文 ──────────────────
//
// 用于评估方案 B(完全伪造 Code OAuth 流程):带【用户真实 token】透传到上游,不换号池、
// 不改写、不兜底、不截断,把完整响应打日志。用 Max 号触发一次 Code 授权即可看到 authorize
// 成功响应的 schema —— 若是纯不透明 token,B 可行(伪造后 /v1/messages 仍走号池兜底);
// 若带客户端可校验的签名,B 不可行。
//
// ⚠ 临时诊断用:验证完按结论改回(走号池 or 伪造 or 撤除)。
func mitmCaptureHandler(upstreamBase string, transport http.RoundTripper) http.Handler {
	target, _ := url.Parse(upstreamBase)
	return &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host
			req.Host = target.Host
			req.Header.Del("Accept-Encoding")
			// 记录请求体(伪造时需知道客户端发了什么:client_id/scope/PKCE 等)。
			if req.Body != nil {
				rb, _ := io.ReadAll(req.Body)
				req.Body = io.NopCloser(bytes.NewReader(rb))
				req.ContentLength = int64(len(rb))
				Log("[mitm-capture] → 请求 %s %s body: %s", req.Method, req.URL.Path, string(rb))
			} else {
				Log("[mitm-capture] → 请求 %s %s (无 body)", req.Method, req.URL.Path)
			}
		},
		Transport: transport,
		ModifyResponse: func(resp *http.Response) error {
			path := ""
			if resp.Request != nil && resp.Request.URL != nil {
				path = resp.Request.URL.Path
			}
			body, err := readMaybeGzip(resp)
			if err != nil {
				return nil
			}
			Log("[mitm-capture] %d %s 完整响应: %s", resp.StatusCode, path, string(body))
			resp.Body = io.NopCloser(bytes.NewReader(body))
			resp.ContentLength = int64(len(body))
			resp.Header.Set("Content-Length", strconv.Itoa(len(body)))
			resp.Header.Del("Content-Encoding")
			return nil
		},
	}
}
