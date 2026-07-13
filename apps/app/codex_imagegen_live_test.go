package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestImageGenLiveE2E 用本地 ~/.codex/auth.json 真号 + GFA 的 uTLS 客户端,验证
// ensureCodexImageGenerationTool 注入后打 chatgpt.com/backend-api/codex/responses
// 真能触发内联生图(收到 image_generation_call 事件流)。这是「远程生图真的通」的
// 唯一证明——确定性逻辑已由单测覆盖,此测证明端到端。
//
// 需真号+网络,默认跳过;跑:RUN_IMAGEGEN_E2E=1 go test ./ -run TestImageGenLiveE2E -v
// 模型用通用模型(默认 gpt-5.6-sol;spark 会被跳过且上游拒绝),可用 IMAGEGEN_E2E_MODEL 覆盖。
func TestImageGenLiveE2E(t *testing.T) {
	if os.Getenv("RUN_IMAGEGEN_E2E") != "1" {
		t.Skip("set RUN_IMAGEGEN_E2E=1 to run (needs real ~/.codex token + network)")
	}
	home, _ := os.UserHomeDir()
	raw, err := os.ReadFile(filepath.Join(home, ".codex", "auth.json"))
	if err != nil {
		t.Fatalf("read auth.json: %v", err)
	}
	var auth struct {
		Tokens struct {
			AccessToken string `json:"access_token"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(raw, &auth); err != nil {
		t.Fatalf("parse auth.json: %v", err)
	}
	at := auth.Tokens.AccessToken
	if at == "" {
		t.Fatal("no access_token in auth.json")
	}
	model := os.Getenv("IMAGEGEN_E2E_MODEL")
	if model == "" {
		model = "gpt-5.6-sol"
	}

	// 起始 body 不含生图工具;用生产注入函数加上它——测的就是这条注入路径。
	base, _ := json.Marshal(map[string]any{
		"model":  model,
		"stream": true,
		"store":  false,
		"input": []map[string]any{{
			"type": "message", "role": "user",
			"content": []map[string]any{{"type": "input_text", "text": "Generate an image of a single red apple on a white background."}},
		}},
	})
	body := ensureCodexImageGenerationTool(base, model, "pro")
	if !strings.Contains(string(body), `"image_generation"`) {
		t.Fatalf("注入函数未加生图工具:\n%s", body)
	}

	req, _ := http.NewRequest(http.MethodPost, DefaultCodexEndpoint+"/backend-api/codex/responses", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+at)
	req.Header.Set("Originator", codexDefaultOriginator)
	req.Header.Set("User-Agent", codexDefaultUserAgent)
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Content-Type", "application/json")
	if acc := extractChatGPTAccountId(at); acc != "" {
		req.Header.Set("ChatGPT-Account-Id", acc)
	}

	client := createCodexStreamingHttpClient("")
	client.Timeout = 90 * time.Second
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()

	buf := make([]byte, 0, 16384)
	tmp := make([]byte, 4096)
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		n, e := resp.Body.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}
		if len(buf) > 8000 || e != nil {
			break
		}
	}
	got := string(buf)
	t.Logf("[imagegen-live] HTTP %d, %d bytes", resp.StatusCode, len(buf))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("HTTP %d:\n%s", resp.StatusCode, got[:min(len(got), 500)])
	}
	if !strings.Contains(got, "image_generation_call") {
		t.Fatalf("未收到 image_generation_call 事件(生图未触发):\n%s", got[:min(len(got), 800)])
	}
}
