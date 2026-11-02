package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/tidwall/gjson"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// Manual opt-in; never changes production routing or persists credentials/STATE.
// Uses account 32's upstream quota, without charging a customer subscription.
func TestCodexAccount32StateExperiment(t *testing.T) {
	if os.Getenv("GFA_STATE32_EXPERIMENT") != "run-once" {
		t.Skip("manual experiment disabled")
	}
	raw, err := os.ReadFile("D:/GFA-data/rosetta/codex-accounts.json")
	if err != nil {
		t.Fatal("cannot read account configuration")
	}
	var db struct {
		Accounts []struct {
			ID                   int
			Enabled              bool
			AccessToken          string
			ProxyURL             string
			AccessTokenExpiresAt int64
			CodexFingerprintMode string
			CodexFingerprintSeed string
		}
	}
	if json.Unmarshal(raw, &db) != nil {
		t.Fatal("invalid account configuration")
	}
	lease := &CodexTokenLease{AccountId: 32}
	for _, a := range db.Accounts {
		if a.ID != 32 {
			continue
		}
		if !a.Enabled || a.AccessTokenExpiresAt <= time.Now().UnixMilli() || a.AccessToken == "" || a.ProxyURL == "" {
			t.Fatal("account disabled, expired or missing bound credentials")
		}
		lease.AccessToken = a.AccessToken
		lease.ProxyURL = a.ProxyURL
		lease.EgressRequired = true
		if a.CodexFingerprintMode != "off" && a.CodexFingerprintSeed != "" {
			derive := func(label string) string {
				sum := sha256.Sum256([]byte("gfa:codex-fingerprint:v1:" + label + ":" + a.CodexFingerprintSeed))
				var id uuid.UUID
				copy(id[:], sum[:16])
				id[6] = (id[6] & 15) | 64
				id[8] = (id[8] & 63) | 128
				return id.String()
			}
			lease.Fingerprint = &CodexFingerprint{Mode: a.CodexFingerprintMode, InstallationID: derive("installation"), SessionID: derive("session"), Namespace: derive("namespace")}
		}
	}
	if lease.AccessToken == "" {
		t.Fatal("account 32 not found")
	}
	model := os.Getenv("GFA_STATE32_MODEL")
	if model == "" {
		model = "gpt-6-astra"
	}
	if model != "gpt-6-astra" && model != "gpt-5.6-sol" {
		t.Fatal("model outside experiment allowlist")
	}
	session := uuid.NewString()
	type observation struct {
		Arm         string `json:"arm"`
		Status      int    `json:"status"`
		Result      string `json:"result"`
		RequestID   string `json:"requestId,omitempty"`
		ResponseID  string `json:"responseId,omitempty"`
		Code        string `json:"code,omitempty"`
		Model       string `json:"model,omitempty"`
		StateBytes  int    `json:"stateBytes"`
		Injected    bool   `json:"injected"`
		DurationMS  int64  `json:"durationMs"`
		TotalTokens int64  `json:"totalTokens"`
		Correct     bool   `json:"correct"`
	}
	observations := []observation{}
	defer func() {
		data, _ := json.MarshalIndent(map[string]any{"accountId": 32, "model": model, "effort": "high", "observations": observations}, "", "  ")
		if p := os.Getenv("GFA_STATE32_REPORT"); p != "" {
			if os.WriteFile(p, data, 0600) != nil {
				t.Error("cannot save redacted report")
			}
		}
	}()
	for _, arm := range []string{"baseline"} {
		body := []byte(`{"model":"gpt-6-astra","store":false,"stream":true,"instructions":"Answer the arithmetic question with only the integer result.","reasoning":{"effort":"high"},"input":[{"role":"user","content":[{"type":"input_text","text":"What is 17 times 23?"}]}]}`)
		body = bytes.Replace(body, []byte("gpt-6-astra"), []byte(model), 1)
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		req, _ := http.NewRequestWithContext(ctx, "POST", "https://chatgpt.com/backend-api/codex/responses", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+lease.AccessToken)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "text/event-stream")
		req.Header.Set("Accept-Encoding", "identity")
		req.Header.Set("Session-Id", session)
		req.Header.Set("Session_id", session)
		applyCodexOfficialHeaders(req.Header, http.Header{})
		if id := extractChatGPTAccountId(lease.AccessToken); id != "" {
			req.Header.Set("ChatGPT-Account-Id", id)
		}
		body = prepareCodexFingerprintRequest(req, body, lease, session)
		req.GetBody = nil
		start := time.Now()
		resp, err := doCodexUpstream(lease, "direct", body, req, func(proxy string) *http.Client {
			c := createCodexStreamingHttpClient(proxy)
			cloned := *c
			cloned.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
			return &cloned
		})
		result := observation{Arm: arm, Injected: arm == "state-reuse"}
		if err != nil {
			result.Result = "transport_error"
			result.DurationMS = time.Since(start).Milliseconds()
			observations = append(observations, result)
			cancel()
			t.Log("transport failed (details suppressed)")
			break
		}
		candidate := resp.Header.Get("X-Codex-Turn-State")
		result.Status = resp.StatusCode
		result.StateBytes = len(candidate)
		d := codexStreamDiagnostic{SentModel: model}
		answer := ""
		decoder := codexEventDecoder{emit: func(_ string, p []byte) {
			d.observe(p)
			if gjson.GetBytes(p, "type").String() == "response.output_text.delta" {
				answer += gjson.GetBytes(p, "delta").String()
			}
			if _, _, _, total, ok := codexUsageFromJSON(p); ok {
				result.TotalTokens = total
			}
		}}
		count := 0
		buf := make([]byte, 16384)
		for {
			n, e := resp.Body.Read(buf)
			if n > 0 {
				count += n
				if count > 1024*1024 {
					result.Result = "observation_limit"
					break
				}
				decoder.write(buf[:n])
			}
			if e != nil {
				if e != io.EOF {
					result.Result = "stream_interrupted"
				}
				break
			}
		}
		decoder.finish()
		resp.Body.Close()
		cancel()
		if result.Result == "" {
			result.Result = d.metadata(result.Status, nil).Result
		}
		result.RequestID = resp.Header.Get("X-Request-Id")
		result.ResponseID = d.ResponseID
		result.Code = d.Code
		result.Model = d.UpstreamModel
		result.DurationMS = time.Since(start).Milliseconds()
		result.Correct = strings.TrimSpace(answer) == "391"
		observations = append(observations, result)
		safe, _ := json.Marshal(result)
		t.Log(string(safe))
		if result.Status != 200 || result.Result != "completed" || result.Model != model {
			t.Log("Rejected or incomplete arm; no retry/state reuse")
			break
		}
	}
}
