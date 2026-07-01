package hub

import (
	"testing"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/codexsettings"
)

// fakePlatform 记录注入/检测调用,供 hub 单测(不碰真实 app/IDE)。
type fakePlatform struct {
	codexInjectCount   int
	codexRestoreCount  int
	codexInjectedToken CodexToken
	agInjectCount      int
	agRestoreCount     int
	agInjectedToken    AntigravityToken
	appPath            string
	launchedArgs       []string
	codexAuthPath      string
	ideToken           AntigravityToken
	ideTokenErr        error

	agRunning             bool
	codexRestartCount     int
	restartSpecifiedCount int
	restartSpecifiedPath  string
	agAppStarts           []string
	agAppStops            []string
	agInjectVariant       string
}

func (f *fakePlatform) CodexInjectAccount(tok CodexToken) error {
	f.codexInjectCount++
	f.codexInjectedToken = tok
	return nil
}
func (f *fakePlatform) CodexRestoreAccount() error { f.codexRestoreCount++; return nil }
func (f *fakePlatform) AntigravityInjectAccount(tok AntigravityToken) error {
	f.agInjectCount++
	f.agInjectedToken = tok
	return nil
}
func (f *fakePlatform) AntigravityRestoreAccount() error { f.agRestoreCount++; return nil }
func (f *fakePlatform) AntigravityInjectAccountTo(variant string, tok AntigravityToken) error {
	f.agInjectCount++
	f.agInjectedToken = tok
	f.agInjectVariant = variant
	return nil
}
func (f *fakePlatform) AntigravityRestoreAccountFor(variant string) error {
	f.agRestoreCount++
	return nil
}
func (f *fakePlatform) AntigravityReadTokenFrom(variant string) (AntigravityToken, error) {
	return f.ideToken, f.ideTokenErr
}
func (f *fakePlatform) CodexAuthJSONPath() string { return f.codexAuthPath }
func (f *fakePlatform) AntigravityReadIDEToken() (AntigravityToken, error) {
	return f.ideToken, f.ideTokenErr
}
func (f *fakePlatform) DetectAppPath(provider string) string { return f.appPath }
func (f *fakePlatform) LaunchApp(appPath, workingDir string, args []string) (int, error) {
	f.launchedArgs = args
	return 4321, nil
}
func (f *fakePlatform) StopProcess(pid int) error { return nil }

func (f *fakePlatform) CodexRestartApp() error { f.codexRestartCount++; return nil }
func (f *fakePlatform) RestartSpecifiedApp(appPath string) error {
	f.restartSpecifiedCount++
	f.restartSpecifiedPath = appPath
	return nil
}

// 切号后自动重启当前注入目标 app 复用的三个原语(手动启停/聚焦面板已下线)。
func (f *fakePlatform) AntigravityAppRunning(variant string) bool { return f.agRunning }
func (f *fakePlatform) AntigravityAppStart(variant string) error {
	f.agAppStarts = append(f.agAppStarts, variant)
	return nil
}
func (f *fakePlatform) AntigravityAppStop(variant string) error {
	f.agAppStops = append(f.agAppStops, variant)
	return nil
}

func newHub(t *testing.T) (*Hub, *fakePlatform) {
	t.Helper()
	fp := &fakePlatform{}
	h, err := New(t.TempDir(), fp)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return h, fp
}

func TestHub_AccountLifecycleByProvider(t *testing.T) {
	h, _ := newHub(t)
	// 直接经 acc store 造一个 codex 自有号(登录走真实 OAuth,不在单测)
	_ = h.acc.Add(&account.Account{Provider: account.ProviderCodex, Email: "a@x.com", PoolEnabled: true})
	views, err := h.ListAccounts(account.ProviderCodex)
	if err != nil || len(views) != 1 || views[0].Email != "a@x.com" {
		t.Fatalf("ListAccounts wrong: %+v %v", views, err)
	}
	ag, _ := h.ListAccounts(account.ProviderAntigravity)
	if len(ag) != 0 {
		t.Fatalf("antigravity should be empty, got %d", len(ag))
	}
}

