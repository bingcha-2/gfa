package main

import (
	"io"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCodexUsageFromJSON(t *testing.T) {
	cases := []struct {
		name              string
		body              string
		in, out, tot      int64
		ok                bool
	}{
		{"top-level usage", `{"usage":{"input_tokens":100,"output_tokens":50,"total_tokens":150}}`, 100, 50, 150, true},
		{"nested response.usage", `{"type":"response.completed","response":{"usage":{"input_tokens":80,"output_tokens":20,"total_tokens":100}}}`, 80, 20, 100, true},
		{"total derived", `{"usage":{"input_tokens":10,"output_tokens":5}}`, 10, 5, 15, true},
		{"no usage", `{"type":"response.output_text.delta","delta":"hi"}`, 0, 0, 0, false},
		{"bad json", `not json`, 0, 0, 0, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			in, out, tot, ok := codexUsageFromJSON([]byte(c.body))
			if ok != c.ok || in != c.in || out != c.out || tot != c.tot {
				t.Fatalf("got (%d,%d,%d,%v) want (%d,%d,%d,%v)", in, out, tot, ok, c.in, c.out, c.tot, c.ok)
			}
		})
	}
}

func TestCopyStreamingCodexResponseExtractsUsage(t *testing.T) {
	// 典型 codex responses SSE 流:增量 + 末尾 response.completed 带 usage。
	sse := strings.Join([]string{
		`event: response.output_text.delta`,
		`data: {"type":"response.output_text.delta","delta":"hello"}`,
		``,
		`event: response.completed`,
		`data: {"type":"response.completed","response":{"usage":{"input_tokens":1234,"output_tokens":567,"total_tokens":1801}}}`,
		``,
	}, "\n")

	rec := httptest.NewRecorder()
	in, out, tot, err := copyStreamingCodexResponse(rec, strings.NewReader(sse))
	if err != nil {
		t.Fatalf("copy error: %v", err)
	}
	if in != 1234 || out != 567 || tot != 1801 {
		t.Fatalf("usage got (%d,%d,%d) want (1234,567,1801)", in, out, tot)
	}
	// 字节必须原样转发(流式不能改 body)。
	if rec.Body.String() != sse {
		t.Fatalf("body not forwarded verbatim")
	}
}

func TestCopyStreamingCodexResponseUsageSplitAcrossChunks(t *testing.T) {
	// usage 事件被网络分包切断时也要能拼回来(行缓冲)。
	full := "data: {\"response\":{\"usage\":{\"input_tokens\":9,\"output_tokens\":1,\"total_tokens\":10}}}\n"
	rec := httptest.NewRecorder()
	in, out, tot, err := copyStreamingCodexResponse(rec, &chunkedReader{data: []byte(full), chunk: 7})
	if err != nil {
		t.Fatalf("copy error: %v", err)
	}
	if in != 9 || out != 1 || tot != 10 {
		t.Fatalf("usage got (%d,%d,%d) want (9,1,10)", in, out, tot)
	}
}

// chunkedReader 按固定小块返回,模拟流式分包。
type chunkedReader struct {
	data  []byte
	chunk int
	pos   int
}

func (r *chunkedReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}
	end := r.pos + r.chunk
	if end > len(r.data) {
		end = len(r.data)
	}
	n := copy(p, r.data[r.pos:end])
	r.pos += n
	return n, nil
}
