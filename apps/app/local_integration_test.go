package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/economy"
	"bcai-wails/internal/local/takeover"
)

// 本地接管「接管中心」全链路集成测试 —— 不 mock,跑真 hub→manager→store→平台。
//
// 每条用例用 t.TempDir 隔离 HOME(getAppDataDir → 临时本地库)与 CODEX_HOME
// (codexinject / codexsettings 落盘目标),再新建 App 经真实 Wails 绑定端到端驱动。
// localHub 是包级懒初始化单例,故每条用例必须先 resetLocalSingleton() 让它在新
// HOME 下重建,否则会复用上一条用例的库。

// resetLocalSingleton 把 local_bindings.go 的懒初始化单例清零,
// 使下一次 ensureLocal() 在当前(临时)HOME 下重建 hub。
func resetLocalSingleton() {
	localOnce = sync.Once{}
	localHub = nil
	localErr = nil
}

// localTestEnv 隔离 HOME + CODEX_HOME 并重置单例,返回 codex home 目录。
func localTestEnv(t *testing.T) (codexHome string) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	codexHome = filepath.Join(t.TempDir(), "codex")
	t.Setenv("CODEX_HOME", codexHome)
	resetLocalSingleton()
	t.Cleanup(resetLocalSingleton)
	return codexHome
}

// TestLocal_CodexTakeoverInjectionEndToEnd 端到端跑接管注入主链路:
// LocalAddCodexToken → LocalListCodexAccounts → LocalSetCodexSource("local")
// → 真去读 $CODEX_HOME/auth.json 断言注入了刚加的 OAuth 自有号;
// 再 LocalSetCodexSource("remote") 断言注入被撤销(还原为不存在)。
func TestLocal_CodexTakeoverInjectionEndToEnd(t *testing.T) {
	codexHome := localTestEnv(t)
	app := NewApp()

	const (
		refreshTok = "rt-int-codex-xyz"
		accessTok  = "at-int-codex-abc"
		email      = "codex-int@example.com"
	)

	// 1) 经真实绑定加一份 OAuth 自有号(manager.AddByToken 默认进池)。
	view, err := app.LocalAddCodexToken(refreshTok, accessTok, email)
	if err != nil {
		t.Fatalf("LocalAddCodexToken 失败: %v", err)
	}
	if view.ID == "" || view.Email != email || view.AuthKind != string(account.AuthOAuth) {
		t.Fatalf("加号回视图异常: %+v", view)
	}
	if !view.PoolEnabled {
		t.Fatalf("新加自有号应默认进池,实际 PoolEnabled=false")
	}

	// 2) 回读账号列表确认已落 store(真 hub→manager→account.Store SQLite)。
	list, err := app.LocalListCodexAccounts()
	if err != nil {
		t.Fatalf("LocalListCodexAccounts 失败: %v", err)
	}
	if len(list) != 1 || list[0].ID != view.ID {
		t.Fatalf("列表应恰有刚加的 1 个号,实际: %+v", list)
	}

	authPath := filepath.Join(codexHome, "auth.json")
	if _, err := os.Stat(authPath); !os.IsNotExist(err) {
		t.Fatalf("接管前 %s 不应存在 (err=%v)", authPath, err)
	}

	// 3) 切到本地接管:平台 CodexInjectAccount 真写 $CODEX_HOME/auth.json。
	if err := app.LocalSetCodexSource("local"); err != nil {
		t.Fatalf("LocalSetCodexSource(local) 失败: %v", err)
	}
	if got := app.LocalGetCodexSource(); got != string(takeover.SourceLocal) {
		t.Fatalf("接管后 source = %q, 期望 local", got)
	}

	// 4) 真去读注入的 auth.json,断言写入了刚加号的 access/refresh token。
	raw, err := os.ReadFile(authPath)
	if err != nil {
		t.Fatalf("接管后读取 %s 失败: %v", authPath, err)
	}
	var auth struct {
		OpenAIAPIKey any `json:"OPENAI_API_KEY"`
		Tokens       *struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
		} `json:"tokens"`
		LastRefresh string `json:"last_refresh"`
	}
	if err := json.Unmarshal(raw, &auth); err != nil {
		t.Fatalf("auth.json 解析失败: %v\n内容: %s", err, raw)
	}
	if auth.Tokens == nil {
		t.Fatalf("OAuth 注入应含 tokens 块,实际: %s", raw)
	}
	if auth.Tokens.AccessToken != accessTok {
		t.Errorf("注入 access_token = %q, 期望 %q", auth.Tokens.AccessToken, accessTok)
	}
	if auth.Tokens.RefreshToken != refreshTok {
		t.Errorf("注入 refresh_token = %q, 期望 %q", auth.Tokens.RefreshToken, refreshTok)
	}
	if auth.OpenAIAPIKey != nil {
		t.Errorf("OAuth 注入 OPENAI_API_KEY 应为 null,实际 %v", auth.OpenAIAPIKey)
	}
	if auth.LastRefresh == "" {
		t.Errorf("注入应带 last_refresh 防一启动强刷")
	}

	// 5) 撤接管(remote):无注入前备份 → 还原即删除 auth.json。
	if err := app.LocalSetCodexSource("remote"); err != nil {
		t.Fatalf("LocalSetCodexSource(remote) 失败: %v", err)
	}
	if got := app.LocalGetCodexSource(); got != string(takeover.SourceRemote) {
		t.Fatalf("撤接管后 source = %q, 期望 remote", got)
	}
	if _, err := os.Stat(authPath); !os.IsNotExist(err) {
		t.Fatalf("撤接管后 %s 应被还原删除 (err=%v)", authPath, err)
	}
}

