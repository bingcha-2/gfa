package main

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"io"
	"net/http"
	"testing"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
)

// 出站要贴合真客户端 → 必须把客户端的 Accept-Encoding 原样转发给上游(不再 skip)。
func TestApplyClaudeUpstreamHeaders_ForwardsAcceptEncoding(t *testing.T) {
	src := http.Header{}
	src.Set("Accept-Encoding", "gzip, deflate, br, zstd")
	src.Set("User-Agent", "claude-cli/2.1.170 (external, claude-desktop, agent-sdk/0.3.170)")
	src.Set("X-Api-Key", "sk-should-be-dropped")

	dst := http.Header{}
	applyClaudeUpstreamHeaders(dst, src, "oat-token", "https://api.anthropic.com/v1/messages", 1)

	if got := dst.Get("Accept-Encoding"); got != "gzip, deflate, br, zstd" {
		t.Fatalf("Accept-Encoding 应原样转发,得到 %q", got)
	}
	if dst.Get("Authorization") != "Bearer oat-token" {
		t.Fatalf("Authorization 应换成租来的 Bearer,得到 %q", dst.Get("Authorization"))
	}
	if dst.Get("X-Api-Key") != "" {
		t.Fatalf("X-Api-Key 应被剔除,得到 %q", dst.Get("X-Api-Key"))
	}
}

func gz(b []byte) []byte {
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	_, _ = w.Write(b)
	_ = w.Close()
	return buf.Bytes()
}

func fl(b []byte) []byte {
	var buf bytes.Buffer
	w, _ := flate.NewWriter(&buf, flate.DefaultCompression)
	_, _ = w.Write(b)
	_ = w.Close()
	return buf.Bytes()
}

func br(b []byte) []byte {
	var buf bytes.Buffer
	w := brotli.NewWriter(&buf)
	_, _ = w.Write(b)
	_ = w.Close()
	return buf.Bytes()
}

func zs(b []byte) []byte {
	var buf bytes.Buffer
	w, _ := zstd.NewWriter(&buf)
	_, _ = w.Write(b)
	_ = w.Close()
	return buf.Bytes()
}

// 上游可能按宣告的编码回压缩 body;下游解析/写客户端按明文 → 必须就地解压还原。
func TestDecodeUpstreamBytes_RoundTrip(t *testing.T) {
	want := []byte(`{"type":"message","usage":{"input_tokens":5,"output_tokens":7}}`)
	cases := []struct {
		enc string
		raw []byte
	}{
		{"gzip", gz(want)},
		{"deflate", fl(want)},
		{"br", br(want)},
		{"zstd", zs(want)},
	}
	for _, c := range cases {
		t.Run(c.enc, func(t *testing.T) {
			got, ok := decodeUpstreamBytes(c.enc, c.raw)
			if !ok {
				t.Fatalf("%s: 解压应成功", c.enc)
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("%s: 解压结果不符\n want %s\n got  %s", c.enc, want, got)
			}
		})
	}
}

// 未知/损坏编码:宁可原样透传(ok=false),也别把垃圾当明文塞给解析层。
func TestDecodeUpstreamBytes_UnknownAndBroken(t *testing.T) {
	if got, ok := decodeUpstreamBytes("identity", []byte("plain")); !ok || string(got) != "plain" {
		t.Fatalf("identity 应原样返回, ok=%v got=%q", ok, got)
	}
	if got, ok := decodeUpstreamBytes("weird", []byte("plain")); !ok || string(got) != "plain" {
		t.Fatalf("未知编码应原样透传, ok=%v got=%q", ok, got)
	}
	if got, ok := decodeUpstreamBytes("gzip", []byte("not-actually-gzip")); ok || string(got) != "not-actually-gzip" {
		t.Fatalf("损坏 gzip 应回退原始字节且 ok=false, ok=%v got=%q", ok, got)
	}
}

// 流式路径用 reader 包一层解压;SSE 实际几乎不压,这里只验证包装正确。
func TestDecompressReader_Stream(t *testing.T) {
	want := []byte("event: ping\ndata: {}\n\n")
	rc, err := decompressReader("gzip", bytes.NewReader(gz(want)))
	if err != nil {
		t.Fatalf("decompressReader err: %v", err)
	}
	defer rc.Close()
	got, _ := io.ReadAll(rc)
	if !bytes.Equal(got, want) {
		t.Fatalf("stream 解压不符\n want %s\n got  %s", want, got)
	}
}
