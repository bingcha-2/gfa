package main

import (
	"io"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCodexUsageFromJSON(t *testing.T) {
	cases := []struct {
		name                 string
		body                 string
		in, out, cached, tot int64
		ok                   bool
	}{
		{"top-level usage", `{"usage":{"input_tokens":100,"output_tokens":50,"total_tokens":150}}`, 100, 50, 0, 150, true},
		{"nested response.usage", `{"type":"response.completed","response":{"usage":{"input_tokens":80,"output_tokens":20,"total_tokens":100}}}`, 80, 20, 0, 100, true},
		{"total derived", `{"usage":{"input_tokens":10,"output_tokens":5}}`, 10, 5, 0, 15, true},
		// 缓存命中:Responses API 把 cached_tokens 放在 input_tokens_details(含于 input_tokens)。
		{"cached from input_tokens_details", `{"usage":{"input_tokens":22306,"input_tokens_details":{"cached_tokens":21000},"output_tokens":28,"total_tokens":22334}}`, 22306, 28, 21000, 22334, true},
		{"cached clamped to input", `{"usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":500},"output_tokens":5}}`, 100, 5, 100, 105, true},
		{"no usage", `{"type":"response.output_text.delta","delta":"hi"}`, 0, 0, 0, 0, false},
		{"bad json", `not json`, 0, 0, 0, 0, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			in, out, cached, tot, ok := codexUsageFromJSON([]byte(c.body))
			if ok != c.ok || in != c.in || out != c.out || cached != c.cached || tot != c.tot {
				t.Fatalf("got (%d,%d,%d,%d,%v) want (%d,%d,%d,%d,%v)", in, out, cached, tot, ok, c.in, c.out, c.cached, c.tot, c.ok)
			}
		})
	}
}

// codexReportDetails 对缓存命中要打 1/10 折扣(与 Gemini/Claude 同口径)。
func TestCodexReportDetailsCacheDiscount(t *testing.T) {
	body := `{"usage":{"input_tokens":1000,"input_tokens_details":{"cached_tokens":800},"output_tokens":50,"total_tokens":1050}}`
	d := codexReportDetails(200, "gpt-5.5", []byte(body))
	if d.InputTokens != 1000 || d.OutputTokens != 50 {
		t.Fatalf("in/out got (%d,%d) want (1000,50)", d.InputTokens, d.OutputTokens)
	}
	if d.CachedInputTokens != 800 {
		t.Fatalf("cached got %d want 800", d.CachedInputTokens)
	}
	if d.RawTotalTokens != 1050 {
		t.Fatalf("raw got %d want 1050", d.RawTotalTokens)
	}
	// billable = raw - cached + ceil(cached/10) = 1050 - 800 + 80 = 330
	if d.BillableTotalTokens != 330 {
		t.Fatalf("billable got %d want 330 (raw-cached+ceil(cached/10))", d.BillableTotalTokens)
	}
}

func TestCopyStreamingCodexResponseExtractsUsage(t *testing.T) {
	// 典型 codex responses SSE 流:增量 + 末尾 response.completed 带 usage。
	sse := strings.Join([]string{
		`event: response.output_text.delta`,
		`data: {"type":"response.output_text.delta","delta":"hello"}`,
		``,
		`event: response.completed`,
		`data: {"type":"response.completed","response":{"usage":{"input_tokens":1234,"input_tokens_details":{"cached_tokens":1000},"output_tokens":567,"total_tokens":1801}}}`,
		``,
	}, "\n")

	rec := httptest.NewRecorder()
	in, out, cached, tot, err := copyStreamingCodexResponse(rec, strings.NewReader(sse))
	if err != nil {
		t.Fatalf("copy error: %v", err)
	}
	if in != 1234 || out != 567 || cached != 1000 || tot != 1801 {
		t.Fatalf("usage got (%d,%d,%d,%d) want (1234,567,1000,1801)", in, out, cached, tot)
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
	in, out, cached, tot, err := copyStreamingCodexResponse(rec, &chunkedReader{data: []byte(full), chunk: 7})
	if err != nil {
		t.Fatalf("copy error: %v", err)
	}
	if in != 9 || out != 1 || cached != 0 || tot != 10 {
		t.Fatalf("usage got (%d,%d,%d,%d) want (9,1,0,10)", in, out, cached, tot)
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