// TestLocal_CodexQuickConfigEndToEnd 端到端跑 codexsettings 快捷配置写读链路:
// hub.SaveCodexQuickConfig 结构保留地改写 $CODEX_HOME/config.toml 两个顶层整数键,
// 再 GetCodexQuickConfig / 真去读 config.toml 断言落盘;nil 删键回到未设置。
// (QuickConfig 无独立 App 绑定,前端经 hub 直读,此处驱动同一条真实链路。)
func TestLocal_CodexQuickConfigEndToEnd(t *testing.T) {
	codexHome := localTestEnv(t)
	if err := ensureLocal(); err != nil {
		t.Fatalf("ensureLocal 失败: %v", err)
	}

	cfgPath := filepath.Join(codexHome, "config.toml")

	cw := int64(1000000) // 1M 上下文,触发 ContextWindow1M 检测
	acl := int64(180000)
	saved, err := localHub.SaveCodexQuickConfig(&cw, &acl)
	if err != nil {
		t.Fatalf("SaveCodexQuickConfig 失败: %v", err)
	}
	if !saved.ContextWindow1M {
		t.Fatalf("model_context_window=1_000_000 应判定 ContextWindow1M=true,实际: %+v", saved)
	}
	if saved.DetectedModelContextWindow == nil || *saved.DetectedModelContextWindow != cw {
		t.Fatalf("回写 DetectedModelContextWindow = %v, 期望 %d", saved.DetectedModelContextWindow, cw)
	}
	if saved.AutoCompactTokenLimit != acl {
		t.Fatalf("回写 AutoCompactTokenLimit = %d, 期望 %d", saved.AutoCompactTokenLimit, acl)
	}
	if saved.DetectedAutoCompactTokenLimit == nil || *saved.DetectedAutoCompactTokenLimit != acl {
		t.Fatalf("回写 DetectedAutoCompactTokenLimit = %v, 期望 %d", saved.DetectedAutoCompactTokenLimit, acl)
	}

	// 真去读 config.toml 确认两个键落盘。
	tomlRaw, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("读取 config.toml 失败: %v", err)
	}
	toml := string(tomlRaw)
	if !strings.Contains(toml, "model_context_window") || !strings.Contains(toml, "1000000") {
		t.Errorf("config.toml 未含 model_context_window=1000000:\n%s", toml)
	}
	if !strings.Contains(toml, "model_auto_compact_token_limit") || !strings.Contains(toml, "180000") {
		t.Errorf("config.toml 未含 model_auto_compact_token_limit=180000:\n%s", toml)
	}

	// 经 Get 回读一致(新 Load,确认从磁盘读而非内存缓存)。
	got, err := localHub.GetCodexQuickConfig()
	if err != nil {
		t.Fatalf("GetCodexQuickConfig 失败: %v", err)
	}
	if got.DetectedModelContextWindow == nil || *got.DetectedModelContextWindow != cw {
		t.Errorf("GetCodexQuickConfig DetectedModelContextWindow = %v, 期望 %d", got.DetectedModelContextWindow, cw)
	}

	// nil 删键:autoCompact 置 nil,contextWindow 保留。
	if _, err := localHub.SaveCodexQuickConfig(&cw, nil); err != nil {
		t.Fatalf("SaveCodexQuickConfig(删 autoCompact) 失败: %v", err)
	}
	after, err := localHub.GetCodexQuickConfig()
	if err != nil {
		t.Fatalf("GetCodexQuickConfig(删后) 失败: %v", err)
	}
	if after.DetectedAutoCompactTokenLimit != nil {
		t.Errorf("删键后 DetectedAutoCompactTokenLimit 应为 nil,实际 %v", *after.DetectedAutoCompactTokenLimit)
	}
	if after.DetectedModelContextWindow == nil || *after.DetectedModelContextWindow != cw {
		t.Errorf("删 autoCompact 不应影响 contextWindow,实际 %v", after.DetectedModelContextWindow)
	}
}

