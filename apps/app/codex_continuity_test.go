package main

import (
	"bytes"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCodexMultilineEventAndPrettyJSON(t *testing.T) {
	json := `{"type":"response.completed",
"response":{"id":"resp_multi","model":"gpt-6-astra","status":"completed","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}`
	for _, body := range []string{json, "event: response.completed\r\ndata: " + strings.ReplaceAll(json, "\n", "\r\ndata: ") + "\r\n\r\n"} {
		d := codexStreamDiagnostic{SentModel: "gpt-6-astra"}
		w := httptest.NewRecorder()
		model, _, _, _, total, err := copyStreamingCodexResponse(w, &diagnosticChunkReader{data: []byte(body)}, &d)
		if err != nil || w.Body.String() != body || total != 5 || model != "gpt-6-astra" || d.Result != "completed" || d.ResponseID != "resp_multi" {
			t.Fatalf("multiline changed or lost: %s %d %v %+v", model, total, err, d)
		}
	}
}

func TestCodexObserverOversizedEventStillForwardsAndRecovers(t *testing.T) {
	body := "data: " + strings.Repeat("x", codexObservedEventLimit+20) + "\n\ndata: {\"type\":\"response.completed\",\"response\":{\"model\":\"gpt-6-astra\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n"
	w := httptest.NewRecorder()
	d := codexStreamDiagnostic{}
	_, _, _, _, total, err := copyStreamingCodexResponse(w, strings.NewReader(body), &d)
	if err != nil || !bytes.Equal(w.Body.Bytes(), []byte(body)) || total != 2 || d.Result != "completed" {
		t.Fatalf("oversized observation affected forwarding: %v %+v", err, d)
	}
}

func TestCodexWSReportsEachResponseAndIgnoresDuplicateTerminal(t *testing.T) {
	var reports []ReportDetails
	o := codexWSObserver{report: func(d ReportDetails) { reports = append(reports, d) }}
	o.request([]byte(`{"type":"response.create","model":"gpt-6-astra","reasoning":{"effort":"high"},"usage":{"total_tokens":999}}`))
	o.response([]byte(`{"type":"response.created","response":{"id":"resp_1","model":"gpt-6-astra"}}`))
	first := []byte(`{"type":"response.completed","response":{"id":"resp_1","model":"gpt-6-astra","usage":{"input_tokens":20,"output_tokens":10}}}`)
	o.response(first)
	o.request([]byte(`{"type":"response.create","response":{"model":"gpt-5.6-sol"}}`))
	o.response(first) // old completion must not consume the next pending request
	o.response([]byte(`{"type":"response.completed","response":{"id":"resp_2","model":"gpt-5.6-sol","usage":{"input_tokens":2,"output_tokens":1}}}`))
	o.request([]byte(`{"type":"response.create","model":"gpt-6-astra"}`))
	o.response([]byte(`{"type":"response.failed","response":{"id":"resp_3","error":{"code":"invalid_prompt","message":"rejected"}}}`))
	o.close()
	if len(reports) != 3 || reports[0].RawTotalTokens != 30 || reports[1].RawTotalTokens != 3 || reports[2].RawTotalTokens != 0 {
		t.Fatalf("per response usage lost or duplicated: %+v", reports)
	}
	if reports[0].CodexDiagnostic.RequestSequence != 1 || reports[1].CodexDiagnostic.RequestSequence != 2 || reports[2].CodexDiagnostic.RequestSequence != 3 {
		t.Fatal("WS sequence missing or reused")
	}
	if reports[1].ModelKey != "gpt-5.6-sol" || reports[0].CodexDiagnostic.ReasoningEffort != "high" || reports[2].CodexDiagnostic.ErrorCode != "invalid_prompt" || reports[2].CodexDiagnostic.Result != "failed" {
		t.Fatalf("diagnostics not preserved: %+v %+v", reports[0].CodexDiagnostic, reports[2].CodexDiagnostic)
	}
}

func TestCodexWSInterruptedTurnIsReportedWithoutUsage(t *testing.T) {
	var reports []ReportDetails
	o := codexWSObserver{defaultModel: "gpt-6-astra", report: func(d ReportDetails) { reports = append(reports, d) }}
	o.request([]byte(`{"type":"response.create"}`))
	o.close()
	o.close()
	if len(reports) != 1 || reports[0].CodexDiagnostic.Result != "missing_completion" {
		t.Fatalf("missing disconnect diagnostic: %+v", reports)
	}
}

func TestCodexContinuityAndBoundExit(t *testing.T) {
	c := codexContinuity{}
	key := codexContinuityKey("card", "device", codexOpaqueHash("conversation"))
	if a, e := c.observe(key, 1, "a"); a || e {
		t.Fatal("first request is not a change")
	}
	if a, e := c.observe(key, 1, "b"); a || !e {
		t.Fatal("exit change missed")
	}
	if a, e := c.observe(key, 2, "b"); !a || e {
		t.Fatal("account change missed")
	}
	if a, e := c.observe(codexContinuityKey("another-card", "device", codexOpaqueHash("conversation")), 2, "b"); a || e {
		t.Fatal("cross-card continuity leak")
	}
	lease := &CodexTokenLease{AccountId: 1, EgressInfo: EgressInfo{ProxyURL: "http://exit:8080"}}
	bound := codexSessionLease(lease, "session")
	if lease.EgressRequired || !bound.EgressRequired {
		t.Fatal("session policy mutated shared lease")
	}
	seen := map[string][]byte{}
	trace := codexEgressTrace{}
	_, err := doCodexUpstream(bound, "direct", nil, mustReq(t, nil), clientFactory(map[string]bool{lease.ProxyURL: true}, seen), &trace)
	if err == nil || len(seen) != 1 || trace.Changed {
		t.Fatal("stateful conversation replayed across exits")
	}
	if trace.Fingerprint == "" || strings.Contains(trace.Fingerprint, "exit") {
		t.Fatal("missing or unsafe exit fingerprint")
	}
	h := http.Header{"Session-Id": []string{"raw-session"}}
	if codexSessionHash(h, nil) == "raw-session" || len(codexSessionHash(h, nil)) != 64 {
		t.Fatal("session metadata is not hashed")
	}
}

func TestCodexSessionCoolingPreservesBackoff(t *testing.T) {
	err := parseCodexSessionCooling(503, []byte(`{"code":"codex_session_cooling","retryAfterMs":1501}`))
	w := httptest.NewRecorder()
	if err == nil || !writeCodexSessionCooling(w, err) || w.Code != 503 || w.Header().Get("Retry-After") != "2" {
		t.Fatalf("backoff lost: %v %d %s", err, w.Code, w.Body.String())
	}
	if parseCodexSessionCooling(503, []byte(`{"code":"unrelated"}`)) != nil {
		t.Fatal("unrelated failure classified as session cooldown")
	}
}

func TestCodexWebSocketReportsBeforeConnectionCloses(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for i := 0; i < 2; i++ {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
			frame := `{"type":"response.completed","response":{"id":"resp_one","model":"gpt-6-astra","usage":{"input_tokens":20,"output_tokens":10}}}`
			if i == 1 {
				frame = `{"type":"response.failed","response":{"id":"resp_two","error":{"code":"invalid_prompt"}}}`
			}
			if err := conn.WriteMessage(websocket.TextMessage, []byte(frame)); err != nil {
				return
			}
		}
		_, _, _ = conn.ReadMessage()
	}))
	defer upstream.Close()
	reports := make(chan ReportDetails, 3)
	p := &CodexProxy{upstreamBase: upstream.URL, leaseToken: func(string, string, bool, map[string]interface{}, string) (*CodexTokenLease, error) {
		return &CodexTokenLease{AccessToken: forgeFakeCodexJWT("test"), AccountId: 1}, nil
	}, reportResult: func(_ string, _ string, d ReportDetails, _ string, _ *CodexTokenLease) { reports <- d }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { p.ServeHTTP(w, r, "card", "device", "") }))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial(strings.Replace(server.URL, "http://", "ws://", 1)+"/backend-api/codex/responses", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for i := 0; i < 2; i++ {
		if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.create","model":"gpt-6-astra"}`)); err != nil {
			t.Fatal(err)
		}
		if _, _, err := conn.ReadMessage(); err != nil {
			t.Fatal(err)
		}
		select {
		case report := <-reports:
			if i == 0 && report.RawTotalTokens != 30 {
				t.Fatalf("wrong usage %+v", report)
			}
			if i == 1 && report.CodexDiagnostic.ErrorCode != "invalid_prompt" {
				t.Fatalf("missing failure %+v", report)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("report waited for connection close")
		}
	}
}
