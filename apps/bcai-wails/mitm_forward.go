package main

import (
	"net/http"
	"net/http/httputil"
	"net/url"
)

// mitmForwardHandler 把 MITM 解密出的请求反向代理到真实上游 upstreamBase
// (如 https://api.anthropic.com)，原样保留请求头(含用户自己的 Authorization/登录态)。
// 用于非 /v1/messages 的端点(/api/hello、/api/auth/me、/v1/models 等)透传——
// 这些走用户真实账号，我们只在 /v1/messages 上换号池 token。
// transport 可注入(测试用 httptest TLS server 的 client transport)；nil 时用默认。
func mitmForwardHandler(upstreamBase string, transport http.RoundTripper) http.Handler {
	target, err := url.Parse(upstreamBase)
	if err != nil || target.Host == "" {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "mitm: bad upstream base", http.StatusBadGateway)
		})
	}
	rp := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host
			req.Host = target.Host
		},
	}
	if transport != nil {
		rp.Transport = transport
	}
	return rp
}
