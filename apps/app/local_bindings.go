package main

import (
	"os"
	"path/filepath"
	"sync"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/hub"
	"bcai-wails/internal/local/manager"
	"bcai-wails/internal/local/refreshcfg"
	"bcai-wails/internal/local/stats"
	"bcai-wails/internal/local/wakeup"
)

// 本地自有号(本地接管)Wails 绑定 —— 仅薄薄委托给 internal/local/hub。
// 编排逻辑全在 hub 包;平台专有动作经 localPlatform(local_platform.go)注入。
// 单例懒初始化。

var (
	localOnce sync.Once
	localHub  *hub.Hub
	localErr  error
)

func ensureLocal() error {
	localOnce.Do(func() {
		dir := filepath.Join(getAppDataDir(), "local")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			localErr = err
			return
		}
		localHub, localErr = hub.New(dir, localPlatform{})
	})
	return localErr
}

// ── 账号级(按 ID) ──

func (a *App) LocalSetPoolEnabled(id string, enabled bool) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.SetPoolEnabled(id, enabled)
}

func (a *App) LocalDeleteAccount(id string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.DeleteAccount(id)
}

func (a *App) LocalDeleteAccounts(ids []string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.DeleteAccounts(ids)
}

// 账号级编辑(按 ID,provider 无关)。
func (a *App) LocalRenameAccount(id, name string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.RenameAccount(id, name)
}

func (a *App) LocalSetAccountNote(id, note string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.SetAccountNote(id, note)
}

func (a *App) LocalSetAccountTags(id string, tags []string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.SetAccountTags(id, tags)
}

// 共享反代端口设置(改端口并重启共享网关)。
func (a *App) LocalSetGatewayPort(port int) (hub.GatewayStatus, error) {
	if err := ensureLocal(); err != nil {
		return hub.GatewayStatus{}, err
	}
	return localHub.SetGatewayPort(port)
}

// 按号额度刷新(真去上游,移植 cockpit;回填并持久化)。按 id,provider 无关。
func (a *App) LocalRefreshAccountQuota(id string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.RefreshAccountQuota(id)
}

// 刷新某 provider 全部 pool_enabled 自有号额度,返回成功数量。
func (a *App) LocalRefreshAllQuotas(provider string) (int, error) {
	if err := ensureLocal(); err != nil {
		return 0, err
	}
	return localHub.RefreshAllQuotas(account.Provider(provider))
}

// 自动刷新间隔(配额自动刷新 / 当前账号刷新,分钟)。
func (a *App) LocalGetRefreshConfig() (refreshcfg.Config, error) {
	if err := ensureLocal(); err != nil {
		return refreshcfg.Config{}, err
	}
	return localHub.GetRefreshConfig(), nil
}

func (a *App) LocalSetRefreshConfig(quotaMinutes, currentMinutes int) (refreshcfg.Config, error) {
	if err := ensureLocal(); err != nil {
		return refreshcfg.Config{}, err
	}
	return localHub.SetRefreshConfig(quotaMinutes, currentMinutes)
}

// ── Codex ──

func (a *App) LocalListCodexAccounts() ([]manager.AccountView, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.ListAccounts(account.ProviderCodex)
}

func (a *App) LocalStartCodexLogin() (string, error) {
	if err := ensureLocal(); err != nil {
		return "", err
	}
	return localHub.StartLogin(account.ProviderCodex)
}

func (a *App) LocalWaitCodexLogin(id string) (manager.AccountView, error) {
	if err := ensureLocal(); err != nil {
		return manager.AccountView{}, err
	}
	return localHub.WaitLogin(account.ProviderCodex, id)
}

func (a *App) LocalSetCodexPriority(id string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.SetPriority(account.ProviderCodex, id)
}

func (a *App) LocalAddCodexToken(refreshToken, accessToken, email string) (manager.AccountView, error) {
	if err := ensureLocal(); err != nil {
		return manager.AccountView{}, err
	}
	return localHub.AddByToken(account.ProviderCodex, refreshToken, accessToken, email)
}

