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