// codex 'local' = 注入式接管(写 auth.json),不经反代网关。
func TestHub_SetSourceCodex_InjectsAccountNotGateway(t *testing.T) {
	h, fp := newHub(t)
	_ = h.acc.Add(&account.Account{Provider: account.ProviderCodex, Email: "cx@x.com",
		AuthKind: account.AuthOAuth, AccessToken: "AT", RefreshToken: "RT", AccountID: "acc",
		PoolEnabled: true, Priority: true})
	if err := h.SetSource(account.ProviderCodex, "local"); err != nil {
		t.Fatalf("SetSource local: %v", err)
	}
	if fp.codexInjectCount != 1 {
		t.Fatalf("expected codex account injected once, got %d", fp.codexInjectCount)
	}
	if fp.codexInjectedToken.AccessToken != "AT" || fp.codexInjectedToken.AccountID != "acc" {
		t.Fatalf("injected codex token wrong: %+v", fp.codexInjectedToken)
	}
	// 接管不得启动反代网关(反代是单独功能)。
	if h.GatewayStatusOf(account.ProviderCodex).Running {
		t.Fatal("codex takeover must not start the reverse-proxy gateway")
	}
	if h.GetSource(account.ProviderCodex) != "local" {
		t.Fatal("source should persist local")
	}
	if err := h.SetSource(account.ProviderCodex, "remote"); err != nil {
		t.Fatalf("SetSource remote: %v", err)
	}
	if fp.codexRestoreCount < 1 {
		t.Fatal("expected codex restore on remote")
	}
}

// 反代网关独立于接管:GatewayStart 可单独开,与 SetSource 无关。
func TestHub_GatewayIndependentOfTakeover(t *testing.T) {
	h, _ := newHub(t)
	if _, err := h.GatewayStart(account.ProviderCodex); err != nil {
		t.Fatalf("GatewayStart: %v", err)
	}
	// 必须在 TempDir 清理前停网关:否则其后台 goroutine 会在 cleanup 时
	// 往临时目录写 gateway/auth,触发「directory not empty」清理竞态(flaky)。
	defer h.GatewayStop(account.ProviderCodex)
	if !h.GatewayStatusOf(account.ProviderCodex).Running {
		t.Fatal("gateway should run after explicit GatewayStart")
	}
}

// antigravity 本地接管 = 注入某 app 的 state.vscdb(不走网关):调 AntigravityInjectAccountTo,
// 且网关不应因接管 antigravity 而启动。
func TestHub_SetAntigravityLocalInjected_InjectsAccountNotGateway(t *testing.T) {
	h, fp := newHub(t)
	// 造一个进池 antigravity 自有号(优先级)。
	_ = h.acc.Add(&account.Account{Provider: account.ProviderAntigravity, Email: "ag@x.com",
		AccessToken: "AT", RefreshToken: "RT", ProjectID: "proj", Expiry: 1893456000, IsGCPTos: true,
		PoolEnabled: true, Priority: true})
	if err := h.SetAntigravityLocalInjected("ide", true); err != nil {
		t.Fatalf("inject ide: %v", err)
	}
	if fp.agInjectCount != 1 {
		t.Fatalf("expected antigravity account injected once, got %d", fp.agInjectCount)
	}
	if fp.agInjectedToken.Email != "ag@x.com" || fp.agInjectedToken.AccessToken != "AT" || fp.agInjectedToken.ProjectID != "proj" {
		t.Fatalf("injected token wrong: %+v", fp.agInjectedToken)
	}
	// 真实过期时刻与 GCP ToS 位要一路贯通到注入 token(否则 IDE 启动即强制刷新)。
	if fp.agInjectedToken.Expiry != 1893456000 || !fp.agInjectedToken.IsGCPTos {
		t.Fatalf("expiry/is_gcp_tos not threaded into injected token: %+v", fp.agInjectedToken)
	}
	if h.GatewayStatusOf(account.ProviderAntigravity).Running {
		t.Fatal("antigravity takeover must not start the reverse-proxy gateway")
	}
	// 派生 source:任一 app 注入后整卡为 local。
	if h.GetSource(account.ProviderAntigravity) != "local" {
		t.Fatalf("注入后 source 应派生为 local,got %q", h.GetSource(account.ProviderAntigravity))
	}
	// 关掉该 app:调 AntigravityRestoreAccountFor,全部关掉后 source 派生回 remote。
	if err := h.SetAntigravityLocalInjected("ide", false); err != nil {
		t.Fatalf("off ide: %v", err)
	}
	if fp.agRestoreCount < 1 {
		t.Fatal("expected antigravity restored on off")
	}
	if h.GetSource(account.ProviderAntigravity) != "remote" {
		t.Fatal("全部关掉后 source 应派生为 remote")
	}
}

