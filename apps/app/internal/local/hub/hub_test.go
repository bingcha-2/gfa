package hub

import (
	"testing"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/instance"
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
func (f *fakePlatform) CodexAuthJSONPath() string        { return f.codexAuthPath }
func (f *fakePlatform) AntigravityReadIDEToken() (AntigravityToken, error) {
	return f.ideToken, f.ideTokenErr
}
func (f *fakePlatform) DetectAppPath(provider string) string { return f.appPath }
func (f *fakePlatform) LaunchApp(appPath, workingDir string, args []string) (int, error) {
	f.launchedArgs = args
	return 4321, nil
}
func (f *fakePlatform) StopProcess(pid int) error { return nil }

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
	if !h.GatewayStatusOf(account.ProviderCodex).Running {
		t.Fatal("gateway should run after explicit GatewayStart")
	}
}

// antigravity 'local' = 注入 IDE(不走网关):调 AntigravityInjectAccount,
// 且网关不应因接管 antigravity 而启动。
func TestHub_SetSourceAntigravity_InjectsAccountNotGateway(t *testing.T) {
	h, fp := newHub(t)
	// 造一个进池 antigravity 自有号(优先级)。
	_ = h.acc.Add(&account.Account{Provider: account.ProviderAntigravity, Email: "ag@x.com",
		AccessToken: "AT", RefreshToken: "RT", ProjectID: "proj", Expiry: 1893456000, IsGCPTos: true,
		PoolEnabled: true, Priority: true})
	if err := h.SetSource(account.ProviderAntigravity, "local"); err != nil {
		t.Fatalf("SetSource ag local: %v", err)
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
	// 还原:调 AntigravityRestoreAccount。
	if err := h.SetSource(account.ProviderAntigravity, "remote"); err != nil {
		t.Fatalf("SetSource ag remote: %v", err)
	}
	if fp.agRestoreCount < 1 {
		t.Fatal("expected antigravity restored on remote")
	}
}

// antigravity 'local' 无可用号时报错(且不注入)。
func TestHub_SetSourceAntigravity_NoAccountErrors(t *testing.T) {
	h, fp := newHub(t)
	if err := h.SetSource(account.ProviderAntigravity, "local"); err == nil {
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

func TestHub_InstanceLaunch_UsesPlatform(t *testing.T) {
	h, fp := newHub(t)
	fp.appPath = "/Applications/Codex.app"
	p, _ := h.InstanceCreate("codex", "工作", "/tmp/w", "", "--foo", "")
	if err := h.InstanceLaunch(p.ID); err != nil {
		t.Fatalf("Launch: %v", err)
	}
	got, _ := h.instances.Get(p.ID)
	if got.Pid != 4321 {
		t.Fatalf("expected pid 4321, got %d", got.Pid)
	}
	if len(fp.launchedArgs) != 2 || fp.launchedArgs[0] != "--user-data-dir=/tmp/w" || fp.launchedArgs[1] != "--foo" {
		t.Fatalf("launch args wrong: %v", fp.launchedArgs)
	}
}

func TestHub_InstanceLaunch_NoApp(t *testing.T) {
	h, _ := newHub(t)
	p, _ := h.InstanceCreate("codex", "x", "/tmp/x", "", "", "")
	if err := h.InstanceLaunch(p.ID); err == nil {
		t.Fatal("expected error when app not detected")
	}
}

func TestBuildInstanceLaunchArgs(t *testing.T) {
	args := BuildInstanceLaunchArgs(&instance.Profile{UserDataDir: "/d", ExtraArgs: "--a --b"})
	if len(args) != 3 || args[0] != "--user-data-dir=/d" || args[1] != "--a" || args[2] != "--b" {
		t.Fatalf("args wrong: %v", args)
	}
}
