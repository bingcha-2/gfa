package gateway

import (
	"net"
	"testing"
	"time"

	"bcai-wails/internal/local/account"
)

// 验证嵌入的 CLIProxyAPI 真能起停(不只是编译)。
func TestGateway_StartStop(t *testing.T) {
	dir := t.TempDir()
	acc, err := account.OpenStore(dir + "/a.db")
	if err != nil {
		t.Fatal(err)
	}
	defer acc.Close()

	g := New(acc, account.ProviderCodex, dir)
	port, err := g.Start(0)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if port == 0 || !g.Running() {
		t.Fatalf("expected running gateway, port=%d running=%v", port, g.Running())
	}

	if !waitListening(g.Addr(), 5*time.Second) {
		t.Fatalf("gateway not listening on %s", g.Addr())
	}

	if err := g.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if g.Running() {
		t.Fatal("expected stopped")
	}
}

// 共享网关:同一实例同时喂 codex + antigravity 进池号。
func TestGateway_SharedServesBothProviders(t *testing.T) {
	dir := t.TempDir()
	acc, err := account.OpenStore(dir + "/a.db")
	if err != nil {
		t.Fatal(err)
	}
	defer acc.Close()
	_ = acc.Add(&account.Account{Provider: account.ProviderCodex, Email: "c@x.com", AuthKind: account.AuthOAuth,
		AccessToken: "at-c", RefreshToken: "rt-c", AccountID: "acc_c", PoolEnabled: true, QuotaStatus: account.QuotaOK})
	_ = acc.Add(&account.Account{Provider: account.ProviderAntigravity, Email: "a@x.com", AuthKind: account.AuthOAuth,
		AccessToken: "at-a", RefreshToken: "rt-a", AccountID: "acc_a", ProjectID: "p1", PoolEnabled: true, QuotaStatus: account.QuotaOK})

	g := NewShared(acc, dir)
	if _, err := g.Start(0); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer g.Stop()
	if !waitListening(g.Addr(), 5*time.Second) {
		t.Fatalf("shared gateway not listening on %s", g.Addr())
	}
	loaded := false
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		if g.LoadedAuthCount() == 2 {
			loaded = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !loaded {
		t.Fatalf("expected 2 cross-provider accounts loaded, got %d", g.LoadedAuthCount())
	}
}

// 固定默认端口被占用时回退到下一个空闲端口。
func TestGateway_StartFixedPortFallsBackWhenBusy(t *testing.T) {
	dir := t.TempDir()
	acc, err := account.OpenStore(dir + "/a.db")
	if err != nil {
		t.Fatal(err)
	}
	defer acc.Close()

	// 占住一个端口,要求网关从该端口起,验证它回退到别的空闲端口。
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	busy := l.Addr().(*net.TCPAddr).Port
	defer l.Close()

	g := NewShared(acc, dir)
	got, err := g.Start(busy)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer g.Stop()
	if got == busy {
		t.Fatalf("expected fallback off busy port %d, got same", busy)
	}
	if !waitListening(g.Addr(), 5*time.Second) {
		t.Fatalf("gateway not listening after fallback on %s", g.Addr())
	}
}

// SetPort 改端口并重启网关,新端口生效。
func TestGateway_SetPortRestarts(t *testing.T) {
	dir := t.TempDir()
	acc, err := account.OpenStore(dir + "/a.db")
	if err != nil {
		t.Fatal(err)
	}
	defer acc.Close()

	g := NewShared(acc, dir)
	p1, err := g.Start(0)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	want, err := freePort()
	if err != nil {
		t.Fatal(err)
	}
	got, err := g.SetPort(want)
	if err != nil {
		t.Fatalf("SetPort: %v", err)
	}
	if got != want || g.Port() != want {
		t.Fatalf("expected port %d, got %d (Port()=%d)", want, got, g.Port())
	}
	if got == p1 {
		t.Fatalf("expected new port, still %d", p1)
	}
	defer g.Stop()
	if !waitListening(g.Addr(), 5*time.Second) {
		t.Fatalf("gateway not listening after SetPort on %s", g.Addr())
	}
}

func waitListening(addr string, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if c, err := net.DialTimeout("tcp", addr, 200*time.Millisecond); err == nil {
			_ = c.Close()
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}
