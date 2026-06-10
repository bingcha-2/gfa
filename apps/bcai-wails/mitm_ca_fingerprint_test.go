package main

import (
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"testing"
)

var errFakeExit = errors.New("exit status 1")

// ─── 指纹核对(修白屏根因)的纯逻辑单测,跨平台可跑 ──────────────────────────
//
// 根因:旧版 mitmIsCAInstalled 只比 CN("BingchaAI Local Root")。CA 重生成后,信任库里
// 同名但密钥不同(指纹不同)的孤儿 CA 会让它误判「已装」→ 跳过安装 + 照样开 --proxy-server
// → Chromium 用当前 ca.key 签的叶证书验不过那张孤儿根 → 整页 ERR_CERT_AUTHORITY_INVALID → 白屏。
// 修法:按【当前 ca.crt 的指纹】核对,同名孤儿骗不过。

func TestMitmCASHA1FromPEM_MatchesCryptoSHA1(t *testing.T) {
	root, err := mitmEnsureRootAt(t.TempDir())
	if err != nil {
		t.Fatalf("generate root: %v", err)
	}
	got, err := mitmCASHA1FromPEM(root.CertPEM)
	if err != nil {
		t.Fatalf("mitmCASHA1FromPEM: %v", err)
	}
	sum := sha1.Sum(root.Certificate.Raw)
	want := hex.EncodeToString(sum[:]) // 小写无分隔,与 normalizeThumbprint 输出一致
	if got != want {
		t.Fatalf("thumbprint = %q, want %q", got, want)
	}
}

func TestMitmCASHA1FromFile(t *testing.T) {
	dir := t.TempDir()
	root, err := mitmEnsureRootAt(dir)
	if err != nil {
		t.Fatalf("generate root: %v", err)
	}
	got, err := mitmCASHA1FromFile(mitmCACertPathIn(dir))
	if err != nil {
		t.Fatalf("mitmCASHA1FromFile: %v", err)
	}
	want, _ := mitmCASHA1FromPEM(root.CertPEM)
	if got != want {
		t.Fatalf("from file = %q, want %q", got, want)
	}
	if _, err := mitmCASHA1FromFile(mitmCACertPathIn(t.TempDir())); err == nil {
		t.Error("读不存在的 ca.crt 应报错")
	}
}

// 这是核心:两张不同的 CA(同 CN)指纹必须不同 —— 正是「孤儿 CA」场景。
func TestMitmCASHA1_DifferentRootsDiffer(t *testing.T) {
	a, _ := mitmEnsureRootAt(t.TempDir())
	b, _ := mitmEnsureRootAt(t.TempDir())
	fa, _ := mitmCASHA1FromPEM(a.CertPEM)
	fb, _ := mitmCASHA1FromPEM(b.CertPEM)
	if fa == "" || fb == "" {
		t.Fatal("指纹不应为空")
	}
	if fa == fb {
		t.Fatal("两张不同 CA 必须有不同指纹(否则孤儿 CA 检测失效)")
	}
}

func TestNormalizeThumbprint(t *testing.T) {
	want := "a22fde84d5c4f0588bbef718eac3ef78a7b064e5"
	cases := []string{
		"a22fde84d5c4f0588bbef718eac3ef78a7b064e5",
		"A22FDE84D5C4F0588BBEF718EAC3EF78A7B064E5",
		"a2 2f de 84 d5 c4 f0 58 8b be f7 18 ea c3 ef 78 a7 b0 64 e5", // certutil 带空格
		"a2:2f:de:84:d5:c4:f0:58:8b:be:f7:18:ea:c3:ef:78:a7:b0:64:e5", // openssl 带冒号
		"\ta22fde84d5c4f0588bbef718eac3ef78a7b064e5\n",
	}
	for _, in := range cases {
		if got := normalizeThumbprint(in); got != want {
			t.Errorf("normalizeThumbprint(%q) = %q, want %q", in, got, want)
		}
	}
}

// Windows:-store 输出里(归一化后)含当前指纹 = 已装;只含孤儿的不同指纹 = 未装(关键回归)。
func TestCertutilQueryShowsThumbprint(t *testing.T) {
	const tp = "a22fde84d5c4f0588bbef718eac3ef78a7b064e5"
	tests := []struct {
		name string
		out  string
		err  error
		want bool
	}{
		{"found contiguous", "Cert Hash(sha1): a22fde84d5c4f0588bbef718eac3ef78a7b064e5\n", nil, true},
		{"found spaced (certutil)", "证书哈希(sha1): a2 2f de 84 d5 c4 f0 58 8b be f7 18 ea c3 ef 78 a7 b0 64 e5\n", nil, true},
		{"orphan: same CN diff thumbprint", "Subject: CN=BingchaAI Local Root\nCert Hash(sha1): deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n", nil, false},
		{"non-zero exit", "CertUtil: -store command FAILED: 0x80092004", errFakeExit, false},
		{"empty thumbprint never matches", "anything", nil, false}, // 见下方 want 用空 tp 的子测试
	}
	for _, tt := range tests {
		if tt.name == "empty thumbprint never matches" {
			if certutilQueryShowsThumbprint([]byte(tt.out), tt.err, "") {
				t.Errorf("空指纹不应判为已装")
			}
			continue
		}
		if got := certutilQueryShowsThumbprint([]byte(tt.out), tt.err, tp); got != tt.want {
			t.Errorf("%s: certutilQueryShowsThumbprint = %v, want %v", tt.name, got, tt.want)
		}
	}
}

// darwin:security find-certificate -Z 输出里抽出所有 SHA-1 指纹。
func TestSecurityCertSHA1s(t *testing.T) {
	out := `keychain: "/Library/Keychains/System.keychain"
SHA-1 hash: A22FDE84D5C4F0588BBEF718EAC3EF78A7B064E5
SHA-256 hash: 1111111111111111111111111111111111111111111111111111111111111111
    "labl"<blob>="BingchaAI Local Root"
SHA-1 hash: DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF
`
	got := securityCertSHA1s(out)
	if len(got) != 2 {
		t.Fatalf("应抽出 2 个 SHA-1,got %d: %v", len(got), got)
	}
	if normalizeThumbprint(got[0]) != "a22fde84d5c4f0588bbef718eac3ef78a7b064e5" {
		t.Errorf("第一个指纹解析错: %q", got[0])
	}
}

// darwin 装机判定:CN 受信(dump 命中) 且 钥匙串里存在指纹匹配的同名证书。
func TestMitmDarwinThumbprintInstalled(t *testing.T) {
	const cn = "BingchaAI Local Root"
	const tp = "a22fde84d5c4f0588bbef718eac3ef78a7b064e5"
	findOurs := "SHA-1 hash: A22FDE84D5C4F0588BBEF718EAC3EF78A7B064E5\n"
	findOrphan := "SHA-1 hash: DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF\n"
	dumpTrusted := "Cert 0: BingchaAI Local Root\n"
	dumpUntrusted := "Cert 0: Some Other Root\n"

	if !mitmDarwinThumbprintInstalled(findOurs, dumpTrusted, tp, cn) {
		t.Error("受信 + 指纹匹配 → 应判已装")
	}
	if mitmDarwinThumbprintInstalled(findOrphan, dumpTrusted, tp, cn) {
		t.Error("受信但只有孤儿指纹(当前 CA 不在钥匙串) → 应判未装(关键回归)")
	}
	if mitmDarwinThumbprintInstalled(findOurs, dumpUntrusted, tp, cn) {
		t.Error("指纹匹配但 CN 未受信 → 应判未装(存在≠受信)")
	}
}