// 切换接管源后重启对应客户端:antigravity 在跑则停+起(重读 state.vscdb);
// codex 仅当「切换时启动 Codex App」(LaunchOnSwitch)开启才重启 GUI。
func TestHub_RestartOnSwitch(t *testing.T) {
	h, fp := newHub(t)
	fp.agRunning = true
	_ = h.acc.Add(&account.Account{Provider: account.ProviderAntigravity, Email: "ag@x.com", AccessToken: "AT", PoolEnabled: true})
	if err := h.SetAntigravityLocalInjected("ide", true); err != nil {
		t.Fatalf("ag ide inject: %v", err)
	}
	// 该 app 在跑 → 重启它(经变体化 AppStop/AppStart)让它重读 state.vscdb。
	if len(fp.agAppStops) < 1 || len(fp.agAppStarts) < 1 || fp.agAppStarts[len(fp.agAppStarts)-1] != "ide" {
		t.Fatalf("antigravity 本地接管应重启该 app(stops=%v starts=%v)", fp.agAppStops, fp.agAppStarts)
	}

	// codex 默认 LaunchOnSwitch=true(对齐 cockpit)→ 切换应重启 GUI。
	_ = h.acc.Add(&account.Account{Provider: account.ProviderCodex, Email: "cx@x.com", AuthKind: account.AuthOAuth, AccessToken: "AT", PoolEnabled: true})
	if err := h.SetSource(account.ProviderCodex, "local"); err != nil {
		t.Fatalf("codex local: %v", err)
	}
	if fp.codexRestartCount < 1 {
		t.Fatalf("默认 LaunchOnSwitch=true 时切换应重启 codex GUI,got %d", fp.codexRestartCount)
	}

	// 关掉 LaunchOnSwitch → 再切换不应重启。
	if _, err := h.SaveCodexSettings(codexsettings.Settings{LaunchOnSwitch: false}); err != nil {
		t.Fatalf("SaveCodexSettings: %v", err)
	}
	before := fp.codexRestartCount
	if err := h.SetSource(account.ProviderCodex, "remote"); err != nil {
		t.Fatalf("codex remote: %v", err)
	}
	if fp.codexRestartCount != before {
		t.Fatalf("LaunchOnSwitch 关时不应重启 codex,got %d (was %d)", fp.codexRestartCount, before)
	}
}