// TestLocal_EconomyAlertEndToEnd 端到端跑「超额预警」判定链路:
// LocalAddCodexToken 加一份号(默认剩余额度百分比 0 ≈ 见底)→ LocalSetAlertConfig
// 开启阈值 20 → LocalEvaluateCodexAlert 经 hub.EvaluateAlert→economy.ShouldAlert
// 真判定应报警;关闭预警则不报。无 mock,走真 account.Store 适配。
func TestLocal_EconomyAlertEndToEnd(t *testing.T) {
	localTestEnv(t)
	app := NewApp()

	if _, err := app.LocalAddCodexToken("rt-econ", "at-econ", "econ@example.com"); err != nil {
		t.Fatalf("LocalAddCodexToken 失败: %v", err)
	}

	// 预警关闭(默认)时不应报警。
	off, err := app.LocalEvaluateCodexAlert()
	if err != nil {
		t.Fatalf("LocalEvaluateCodexAlert(关闭) 失败: %v", err)
	}
	if off.Alert {
		t.Fatalf("预警未开启时不应报警,实际: %+v", off)
	}

	// 开启阈值 20:新号剩余百分比 0 <= 20,应报警。
	saved, err := app.LocalSetAlertConfig(economy.AlertConfig{Enabled: true, ThresholdPct: 20})
	if err != nil {
		t.Fatalf("LocalSetAlertConfig 失败: %v", err)
	}
	if !saved.Enabled || saved.ThresholdPct != 20 {
		t.Fatalf("预警配置落盘异常: %+v", saved)
	}

	on, err := app.LocalEvaluateCodexAlert()
	if err != nil {
		t.Fatalf("LocalEvaluateCodexAlert(开启) 失败: %v", err)
	}
	if !on.Alert {
		t.Fatalf("剩余百分比 0 <= 阈值 20 应报警,实际: %+v", on)
	}
	if on.LowestPercentage != 0 {
		t.Errorf("最低剩余百分比 = %d, 期望 0", on.LowestPercentage)
	}
	if len(on.LowModels) == 0 {
		t.Errorf("应至少命中一个窗口,LowModels 为空")
	}

	// 配置持久化:经新 App + 新单例从同一 HOME 回读应保留。
	resetLocalSingleton()
	app2 := NewApp()
	reloaded, err := app2.LocalGetAlertConfig()
	if err != nil {
		t.Fatalf("LocalGetAlertConfig(重载) 失败: %v", err)
	}
	if !reloaded.Enabled || reloaded.ThresholdPct != 20 {
		t.Errorf("预警配置重载丢失: %+v", reloaded)
	}
}

