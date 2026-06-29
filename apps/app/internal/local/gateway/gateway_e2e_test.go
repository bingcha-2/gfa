package gateway

import (
	"net/http"
	"testing"
	"time"

	"bcai-wails/internal/local/account"
)

// E2E(造数据):注入一个自有号进池,启动嵌入网关,打 OpenAI 兼容端点,
// 断言数据面真实可达(收到 HTTP 响应,而非连接拒绝)。证明
// 「自有号 → 本地网关 → /v1」整条数据面在进程内跑通。
func TestGateway_ServesV1WithOwnAccount(t *testing.T) {
	dir := t.TempDir()
	acc, err := account.OpenStore(dir + "/a.db")
	if err != nil {
		t.Fatal(err)
	}
	defer acc.Close()

	// 造数据:一个进池的自有号(占位 token;不依赖真实上游)。
	if err := acc.Add(&account.Account{
		Provider: account.ProviderCodex, Email: "fake@example.com", AuthKind: account.AuthOAuth,
		AccessToken: "fake-access", RefreshToken: "fake-refresh", IDToken: "fake-id",
		AccountID: "acct_fake", PlanType: "pro", PoolEnabled: true, QuotaStatus: account.QuotaOK,
	}); err != nil {
		t.Fatal(err)
	}

	g := New(acc, account.ProviderCodex, dir)
	if _, err := g.Start(0); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer g.Stop()

	if !waitListening(g.Addr(), 5*time.Second) {
		t.Fatalf("gateway not listening on %s", g.Addr())
	}

	// 自有号开机即入池(Start 内主动 Load)。安全不变式:只有 PoolEnabled 自有号进得来。
	if n := g.LoadedAuthCount(); n != 1 {
		t.Fatalf("expected 1 own account loaded into gateway, got %d", n)
	}

	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://" + g.Addr() + "/v1/models")
	if err != nil {
		t.Fatalf("gateway /v1/models unreachable: %v", err)
	}
	defer resp.Body.Close()
	// 数据面可达即通过(具体状态取决于鉴权/上游;关键是嵌入网关在进程内真实服务)。
	t.Logf("/v1/models status=%d", resp.StatusCode)
	if resp.StatusCode == 0 {
		t.Fatal("no HTTP status from gateway")
	}

	// 诊断:确认自有号是否真被加载进 auth manager。
	_ = g.Reload()
	t.Logf("loaded auth count (custom store) = %d", g.LoadedAuthCount())
}