// RestartAppOnSwitch + RestartAppPath:开关开 + 路径非空才联动重启指定应用(原为 dead config)。
func TestHub_SetSource_RestartsSpecifiedApp(t *testing.T) {
	h, fp := newHub(t)
	_ = h.acc.Add(&account.Account{Provider: account.ProviderCodex, Email: "cx@x.com", AuthKind: account.AuthOAuth, AccessToken: "AT", PoolEnabled: true})

	// 开关关:即使有路径也不重启指定应用。
	if _, err := h.SaveCodexSettings(codexsettings.Settings{RestartAppOnSwitch: false, RestartAppPath: "/Applications/Foo.app"}); err != nil {
		t.Fatalf("SaveCodexSettings: %v", err)
	}
	if err := h.SetSource(account.ProviderCodex, "local"); err != nil {
		t.Fatalf("local: %v", err)
	}
	if fp.restartSpecifiedCount != 0 {
		t.Fatalf("开关关时不应重启指定应用,got %d", fp.restartSpecifiedCount)
	}

	// 开关开 + 路径空:跳过(避免空路径误启)。
	if _, err := h.SaveCodexSettings(codexsettings.Settings{RestartAppOnSwitch: true, RestartAppPath: "  "}); err != nil {
		t.Fatalf("SaveCodexSettings: %v", err)
	}
	if err := h.SetSource(account.ProviderCodex, "remote"); err != nil {
		t.Fatalf("remote: %v", err)
	}
	if fp.restartSpecifiedCount != 0 {
		t.Fatalf("路径空时不应重启指定应用,got %d", fp.restartSpecifiedCount)
	}

	// 开关开 + 路径非空:重启,且把配置的路径透传下去。
	if _, err := h.SaveCodexSettings(codexsettings.Settings{RestartAppOnSwitch: true, RestartAppPath: "/Applications/Foo.app"}); err != nil {
		t.Fatalf("SaveCodexSettings: %v", err)
	}
	if err := h.SetSource(account.ProviderCodex, "local"); err != nil {
		t.Fatalf("local: %v", err)
	}
	if fp.restartSpecifiedCount != 1 || fp.restartSpecifiedPath != "/Applications/Foo.app" {
		t.Fatalf("应重启指定应用并透传路径,got count=%d path=%q", fp.restartSpecifiedCount, fp.restartSpecifiedPath)
	}
}

// 按 app 独立接管:IDE 与独立版各自可单独开/关,互不影响;source 随「任一注入」派生。
func TestHub_AntigravityPerAppInjection(t *testing.T) {
	h, fp := newHub(t)
	_ = h.acc.Add(&account.Account{Provider: account.ProviderAntigravity, Email: "ag@x.com",
		AccessToken: "AT", RefreshToken: "RT", ProjectID: "proj", PoolEnabled: true, Priority: true})
	// 默认两个 app 都未接管。
	if h.AntigravityLocalInjected("ide") || h.AntigravityLocalInjected("standalone") {
		t.Fatal("默认两个 app 都应未接管")
	}
	// 只接管独立版:注入落到 standalone 变体,IDE 不受影响。
	if err := h.SetAntigravityLocalInjected("standalone", true); err != nil {
		t.Fatalf("inject standalone: %v", err)
	}
	if fp.agInjectVariant != "standalone" {
		t.Fatalf("应注入到 standalone 变体,got %q", fp.agInjectVariant)
	}
	if !h.AntigravityLocalInjected("standalone") || h.AntigravityLocalInjected("ide") {
		t.Fatal("应只有独立版接管、IDE 仍未接管")
	}
	if h.GetSource(account.ProviderAntigravity) != "local" {
		t.Fatal("任一 app 接管后整卡 source 应为 local")
	}
	// 再接管 IDE:两个都接管,互不影响。
	if err := h.SetAntigravityLocalInjected("ide", true); err != nil {
		t.Fatalf("inject ide: %v", err)
	}
	if !h.AntigravityLocalInjected("ide") || !h.AntigravityLocalInjected("standalone") {
		t.Fatal("两个 app 应都接管")
	}
	// 关掉独立版:IDE 不受影响,source 仍为 local。
	if err := h.SetAntigravityLocalInjected("standalone", false); err != nil {
		t.Fatalf("off standalone: %v", err)
	}
	if h.AntigravityLocalInjected("standalone") || !h.AntigravityLocalInjected("ide") {
		t.Fatal("关独立版后应只剩 IDE 接管")
	}
	if h.GetSource(account.ProviderAntigravity) != "local" {
		t.Fatal("IDE 仍接管,source 应仍为 local")
	}
}

