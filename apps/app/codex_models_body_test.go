package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"strings"
	"testing"
)

func gzipBytes(t *testing.T, raw []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(raw); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func modelsResp(headers http.Header, body []byte) *http.Response {
	if headers == nil {
		headers = http.Header{}
	}
	return &http.Response{Header: headers, Body: io.NopCloser(bytes.NewReader(body))}
}

// gzip 响应必须被手动解压后再校验(自定义 uTLS 传输不做自动解压)。
// 这是把 277KB 明文压成 ~40KB、避免 4s 读超时的关键路径。
func TestReadCodexModelsBodyGzip(t *testing.T) {
	payload := []byte(`{"models":[{"id":"gpt-5-codex"}]}`)
	resp := modelsResp(http.Header{"Content-Encoding": []string{"gzip"}}, gzipBytes(t, payload))

	got, err := readCodexModelsBody(resp)
	if err != nil {
		t.Fatalf("gzip 响应应成功解压, err=%v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("解压结果 = %s, want %s", got, payload)
	}
}

// 无 Content-Encoding(identity)按明文直读。
func TestReadCodexModelsBodyIdentity(t *testing.T) {
	payload := []byte(`{"models":[{"id":"x"}]}`)
	got, err := readCodexModelsBody(modelsResp(nil, payload))
	if err != nil {
		t.Fatalf("identity 响应应成功, err=%v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("body = %s, want %s", got, payload)
	}
}

// 缺 models 字段 / models 为 null = 无效目录,必须报错(否则会把坏响应当有效结果回给 app)。
// 注意:空数组 {"models":[]} 按既有契约算有效,不在此处拒绝。
func TestReadCodexModelsBodyRejectsMissing(t *testing.T) {
	for _, bad := range []string{`{}`, `{"models":null}`} {
		if _, err := readCodexModelsBody(modelsResp(nil, []byte(bad))); err == nil {
			t.Fatalf("%s 应报错", bad)
		}
	}
}

// 坏 gzip 字节应报错,不 panic。
func TestReadCodexModelsBodyBadGzip(t *testing.T) {
	resp := modelsResp(http.Header{"Content-Encoding": []string{"gzip"}}, []byte("not-gzip"))
	if _, err := readCodexModelsBody(resp); err == nil {
		t.Fatal("坏 gzip 应报错")
	}
}

// 非 JSON 明文应报错。
func TestReadCodexModelsBodyBadJSON(t *testing.T) {
	if _, err := readCodexModelsBody(modelsResp(nil, []byte(strings.Repeat("x", 10)))); err == nil {
		t.Fatal("非 JSON 应报错")
	}
}
