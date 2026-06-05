package main

import (
	"crypto/x509"
	"testing"
)

// 根 CA 现签的叶证书必须能用该根 CA 校验通过，且匹配请求的主机名——
// 这是 MITM（伪装 api.anthropic.com）能被客户端接受的根本前提。
func TestMitmLeafCertChainsToRoot(t *testing.T) {
	dir := t.TempDir()

	root, err := mitmEnsureRootAt(dir)
	if err != nil {
		t.Fatalf("mitmEnsureRootAt: %v", err)
	}

	lc := mitmNewLeafCache(root)
	tlsCert, err := lc.GetTLSCert("api.anthropic.com")
	if err != nil {
		t.Fatalf("GetTLSCert: %v", err)
	}
	if len(tlsCert.Certificate) == 0 {
		t.Fatal("leaf tls.Certificate has no DER bytes")
	}

	leaf, err := x509.ParseCertificate(tlsCert.Certificate[0])
	if err != nil {
		t.Fatalf("parse leaf: %v", err)
	}

	roots := x509.NewCertPool()
	roots.AddCert(root.Certificate)
	if _, err := leaf.Verify(x509.VerifyOptions{
		DNSName: "api.anthropic.com",
		Roots:   roots,
	}); err != nil {
		t.Fatalf("leaf does not verify against root: %v", err)
	}
}

// 同一 host 第二次取证书应命中缓存，返回同一实例。
func TestMitmLeafCacheReuse(t *testing.T) {
	root, err := mitmEnsureRootAt(t.TempDir())
	if err != nil {
		t.Fatalf("mitmEnsureRootAt: %v", err)
	}
	lc := mitmNewLeafCache(root)
	a, _ := lc.GetTLSCert("api.anthropic.com")
	b, _ := lc.GetTLSCert("api.anthropic.com")
	if a != b {
		t.Fatal("expected cached leaf cert to be reused (same pointer)")
	}
}

// 重复 EnsureRoot 应复用磁盘上已有的根 CA（证书 PEM 不变），不应每次重新生成。
func TestMitmEnsureRootPersists(t *testing.T) {
	dir := t.TempDir()
	r1, err := mitmEnsureRootAt(dir)
	if err != nil {
		t.Fatalf("first EnsureRoot: %v", err)
	}
	r2, err := mitmEnsureRootAt(dir)
	if err != nil {
		t.Fatalf("second EnsureRoot: %v", err)
	}
	if string(r1.CertPEM) != string(r2.CertPEM) {
		t.Fatal("EnsureRoot regenerated CA instead of loading persisted one")
	}
}