// antigravity 本地接管无可用号时报错(且不注入)。
func TestHub_AntigravityInject_NoAccountErrors(t *testing.T) {
	h, fp := newHub(t)
	if err := h.SetAntigravityLocalInjected("ide", true); err == nil {
		t.Fatal("expected error when no antigravity pool account")
	}
	if fp.agInjectCount != 0 {
		t.Fatal("must not inject when no account available")
	}
}

// 接管与网关解耦:codex 'remote' 还原不应停掉反代 tab 起的网关。
func TestHub_CodexRemote_DoesNotStopGateway(t *testing.T) {
	h, fp := newHub(t)
	_ = h.acc.Add(&account.Account{Provider: account.ProviderCodex, Email: "cx@x.com",
		AuthKind: account.AuthOAuth, AccessToken: "AT", PoolEnabled: true})
	if _, err := h.GatewayStart(account.ProviderCodex); err != nil {
		t.Fatalf("GatewayStart: %v", err)
	}
	defer h.GatewayStop(account.ProviderCodex)
	if err := h.SetSource(account.ProviderCodex, "local"); err != nil {
		t.Fatalf("SetSource codex local: %v", err)
	}
	if err := h.SetSource(account.ProviderCodex, "remote"); err != nil {
		t.Fatalf("SetSource codex remote: %v", err)
	}
	if fp.codexRestoreCount < 1 {
		t.Fatal("codex should be restored on remote")
	}
	if !h.GatewayStatusOf(account.ProviderCodex).Running {
		t.Fatal("gateway controlled by reverse-proxy tab must stay running after codex takeover restore")
	}
}

func TestHub_AddByToken_And_Edit(t *testing.T) {
	h, _ := newHub(t)
	v, err := h.AddByToken(account.ProviderCodex, "rt", "at", "m@x.com")
	if err != nil {
		t.Fatalf("AddByToken: %v", err)
	}
	if err := h.RenameAccount(v.ID, "主号"); err != nil {
		t.Fatalf("RenameAccount: %v", err)
	}
	if err := h.SetAccountNote(v.ID, "n"); err != nil {
		t.Fatalf("SetAccountNote: %v", err)
	}
	if err := h.SetAccountTags(v.ID, []string{"t1"}); err != nil {
		t.Fatalf("SetAccountTags: %v", err)
	}
	views, _ := h.ListAccounts(account.ProviderCodex)
	if len(views) != 1 || views[0].Name != "主号" || views[0].Note != "n" || len(views[0].Tags) != 1 {
		t.Fatalf("edit not applied: %+v", views)
	}
}

func TestHub_AddByAPIKey(t *testing.T) {
	h, _ := newHub(t)
	v, err := h.AddByAPIKey(account.ProviderAntigravity, "sk", "https://b", "k@x.com")
	if err != nil {
		t.Fatalf("AddByAPIKey: %v", err)
	}
	if v.AuthKind != "apikey" {
		t.Fatalf("authKind wrong: %+v", v)
	}
}

func TestHub_SetGatewayPort(t *testing.T) {
	h, _ := newHub(t)
	if _, err := h.GatewayStart(account.ProviderCodex); err != nil {
		t.Fatalf("GatewayStart: %v", err)
	}
	defer h.GatewayStop(account.ProviderCodex)
	want := h.GatewayStatusOf(account.ProviderCodex).Port + 1
	st, err := h.SetGatewayPort(want)
	if err != nil {
		t.Fatalf("SetGatewayPort: %v", err)
	}
	if st.Port == 0 {
		t.Fatalf("expected a port, got %+v", st)
	}
}
