package main

import (
	"crypto/sha1"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"os"
	"strings"
)

// ─── 根 CA 指纹核对(修「同名孤儿 CA 误判已装 → 白屏」)纯逻辑,跨平台 ───────────
//
// 旧实现按 CN("BingchaAI Local Root")判断是否已装。但 CN 不唯一:CA 一旦重生成,信任库里
// 会留下同名、密钥不同(指纹不同)的旧孤儿根。仅比 CN 会把它误判成「当前 CA 已装」→ 跳过安装
// 且照样给 Chromium 开 --proxy-server → 当前 ca.key 签的叶证书验不过孤儿根 → 整页白屏。
//
// 这里改成按【当前 ca.crt 的 SHA-1 指纹】核对:库里必须存在指纹一致的那张,才算真·已装。
// 对不上 → 当作未装 → 走 mitmInstallCA(-f 覆盖)自愈。OS 侧(certutil / security)只负责取
// 命令输出,判定逻辑全在这里、可单测。

// mitmCASHA1FromPEM 解析 PEM 证书并返回其 SHA-1 指纹(归一化:小写、无分隔)。
func mitmCASHA1FromPEM(pemBytes []byte) (string, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return "", fmt.Errorf("decode CA cert PEM")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return "", fmt.Errorf("parse CA cert: %w", err)
	}
	sum := sha1.Sum(cert.Raw)
	return normalizeThumbprint(hex.EncodeToString(sum[:])), nil
}

// mitmCASHA1FromFile 读 ca.crt 文件并算其 SHA-1 指纹。文件不存在/不可读 → err(上层当作未装)。
func mitmCASHA1FromFile(certPath string) (string, error) {
	pemBytes, err := os.ReadFile(certPath)
	if err != nil {
		return "", err
	}
	return mitmCASHA1FromPEM(pemBytes)
}

// normalizeThumbprint 归一化指纹文本:转小写、去掉空白与冒号。
// 统一 certutil(可能空格分隔)、openssl/security(冒号分隔)、Go(无分隔)三种格式后再比对。
func normalizeThumbprint(s string) string {
	s = strings.ToLower(s)
	for _, sep := range []string{" ", ":", "\t", "\n", "\r"} {
		s = strings.ReplaceAll(s, sep, "")
	}
	return s
}

// certutilQueryShowsThumbprint 判定 Windows `certutil -store Root <CN>` 输出里是否含目标指纹。
// 归一化后做子串匹配 → 同名但指纹不同的孤儿根不会命中(正是要修的回归)。
// runErr != nil(找不到/出错)或空指纹一律判未装。
func certutilQueryShowsThumbprint(out []byte, runErr error, thumbprint string) bool {
	if runErr != nil {
		return false
	}
	want := normalizeThumbprint(thumbprint)
	if want == "" {
		return false
	}
	return strings.Contains(normalizeThumbprint(string(out)), want)
}

// securityCertSHA1s 从 macOS `security find-certificate -a -Z` 输出里抽出所有 "SHA-1 hash:" 指纹。
func securityCertSHA1s(out string) []string {
	const prefix = "SHA-1 hash:"
	var hashes []string
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, prefix) {
			if h := strings.TrimSpace(strings.TrimPrefix(line, prefix)); h != "" {
				hashes = append(hashes, h)
			}
		}
	}
	return hashes
}

// mitmDarwinThumbprintInstalled 判定 macOS 是否真·装了当前 CA:
// 必须同时满足 ① CN 在 admin 域信任设置里(dump-trust-settings 命中 cn,即被设为受信根);
//          ② 系统钥匙串里存在指纹 == 当前 ca.crt 的同名证书(find-certificate -Z 列出)。
// 仅① = 受信的可能是孤儿;仅② = 存在但未受信(Chromium 不认)。两者都满足才算装好。
//
// 已知边界:CLI 难以区分「同 CN 的多张证书各自的信任态」。若孤儿受信、当前 CA 也在钥匙串但
// 未单独受信,理论上会误判已装;实际 mitmInstallCA 用 add-trusted-cert 装当前 CA 时即赋予信任,
// 故「当前 CA 在钥匙串」基本等同「已受信」。这一改已能修掉主因(CA 重生成 → 当前指纹不在库 → 重装)。
func mitmDarwinThumbprintInstalled(findOut, dumpOut, thumbprint, cn string) bool {
	if !strings.Contains(dumpOut, cn) {
		return false
	}
	want := normalizeThumbprint(thumbprint)
	if want == "" {
		return false
	}
	for _, h := range securityCertSHA1s(findOut) {
		if normalizeThumbprint(h) == want {
			return true
		}
	}
	return false
}
