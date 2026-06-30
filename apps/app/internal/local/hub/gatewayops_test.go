package hub

import (
	"testing"

	"bcai-wails/internal/local/routingcfg"
)

func TestHub_RoutingStrategyDefaultAndSet(t *testing.T) {
	h, _ := newHub(t)
	if got := h.GetRoutingStrategy(); got != string(routingcfg.StrategyPriority) {
		t.Fatalf("default routing = %q, want priority", got)
	}
	if err := h.SetRoutingStrategy("round-robin"); err != nil {
		t.Fatalf("SetRoutingStrategy: %v", err)
	}
	if got := h.GetRoutingStrategy(); got != string(routingcfg.StrategyRoundRobin) {
		t.Fatalf("after set routing = %q, want round-robin", got)
	}
}

func TestHub_RoutingStrategyRejectsUnknown(t *testing.T) {
	h, _ := newHub(t)
	if err := h.SetRoutingStrategy("bogus"); err == nil {
		t.Fatal("expected error on unknown strategy")
	}
}

func TestHub_GatewayKeysCRUD(t *testing.T) {
	h, _ := newHub(t)
	if len(h.ListGatewayKeys()) != 0 {
		t.Fatal("expected no keys initially")
	}
	k, err := h.CreateGatewayKey("laptop")
	if err != nil {
		t.Fatalf("CreateGatewayKey: %v", err)
	}
	if k.Name != "laptop" || k.Value == "" {
		t.Fatalf("bad key %+v", k)
	}
	if len(h.ListGatewayKeys()) != 1 {
		t.Fatal("expected 1 key after create")
	}
	rotated, err := h.RotateGatewayKey(k.ID)
	if err != nil {
		t.Fatalf("RotateGatewayKey: %v", err)
	}
	if rotated.Value == k.Value {
		t.Fatal("rotate should change value")
	}
	if err := h.DeleteGatewayKey(k.ID); err != nil {
		t.Fatalf("DeleteGatewayKey: %v", err)
	}
	if len(h.ListGatewayKeys()) != 0 {
		t.Fatal("expected 0 keys after delete")
	}
}

func TestHub_AccessScopeDefaultLocalAndSet(t *testing.T) {
	h, _ := newHub(t)
	if got := h.GetGatewayAccessScope(); got != "local" {
		t.Fatalf("default scope = %q, want local (本机)", got)
	}
	if err := h.SetGatewayAccessScope("lan"); err != nil {
		t.Fatalf("SetGatewayAccessScope: %v", err)
	}
	if got := h.GetGatewayAccessScope(); got != "lan" {
		t.Fatalf("after set scope = %q, want lan", got)
	}
}

func TestHub_AccessScopeRejectsUnknown(t *testing.T) {
	h, _ := newHub(t)
	if err := h.SetGatewayAccessScope("internet"); err == nil {
		t.Fatal("expected error on unknown scope")
	}
}

func TestHub_QueryGatewayLogsAndClear(t *testing.T) {
	h, _ := newHub(t)
	// 无请求时:空页,total=0,不报错。
	page, err := h.QueryGatewayLogs(0, 10, "")
	if err != nil {
		t.Fatalf("QueryGatewayLogs: %v", err)
	}
	if page.Total != 0 {
		t.Fatalf("expected empty logs, total=%d", page.Total)
	}
	if err := h.ClearGatewayStats(); err != nil {
		t.Fatalf("ClearGatewayStats: %v", err)
	}
}

func TestHub_QueryGatewayLogsBadFilterJSON(t *testing.T) {
	h, _ := newHub(t)
	if _, err := h.QueryGatewayLogs(0, 10, "{not json"); err == nil {
		t.Fatal("expected error on malformed filter json")
	}
}

func TestHub_GatewayConnTestNotRunning(t *testing.T) {
	h, _ := newHub(t)
	res := h.GatewayConnTest()
	if res.OK {
		t.Fatal("expected ok=false when gateway not running")
	}
}
