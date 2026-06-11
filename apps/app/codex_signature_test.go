package main

import (
	"encoding/base64"
	"encoding/json"
	"testing"
)

// validFernetSig 构造一个形状合法的 Fernet/GPT reasoning 签名:
// version(0x80) + ts(8) + IV(16) + ciphertext(16) + HMAC(32) = 73 字节,
// 首字节 0x80 后接零字节 → base64url 前缀为 "gAAAA"。
func validFernetSig() string {
	decoded := make([]byte, 73)
	decoded[0] = 0x80
	return base64.RawURLEncoding.EncodeToString(decoded)
}

func TestGPTReasoningSignatureReject(t *testing.T) {
	if r := gptReasoningSignatureReject(validFernetSig()); r != "" {
		t.Fatalf("valid signature rejected: %s", r)
	}
	cases := map[string]string{
		"empty":      "",
		"bad prefix": base64.RawURLEncoding.EncodeToString([]byte{0x80, 0x01, 0x02}), // 不以 gAAAA 开头/太短
		"non-b64url": "gAAAA!!!",
		"too short":  "gAAAAAAA",
	}
	for name, sig := range cases {
		if gptReasoningSignatureReject(sig) == "" {
			t.Errorf("%s: expected rejection, got accept", name)
		}
	}
}

func TestSanitizeCodexReasoningEncryptedContent(t *testing.T) {
	valid := validFernetSig()

	t.Run("valid kept", func(t *testing.T) {
		body := []byte(`{"input":[{"type":"reasoning","encrypted_content":"` + valid + `"}]}`)
		out, dropped := sanitizeCodexReasoningEncryptedContent(body)
		if dropped != 0 {
			t.Fatalf("valid content dropped=%d", dropped)
		}
		if string(out) != string(body) {
			t.Fatalf("body mutated unexpectedly: %s", out)
		}
	})

	t.Run("invalid dropped, other fields preserved", func(t *testing.T) {
		body := []byte(`{"model":"gpt-5-codex","input":[{"type":"reasoning","id":"r1","encrypted_content":"not-valid"}]}`)
		out, dropped := sanitizeCodexReasoningEncryptedContent(body)
		if dropped != 1 {
			t.Fatalf("dropped=%d want 1", dropped)
		}
		var m map[string]interface{}
		if err := json.Unmarshal(out, &m); err != nil {
			t.Fatalf("output not valid json: %v", err)
		}
		if m["model"] != "gpt-5-codex" {
			t.Errorf("model field lost: %v", m["model"])
		}
		item := m["input"].([]interface{})[0].(map[string]interface{})
		if _, ok := item["encrypted_content"]; ok {
			t.Errorf("encrypted_content not removed")
		}
		if item["id"] != "r1" {
			t.Errorf("sibling field id lost")
		}
	})

	t.Run("null and whitespace dropped", func(t *testing.T) {
		body := []byte(`{"input":[{"type":"reasoning","encrypted_content":null},{"type":"reasoning","encrypted_content":" ` + valid + `"}]}`)
		_, dropped := sanitizeCodexReasoningEncryptedContent(body)
		if dropped != 2 {
			t.Fatalf("dropped=%d want 2 (null + whitespace)", dropped)
		}
	})

	t.Run("non-reasoning item untouched", func(t *testing.T) {
		body := []byte(`{"input":[{"type":"message","encrypted_content":"not-valid"}]}`)
		_, dropped := sanitizeCodexReasoningEncryptedContent(body)
		if dropped != 0 {
			t.Fatalf("non-reasoning item touched: dropped=%d", dropped)
		}
	})

	t.Run("websocket response.create envelope", func(t *testing.T) {
		body := []byte(`{"type":"response.create","response":{"input":[{"type":"reasoning","encrypted_content":"bad"}]}}`)
		_, dropped := sanitizeCodexReasoningEncryptedContent(body)
		if dropped != 1 {
			t.Fatalf("ws envelope dropped=%d want 1", dropped)
		}
	})

	t.Run("malformed body returned as-is", func(t *testing.T) {
		body := []byte(`not json`)
		out, dropped := sanitizeCodexReasoningEncryptedContent(body)
		if dropped != 0 || string(out) != string(body) {
			t.Fatalf("malformed body altered")
		}
	})
}