func (a *App) LocalAddCodexApiKey(apiKey, baseURL, email string) (manager.AccountView, error) {
	if err := ensureLocal(); err != nil {
		return manager.AccountView{}, err
	}
	return localHub.AddByAPIKey(account.ProviderCodex, apiKey, baseURL, email)
}

func (a *App) LocalGatewayStart() (hub.GatewayStatus, error) {
	if err := ensureLocal(); err != nil {
		return hub.GatewayStatus{}, err
	}
	return localHub.GatewayStart(account.ProviderCodex)
}

func (a *App) LocalGatewayStop() error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.GatewayStop(account.ProviderCodex)
}

func (a *App) LocalGatewayStatus() hub.GatewayStatus {
	if err := ensureLocal(); err != nil {
		return hub.GatewayStatus{}
	}
	return localHub.GatewayStatusOf(account.ProviderCodex)
}

func (a *App) LocalCodexStats() (stats.Snapshot, error) {
	if err := ensureLocal(); err != nil {
		return stats.Snapshot{}, err
	}
	return localHub.Stats(account.ProviderCodex)
}

func (a *App) LocalExportCodexAccounts(ids []string) (string, error) {
	if err := ensureLocal(); err != nil {
		return "", err
	}
	return localHub.Export(account.ProviderCodex, ids)
}

func (a *App) LocalImportCodexFromJSON(jsonStr string) (int, error) {
	if err := ensureLocal(); err != nil {
		return 0, err
	}
	return localHub.Import(account.ProviderCodex, jsonStr)
}

// LocalImportCodexFromLocal 读本机 ~/.codex/auth.json,解析成自有号加入(按 email 去重),返回新增数。
func (a *App) LocalImportCodexFromLocal() (int, error) {
	if err := ensureLocal(); err != nil {
		return 0, err
	}
	return localHub.ImportCodexFromLocal()
}

// LocalImportCodexAuthFiles 把多段文件文本导入为 codex 自有号(codex auth.json / 导出格式),返回新增数。
func (a *App) LocalImportCodexAuthFiles(contents []string) (int, error) {
	if err := ensureLocal(); err != nil {
		return 0, err
	}
	return localHub.ImportCodexAuthFiles(contents)
}

func (a *App) LocalGetCodexSource() string {
	if err := ensureLocal(); err != nil {
		return "remote"
	}
	return localHub.GetSource(account.ProviderCodex)
}

func (a *App) LocalSetCodexSource(source string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.SetSource(account.ProviderCodex, source)
}

func (a *App) LocalCodexWakeupConfig() (wakeup.Config, error) {
	if err := ensureLocal(); err != nil {
		return wakeup.Config{}, err
	}
	return localHub.WakeupConfig(account.ProviderCodex)
}

func (a *App) LocalSetCodexWakeupConfig(enabled bool, intervalMinutes int) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.SetWakeupConfig(account.ProviderCodex, enabled, intervalMinutes)
}

func (a *App) LocalCodexWakeupRunNow() ([]wakeup.RunEntry, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.WakeupRunNow(account.ProviderCodex)
}

func (a *App) LocalCodexWakeupHistory() ([]wakeup.RunEntry, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.WakeupHistory(account.ProviderCodex)
}

// ── Antigravity ──

func (a *App) LocalListAntigravityAccounts() ([]manager.AccountView, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.ListAccounts(account.ProviderAntigravity)
}

func (a *App) LocalStartAntigravityLogin() (string, error) {
	if err := ensureLocal(); err != nil {
		return "", err
	}
	return localHub.StartLogin(account.ProviderAntigravity)
}

func (a *App) LocalWaitAntigravityLogin(id string) (manager.AccountView, error) {
	if err := ensureLocal(); err != nil {
		return manager.AccountView{}, err
	}
	return localHub.WaitLogin(account.ProviderAntigravity, id)
}

