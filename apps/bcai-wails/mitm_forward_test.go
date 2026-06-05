package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 透传 handler 应把解密出的请求（方法/路径/体）反向代理到真实上游，并把上游响应回传。
func TestMitmForwardHandlerProxiesToUpstream(t *testing.T) {
	var gotPath, gotMethod, gotBody string
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(201)
		_, _ = w.Write([]byte("UP:" + r.URL.Path))
	}))
	defer upstream.Close()

	h := mitmForwardHandler(upstream.URL, upstream.Client().Transport)

	req := httptest.NewRequest("POST", "https://api.anthropic.com/api/hello", strings.NewReader(`{"x":1}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != 201 || rec.Body.String() != "UP:/api/hello" {
		t.Fatalf("unexpected response: %d %q", rec.Code, rec.Body.String())
	}
	if gotMethod != "POST" || gotPath != "/api/hello" || gotBody != `{"x":1}` {
		t.Fatalf("upstream saw wrong request: %s %s %q", gotMethod, gotPath, gotBody)
	}
}
