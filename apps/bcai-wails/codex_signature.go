package main

import (
	"encoding/base64"
	"encoding/json"
	"strings"
)

// ─── Codex/GPT reasoning encrypted_content 清洗 ──────────────────────────────
//
// 透传真实 Codex 客户端到 chatgpt.com 时,请求体 input[] 里的 reasoning 项会带
// encrypted_content(上一轮 reasoning 的 Fernet 签名)。号池换号后,这段签名是
// 上一个账号的、对新账号无效,上游会直接报签名错误。转发前剔除非法/空白/非字符串
// 的 encrypted_content,只保留形状合法的,避免换号场景下的莫名 4xx。
//
// 对照 cockpit openai_responses_signature.go + signature/gpt_validation.go。
// 这里只做"传输层外壳"校验(base64url + gAAAA 前缀 + 解码后版本/长度),不证明可解密。

const maxGPTReasoningSignatureLen = 32 * 1024 * 1024

// isValidGPTReasoningSignature 校验 GPT/Codex reasoning encrypted_content 的外层
// Fernet 形状。非法返回原因字符串,合法返回 ""。
func gptReasoningSignatureReject(rawSignature string) string {
	sig := strings.TrimSpace(rawSignature)
	if sig == "" {
		return "empty GPT reasoning signature"
	}
	if len(sig) > maxGPTReasoningSignatureLen {
		return "GPT reasoning signature exceeds maximum length"
	}
	for _, r := range sig {
		switch {
		case r >= 'A' && r <= 'Z':
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case r == '-' || r == '_' || r == '=':
		default:
			return "contains non-base64url character"
		}
	}
	if !strings.HasPrefix(sig, "gAAAA") {
		return "expected gAAAA prefix"
	}
	decoded := decodeGPTReasoningSignature(sig)
	if decoded == nil {
		return "base64url decode failed"
	}
	if len(decoded) < 73 {
		return "decoded payload too short"
	}
	if decoded[0] != 0x80 {
		return "expected version 0x80"
	}
	// version(1) + timestamp(8) + IV(16) + HMAC(32) 之外是密文,必须是正的 AES 块整数倍。
	ciphertextLen := len(decoded) - 1 - 8 - 16 - 32
	if ciphertextLen <= 0 || ciphertextLen%16 != 0 {
		return "ciphertext length is not a positive AES block multiple"
	}
	return ""
}

func decodeGPTReasoningSignature(sig string) []byte {
	if decoded, err := base64.RawURLEncoding.DecodeString(sig); err == nil {
		return decoded
	}
	if decoded, err := base64.URLEncoding.DecodeString(sig); err == nil {
		return decoded
	}
	return nil
}

// sanitizeCodexReasoningEncryptedContent 剔除请求体里非法的 reasoning.encrypted_content。
// 同时兼容两种载荷:HTTP /responses 顶层 input[],与 WebSocket response.create 的
// response.input[]。返回清洗后的 body 与剔除条数;解析失败或无 input 时原样返回。
func sanitizeCodexReasoningEncryptedContent(body []byte) ([]byte, int) {
	if len(body) == 0 {
		return body, 0
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(body, &payload); err != nil {
		return body, 0
	}
	dropped := cleanReasoningInputField(payload)
	// WebSocket response.create:input 嵌在 response 下。
	if resp, ok := payload["response"].(map[string]interface{}); ok {
		dropped += cleanReasoningInputField(resp)
	}
	if dropped == 0 {
		return body, 0
	}
	out, err := json.Marshal(payload)
	if err != nil {
		return body, 0
	}
	return out, dropped
}

// cleanReasoningInputField 就地清洗 container["input"] 数组里非法的 reasoning
// encrypted_content,返回剔除条数。
func cleanReasoningInputField(container map[string]interface{}) int {
	input, ok := container["input"].([]interface{})
	if !ok {
		return 0
	}
	dropped := 0
	for _, raw := range input {
		item, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		if t, _ := item["type"].(string); strings.TrimSpace(t) != "reasoning" {
			continue
		}
		ec, exists := item["encrypted_content"]
		if !exists {
			continue
		}
		reject := false
		switch v := ec.(type) {
		case string:
			// 带首尾空白的也判非法(上游对原始串做严格校验)。
			if v != strings.TrimSpace(v) || gptReasoningSignatureReject(v) != "" {
				reject = true
			}
		case nil:
			reject = true
		default:
			reject = true
		}
		if reject {
			delete(item, "encrypted_content")
			dropped++
		}
	}
	return dropped
}