func (a *App) LocalSetAntigravityPriority(id string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.SetPriority(account.ProviderAntigravity, id)
}

func (a *App) LocalAddAntigravityToken(refreshToken, accessToken, email string) (manager.AccountView, error) {
	if err := ensureLocal(); err != nil {
		return manager.AccountView{}, err
	}
	return localHub.AddByToken(account.ProviderAntigravity, refreshToken, accessToken, email)
}

func (a *App) LocalAddAntigravityApiKey(apiKey, baseURL, email string) (manager.AccountView, error) {
	if err := ensureLocal(); err != nil {
		return manager.AccountView{}, err
	}
	return localHub.AddByAPIKey(account.ProviderAntigravity, apiKey, baseURL, email)
}

func (a *App) LocalAntigravityGatewayStart() (hub.GatewayStatus, error) {
	if err := ensureLocal(); err != nil {
		return hub.GatewayStatus{}, err
	}
	return localHub.GatewayStart(account.ProviderAntigravity)
}

func (a *App) LocalAntigravityGatewayStop() error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.GatewayStop(account.ProviderAntigravity)
}

func (a *App) LocalAntigravityGatewayStatus() hub.GatewayStatus {
	if err := ensureLocal(); err != nil {
		return hub.GatewayStatus{}
	}
	return localHub.GatewayStatusOf(account.ProviderAntigravity)
}

func (a *App) LocalAntigravityStats() (stats.Snapshot, error) {
	if err := ensureLocal(); err != nil {
		return stats.Snapshot{}, err
	}
	return localHub.Stats(account.ProviderAntigravity)
}

func (a *App) LocalExportAntigravityAccounts(ids []string) (string, error) {
	if err := ensureLocal(); err != nil {
		return "", err
	}
	return localHub.Export(account.ProviderAntigravity, ids)
}

func (a *App) LocalImportAntigravityFromJSON(jsonStr string) (int, error) {
	if err := ensureLocal(); err != nil {
		return 0, err
	}
	return localHub.Import(account.ProviderAntigravity, jsonStr)
}

// LocalImportAntigravityAuthFiles 把多段文件文本导入为 antigravity 自有号(凭证 JSON / 导出格式),返回新增数。
func (a *App) LocalImportAntigravityAuthFiles(contents []string) (int, error) {
	if err := ensureLocal(); err != nil {
		return 0, err
	}
	return localHub.ImportAntigravityAuthFiles(contents)
}

// LocalSyncAntigravityFromIDE 读已装 Antigravity IDE 的登录态同步成自有号(按 email 去重),返回新增数。
func (a *App) LocalSyncAntigravityFromIDE() (int, error) {
	if err := ensureLocal(); err != nil {
		return 0, err
	}
	return localHub.SyncAntigravityFromIDE()
}

func (a *App) LocalGetAntigravitySource() string {
	if err := ensureLocal(); err != nil {
		return "remote"
	}
	return localHub.GetSource(account.ProviderAntigravity)
}

func (a *App) LocalSetAntigravitySource(source string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.SetSource(account.ProviderAntigravity, source)
}

func (a *App) LocalAntigravityWakeupConfig() (wakeup.Config, error) {
	if err := ensureLocal(); err != nil {
		return wakeup.Config{}, err
	}
	return localHub.WakeupConfig(account.ProviderAntigravity)
}

func (a *App) LocalSetAntigravityWakeupConfig(enabled bool, intervalMinutes int) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.SetWakeupConfig(account.ProviderAntigravity, enabled, intervalMinutes)
}

func (a *App) LocalAntigravityWakeupRunNow() ([]wakeup.RunEntry, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.WakeupRunNow(account.ProviderAntigravity)
}

func (a *App) LocalAntigravityWakeupHistory() ([]wakeup.RunEntry, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.WakeupHistory(account.ProviderAntigravity)
}

