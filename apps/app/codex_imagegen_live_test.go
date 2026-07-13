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

// TestImageGenLiveE2E 用本地 ~/.codex/auth.json 真号 + GFA 的 uTLS 客户端,验证 ServeImages
// 的翻译路径(buildCodexImagesResponsesBody → /backend-api/codex/responses)真能出图:
// 收到 image_generation_call 流且 scanCodexImageStream 能抽出 base64 图。这是「远程生图真的
// 通」的端到端证明——确定性逻辑已由单测覆盖。
//
// 需真号+网络,默认跳过;跑:RUN_IMAGEGEN_E2E=1 go test ./ -run TestImageGenLiveE2E -v
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
	// 用生产翻译函数:模拟 /v1/images/generations 请求 → responses body(内联生图工具)。
	// 测的就是 ServeImages 走的这条翻译路径。
	imagesReq := []byte(`{"prompt":"Generate an image of a single red apple on a white background.","size":"1024x1024"}`)
	body := buildCodexImagesResponsesBody(imagesReq)
	if !strings.Contains(string(body), `"image_generation"`) {
		t.Fatalf("翻译未加生图工具:\n%s", body)
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

	// 读完整条流(图片是大 base64,末尾才到;上限 8MB 兜底)。
	buf := make([]byte, 0, 65536)
	tmp := make([]byte, 32768)
	deadline := time.Now().Add(80 * time.Second)
	for time.Now().Before(deadline) {
		n, e := resp.Body.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}
		if e != nil || len(buf) > 8<<20 {
			break
		}
	}
	got := string(buf)
	t.Logf("[imagegen-live] HTTP %d, %d bytes", resp.StatusCode, len(buf))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("HTTP %d:\n%s", resp.StatusCode, got[:min(len(got), 500)])
	}
	images, _ := scanCodexImageStream(buf)
	if len(images) == 0 || images[0].B64 == "" {
		t.Fatalf("未能从流里抽出图片(生图未成功):\n%s", got[:min(len(got), 800)])
	}
	t.Logf("[imagegen-live] 抽出 %d 张图, 首张 b64 长度=%d", len(images), len(images[0].B64))
}
