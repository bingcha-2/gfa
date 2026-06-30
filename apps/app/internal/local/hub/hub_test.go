package hub

import (
	"testing"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/instance"
)

// fakePlatform 记录注入/检测调用,供 hub 单测(不碰真实 app/IDE)。
type fakePlatform struct {
	codexInjected   bool
	codexInjectPort int
	ideInjectPort   int
	appPath         string
	launchedArgs    []string
}

func (f *fakePlatform) CodexInject(port int) error { f.codexInjectPort = port; f.codexInjected = true; return nil }
func (f *fakePlatform) CodexRestore() error        { f.codexInjected = false; return nil }
func (f *fakePlatform) CodexInjected() bool        { return f.codexInjected }
func (f *fakePlatform) AntigravityIDEInject(port int) error { f.ideInjectPort = port; return nil }
func (f *fakePlatform) AntigravityIDERestore() error        { return nil }
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

func TestHub_SetSourceCodex_InjectsViaPlatform(t *testing.T) {
	h, fp := newHub(t)
	if err := h.SetSource(account.ProviderCodex, "local"); err != nil {
		t.Fatalf("SetSource local: %v", err)
	}
	if !fp.codexInjected || fp.codexInjectPort == 0 {
		t.Fatalf("expected codex injected at gateway port, got injected=%v port=%d", fp.codexInjected, fp.codexInjectPort)
	}
	if h.GetSource(account.ProviderCodex) != "local" {
		t.Fatal("source should persist local")
	}
	if err := h.SetSource(account.ProviderCodex, "remote"); err != nil {
		t.Fatalf("SetSource remote: %v", err)
	}
	if fp.codexInjected {
		t.Fatal("expected codex restored on remote")
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
