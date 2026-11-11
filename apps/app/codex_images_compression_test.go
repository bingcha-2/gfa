package main

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tidwall/gjson"
)

func TestCodexServeImagesHostedCompressedResponse(t *testing.T) {
	for _, tc := range []struct{ name, path, body string }{
		{"generation", "/v1/images/generations", `{"prompt":"test"}`},
		{"reference_edit", "/v1/images/edits", `{"model":"gpt-image-2","prompt":"test","image":"data:image/png;base64,aW1hZ2U="}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload := "data: " + `{"type":"response.completed","response":{"output":[{"type":"image_generation_call","result":"image-base64","output_format":"png"}],"usage":{"input_tokens":4,"output_tokens":6,"total_tokens":10}}}` + "\n\n"
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/backend-api/codex/responses" {
					t.Errorf("unexpected upstream path: %s", r.URL.Path)
				}
				w.Header().Set("Content-Type", "text/event-stream")
				w.Header().Set("Content-Encoding", "gzip")
				z := gzip.NewWriter(w)
				_, _ = io.WriteString(z, payload)
				_ = z.Close()
			}))
			defer upstream.Close()
			var reported int64
			proxy := &CodexProxy{
				upstreamBase: upstream.URL,
				leaseToken: func(string, string, bool, map[string]interface{}, string) (*CodexTokenLease, error) {
					return &CodexTokenLease{AccessToken: forgeFakeCodexJWT("compressed-hosted"), AccountId: 11}, nil
				},
				reportResult: func(_ string, _ string, d ReportDetails, _ string, _ *CodexTokenLease) { reported = d.RawTotalTokens },
			}
			req := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			// Explicit negotiation prevents Go's standard transport from silently
			// decompressing for us, matching forwarded Codex client headers.
			req.Header.Set("Accept-Encoding", "gzip")
			rec := httptest.NewRecorder()
			proxy.ServeImages(rec, req, "test", "device", "direct")
			if rec.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if got := gjson.GetBytes(rec.Body.Bytes(), "data.0.b64_json").String(); got != "image-base64" {
				t.Fatalf("missing decoded image: %q", got)
			}
			if reported != 10 {
				t.Fatalf("reported tokens=%d, want 10", reported)
			}
			if rec.Header().Get("Content-Encoding") != "" {
				t.Fatal("decoded image response retains compression header")
			}
		})
	}
}
