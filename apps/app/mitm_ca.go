package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ─── Claude 桌面端接管：本地 MITM 根 CA + 叶证书 ─────────────────────────────
//
// 移植自 sibling 项目 reclaude-reverse internal/ca。生成一个自签根 CA，
// 为每个被拦截的 host 动态签发叶证书（由根 CA 签名）。根 CA 安装进系统信任库后，
// 客户端(Chromium/Node)即接受我们伪装的 api.anthropic.com 证书，从而解密其流量。

const (
	mitmCACommonName = "BingchaAI Local Root"
	mitmCAOrg        = "BingchaAI"
)

// caInstallResult 区分根 CA 安装的三种结局,供上层决定前端提示策略(跨平台共享类型)。
//   - caInstalledMachine: 装进【本机】根存储(LocalMachine),所有进程/用户上下文一律信任,
//     Chromium 必认 —— 最优,接管完整(含订阅等级改写),无需任何提示。
//   - caInstalledUser:    LocalMachine 失败后降级装进【当前用户】根存储(CurrentUser),免管理员、
//     免 UAC。多数机器 Chromium 信任;少数精简版/企业组策略机器不信 → claude.ai 被 MITM 后白屏。
//     故需提示用户:若打开后白屏,请关安全软件 / 以管理员身份运行后重新接管。
//   - caInstallFailed:    本机库 + 用户库均失败(通常被安全软件主动防御拦截)。不阻塞接管 ——
//     Node 侧推理靠 NODE_EXTRA_CA_CERTS 照走号池;仅 Chromium 侧订阅等级无法改写成 Max。
type caInstallResult int

const (
	caInstalledMachine caInstallResult = iota
	caInstalledUser
	caInstallFailed
)

// mitmRoot 持有根 CA 证书与私钥。
type mitmRoot struct {
	Certificate *x509.Certificate
	PrivateKey  *ecdsa.PrivateKey
	CertPEM     []byte
	KeyPEM      []byte
}

// mitmLeafCache 按 hostname 缓存动态签发的叶证书。
type mitmLeafCache struct {
	root  *mitmRoot
	mu    sync.RWMutex
	cache map[string]*tls.Certificate
}

// mitmCADir 返回根 CA 的存放目录（~/.bcai/mitm）。
func mitmCADir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".bcai", "mitm")
}

func mitmCACertPathIn(dir string) string { return filepath.Join(dir, "ca.crt") }
func mitmCAKeyPathIn(dir string) string  { return filepath.Join(dir, "ca.key") }

// mitmCACertPath 返回生产环境根 CA 证书路径（用于安装信任 / NODE_EXTRA_CA_CERTS）。
func mitmCACertPath() string { return mitmCACertPathIn(mitmCADir()) }

// mitmEnsureRoot 加载或生成生产环境的根 CA。
func mitmEnsureRoot() (*mitmRoot, error) { return mitmEnsureRootAt(mitmCADir()) }

// mitmEnsureRootAt 在指定目录加载已有根 CA，没有则生成并持久化（dir 可注入便于测试）。
func mitmEnsureRootAt(dir string) (*mitmRoot, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("create CA dir: %w", err)
	}
	if root, err := mitmLoadRoot(dir); err == nil {
		return root, nil
	}
	return mitmGenerateRoot(dir)
}

func mitmLoadRoot(dir string) (*mitmRoot, error) {
	certPEM, err := os.ReadFile(mitmCACertPathIn(dir))
	if err != nil {
		return nil, err
	}
	keyPEM, err := os.ReadFile(mitmCAKeyPathIn(dir))
	if err != nil {
		return nil, err
	}

	certBlock, _ := pem.Decode(certPEM)
	if certBlock == nil {
		return nil, fmt.Errorf("decode CA cert PEM")
	}
	cert, err := x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse CA cert: %w", err)
	}

	keyBlock, _ := pem.Decode(keyPEM)
	if keyBlock == nil {
		return nil, fmt.Errorf("decode CA key PEM")
	}
	key, err := x509.ParseECPrivateKey(keyBlock.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse CA key: %w", err)
	}

	return &mitmRoot{Certificate: cert, PrivateKey: key, CertPEM: certPEM, KeyPEM: keyPEM}, nil
}

func mitmGenerateRoot(dir string) (*mitmRoot, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate CA key: %w", err)
	}
	serial, err := mitmRandomSerial()
	if err != nil {
		return nil, err
	}

	template := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   mitmCACommonName,
			Organization: []string{mitmCAOrg},
		},
		NotBefore:             time.Now().Add(-1 * time.Hour),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            0,
		MaxPathLenZero:        true,
		SubjectKeyId:          mitmPublicKeySubjectKeyID(&key.PublicKey),
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, fmt.Errorf("create CA cert: %w", err)
	}
	cert, err := x509.ParseCertificate(certDER)
	if err != nil {
		return nil, fmt.Errorf("parse generated CA cert: %w", err)
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, fmt.Errorf("marshal CA key: %w", err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})

	if err := os.WriteFile(mitmCACertPathIn(dir), certPEM, 0644); err != nil {
		return nil, fmt.Errorf("write CA cert: %w", err)
	}
	if err := os.WriteFile(mitmCAKeyPathIn(dir), keyPEM, 0600); err != nil {
		return nil, fmt.Errorf("write CA key: %w", err)
	}

	return &mitmRoot{Certificate: cert, PrivateKey: key, CertPEM: certPEM, KeyPEM: keyPEM}, nil
}

// mitmNewLeafCache 创建一个由给定根 CA 背书的叶证书缓存。
func mitmNewLeafCache(root *mitmRoot) *mitmLeafCache {
	return &mitmLeafCache{root: root, cache: make(map[string]*tls.Certificate)}
}

// GetTLSCert 返回 hostname 对应的叶证书，未缓存则现签并缓存。
func (lc *mitmLeafCache) GetTLSCert(hostname string) (*tls.Certificate, error) {
	lc.mu.RLock()
	if entry, ok := lc.cache[hostname]; ok {
		lc.mu.RUnlock()
		return entry, nil
	}
	lc.mu.RUnlock()

	lc.mu.Lock()
	defer lc.mu.Unlock()
	if entry, ok := lc.cache[hostname]; ok {
		return entry, nil
	}
	tlsCert, err := lc.generateLeaf(hostname)
	if err != nil {
		return nil, err
	}
	lc.cache[hostname] = tlsCert
	return tlsCert, nil
}

func (lc *mitmLeafCache) generateLeaf(hostname string) (*tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := mitmRandomSerial()
	if err != nil {
		return nil, err
	}
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: hostname},
		DNSNames:     []string{hostname},
		NotBefore:    time.Now().Add(-1 * time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	certDER, err := x509.CreateCertificate(rand.Reader, template, lc.root.Certificate, &key.PublicKey, lc.root.PrivateKey)
	if err != nil {
		return nil, err
	}
	return &tls.Certificate{
		Certificate: [][]byte{certDER, lc.root.Certificate.Raw},
		PrivateKey:  key,
	}, nil
}

func mitmRandomSerial() (*big.Int, error) {
	return rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
}

func mitmPublicKeySubjectKeyID(pub *ecdsa.PublicKey) []byte {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return nil
	}
	hash := sha1.Sum(der)
	return hash[:]
}
