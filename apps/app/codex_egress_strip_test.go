package main

import (
	"net/http"
	"strings"
	"testing"
)

// 安全不变式:转发上游前必须剥离 x-oai-attestation(订户设备 DeviceCheck),
// 但其余业务头(originator/UA/账号/会话等)原样保留;凭证/host/长度头照旧剥离。
func TestCopyCodexHeaders_StripsAttestation(t *testing.T) {
	src := http.Header{}
	src.Set("X-Oai-Attestation", `{"v":1,"s":0,"t":"v1.opaque"}`)
	src.Set("Originator", "Codex Desktop")
	src.Set("User-Agent", "Codex Desktop/0.144.0-alpha.4")
	src.Set("ChatGPT-Account-Id", "acc-123")
	src.Set("Authorization", "Bearer leaked")
	src.Set("Host", "127.0.0.1")
	src.Set("Content-Length", "42")

	dst := http.Header{}
	copyCodexHeaders(dst, src)

	if dst.Get("X-Oai-Attestation") != "" {
		t.Fatalf("x-oai-attestation 必须被剥离,实得 %q", dst.Get("X-Oai-Attestation"))
	}
	// 大小写不敏感:确认真的没有任何形态残留。
	for k := range dst {
		if http.CanonicalHeaderKey(k) == "X-Oai-Attestation" {
			t.Fatalf("仍残留 attestation 头: %s", k)
		}
	}
	if got := dst.Get("Originator"); got != "Codex Desktop" {
		t.Errorf("originator 应保留, got %q", got)
	}
	if got := dst.Get("ChatGPT-Account-Id"); got != "acc-123" {
		t.Errorf("ChatGPT-Account-Id 应保留, got %q", got)
	}
	if dst.Get("Authorization") != "" || dst.Get("Host") != "" || dst.Get("Content-Length") != "" {
		t.Errorf("凭证/host/长度头必须被剥离")
	}
}

// 池号路径:桌面 app(src 带真 DeviceCheck)→ 出口回填「失败」信封 s:2(无 t),
// 既不泄漏设备绑定,又与桌面身份自洽;真 token 绝不外送。
func TestApplyCodexOfficialHeaders_DesktopRewritesToFailureEnvelope(t *testing.T) {
	src := http.Header{}
	src.Set("X-Oai-Attestation", `{"v":1,"s":0,"t":"v1.realDeviceToken"}`)
	src.Set("Originator", "Codex Desktop")

	dst := http.Header{}
	copyCodexHeaders(dst, src)          // 先剥真 token
	applyCodexOfficialHeaders(dst, src) // 再回填失败信封

	got := dst.Get("X-Oai-Attestation")
	if got != codexAttestationFailureEnvelope {
		t.Fatalf("桌面出口应回填失败信封 %q, got %q", codexAttestationFailureEnvelope, got)
	}
	if strings.Contains(got, "realDeviceToken") || strings.Contains(got, `"t"`) {
		t.Fatalf("失败信封不得含真 token 或 t 字段, got %q", got)
	}
}

// 无证明的客户端(如内置 CLI,src 不带 attestation)→ 出口也不带,保持其原生「无证明」形态,
// 不能凭空造一个失败信封让它变得像失败的桌面。
func TestApplyCodexOfficialHeaders_NoAttestationStaysAbsent(t *testing.T) {
	src := http.Header{}
	src.Set("User-Agent", "codex_cli_rs/0.144.0")

	dst := http.Header{}
	copyCodexHeaders(dst, src)
	applyCodexOfficialHeaders(dst, src)

	if got := dst.Get("X-Oai-Attestation"); got != "" {
		t.Fatalf("src 无证明时出口不应回填, got %q", got)
	}
	if got := dst.Get("User-Agent"); got != "codex_cli_rs/0.144.0" {
		t.Fatalf("官方出口应保留 Codex User-Agent, got %q", got)
	}
}

// 第三方中转站可能按 OpenAI SDK/Codex 的 UA 指纹触发 Cloudflare 403。
// 中转出口必须覆盖下游带来的 SDK UA,而不是仅在 UA 为空时补默认值。
func TestApplyCodexRelayHeaders_OverridesSDKUserAgent(t *testing.T) {
	src := http.Header{}
	src.Set("User-Agent", "OpenAI/Python 2.36.0")

	dst := http.Header{}
	applyCodexRelayHeaders(dst, src)

	if got := dst.Get("User-Agent"); got != codexRelayDefaultUserAgent {
		t.Fatalf("relay 出口应覆盖 SDK User-Agent, got %q", got)
	}
}
