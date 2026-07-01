package gateway

import (
	"testing"
	"time"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/routingcfg"
)

// 连通测试:网关在跑 → 收到 HTTP 响应(ok=true,有状态码与时延)。
func TestConnTest_RunningReturnsOK(t *testing.T) {
	dir := t.TempDir()
	acc, err := account.OpenStore(dir + "/a.db")
	if err != nil {
		t.Fatal(err)
	}
	defer acc.Close()

	g := NewShared(acc, dir, routingcfg.StrategyPriority)
	if _, err := g.Start(0); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer g.Stop()
	if !waitListening(g.Addr(), 5*time.Second) {
		t.Fatalf("gateway not listening on %s", g.Addr())
	}

	res := g.ConnTest()
	if !res.OK {
		t.Fatalf("conn test ok=false, err=%q status=%d", res.Err, res.Status)
	}
	if res.Status == 0 {
		t.Fatalf("expected a HTTP status, got 0 (err=%q)", res.Err)
	}
	if res.LatencyMs < 0 {
		t.Fatalf("negative latency %d", res.LatencyMs)
	}
}

// 网关未启动 → ok=false 且带错误,不 panic。
func TestConnTest_NotRunningReturnsErr(t *testing.T) {
	dir := t.TempDir()
	acc, err := account.OpenStore(dir + "/a.db")
	if err != nil {
		t.Fatal(err)
	}
	defer acc.Close()

	g := NewShared(acc, dir, routingcfg.StrategyPriority)
	res := g.ConnTest()
	if res.OK {
		t.Fatal("expected ok=false when gateway not running")
	}
	if res.Err == "" {
		t.Fatal("expected an error message when not running")
	}
}