// TestLocal_AccountGroupAssignEndToEnd 端到端跑「分组建/归组后列表 + 解析」链路:
// 加两份 codex 自有号 → LocalCreateAccountGroup 建组 → LocalAssignAccountsToGroup
// 把两号归组 → LocalListAccountGroups 断言成员落库 → LocalResolveAccountGroups
// 断言 账号→组名 反查;再把其中一号改归新组,断言 Assign 的独占语义(一号只属一组)。
func TestLocal_AccountGroupAssignEndToEnd(t *testing.T) {
	localTestEnv(t)
	app := NewApp()

	a1, err := app.LocalAddCodexToken("rt-grp-1", "at-grp-1", "grp1@example.com")
	if err != nil {
		t.Fatalf("LocalAddCodexToken(1) 失败: %v", err)
	}
	a2, err := app.LocalAddCodexToken("rt-grp-2", "at-grp-2", "grp2@example.com")
	if err != nil {
		t.Fatalf("LocalAddCodexToken(2) 失败: %v", err)
	}

	g, err := app.LocalCreateAccountGroup("团队 A")
	if err != nil {
		t.Fatalf("LocalCreateAccountGroup 失败: %v", err)
	}
	if g.ID == "" || g.Name != "团队 A" {
		t.Fatalf("建组回视图异常: %+v", g)
	}

	if _, err := app.LocalAssignAccountsToGroup(g.ID, []string{a1.ID, a2.ID}); err != nil {
		t.Fatalf("LocalAssignAccountsToGroup 失败: %v", err)
	}

	// 回读分组列表确认两号都落进 g(真 accountgroups.Store JSON)。
	groups, err := app.LocalListAccountGroups()
	if err != nil {
		t.Fatalf("LocalListAccountGroups 失败: %v", err)
	}
	if len(groups) != 1 {
		t.Fatalf("应恰有 1 个分组,实际: %+v", groups)
	}
	if len(groups[0].AccountIDs) != 2 {
		t.Fatalf("分组应含 2 个成员,实际: %+v", groups[0].AccountIDs)
	}

	// 账号→groupID 反查(ResolveAccountGroups 返回 accountID→groupID)。
	resolved, err := app.LocalResolveAccountGroups()
	if err != nil {
		t.Fatalf("LocalResolveAccountGroups 失败: %v", err)
	}
	if resolved[a1.ID] != g.ID || resolved[a2.ID] != g.ID {
		t.Fatalf("解析账号→groupID 异常: %+v", resolved)
	}

	// 独占语义:把 a2 归到新组,a2 应自动从「团队 A」移除。
	g2, err := app.LocalCreateAccountGroup("团队 B")
	if err != nil {
		t.Fatalf("LocalCreateAccountGroup(2) 失败: %v", err)
	}
	if _, err := app.LocalAssignAccountsToGroup(g2.ID, []string{a2.ID}); err != nil {
		t.Fatalf("LocalAssignAccountsToGroup(改组) 失败: %v", err)
	}
	resolved2, err := app.LocalResolveAccountGroups()
	if err != nil {
		t.Fatalf("LocalResolveAccountGroups(改组后) 失败: %v", err)
	}
	if resolved2[a1.ID] != g.ID {
		t.Errorf("a1 应仍属「团队 A」(%s),实际 %q", g.ID, resolved2[a1.ID])
	}
	if resolved2[a2.ID] != g2.ID {
		t.Errorf("a2 改组后应属「团队 B」(%s,独占),实际 %q", g2.ID, resolved2[a2.ID])
	}
}
