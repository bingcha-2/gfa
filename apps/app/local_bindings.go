package main

import (
	"os"
	"path/filepath"
	"sync"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/antigravityauth"
	"bcai-wails/internal/local/codexauth"
	"bcai-wails/internal/local/gateway"
	"bcai-wails/internal/local/manager"
	"bcai-wails/internal/local/stats"
	"bcai-wails/internal/local/takeover"
)

// 本地自有号(本地接管)Wails 绑定。所有方法薄薄委托给 internal/local/manager。
// 多 provider(codex / antigravity)各自一套 gateway+manager,共享一个账号 DB
//(account.Store 按 provider 列区分)与一份号源持久化。单例懒初始化。

type providerCtx struct {
	gw  *gateway.Gateway
	mgr *manager.Manager
}

var (
	localOnce      sync.Once
	localAcc       *account.Store
	localSources   *takeover.SourceStore
	localProviders map[account.Provider]*providerCtx
	localErr       error
)

func ensureLocal() error {
	localOnce.Do(func() {
		dir := filepath.Join(getAppDataDir(), "local")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			localErr = err
			return
		}
		acc, err := account.OpenStore(filepath.Join(dir, "accounts.db"))
		if err != nil {
			localErr = err
			return
		}
		localAcc = acc
		localSources = takeover.NewSourceStore(dir)
		localProviders = map[account.Provider]*providerCtx{}

		mk := func(p account.Provider, login manager.LoginFunc) *providerCtx {
			gw := gateway.New(acc, p, filepath.Join(dir, string(p)))
			return &providerCtx{gw: gw, mgr: manager.New(acc, gw, p, login)}
		}
		localProviders[account.ProviderCodex] = mk(account.ProviderCodex, codexauth.Login)
		localProviders[account.ProviderAntigravity] = mk(account.ProviderAntigravity, antigravityauth.Login)
	})
	return localErr
}

func ctxFor(p account.Provider) (*providerCtx, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localProviders[p], nil
}

// LocalGatewayStatusView 网关状态视图(前端用)。
type LocalGatewayStatusView struct {
	Running bool   `json:"running"`
	Addr    string `json:"addr"`
	Port    int    `json:"port"`
}

func gwStatus(pc *providerCtx) LocalGatewayStatusView {
	return LocalGatewayStatusView{Running: pc.gw.Running(), Addr: pc.gw.Addr(), Port: pc.gw.Port()}
}

// statsWithEmails 把 authID→email 补进统计。
func statsWithEmails(pc *providerCtx, p account.Provider) (stats.Snapshot, error) {
	snap := pc.gw.Stats()
	list, _ := localAcc.List(p)
	emails := make(map[string]string, len(list))
	for _, ac := range list {
		emails[ac.ID] = ac.Email
	}
	snap.SetEmails(emails)
	return snap, nil
}

// ───────────────────────── 账号级(provider 无关,按 ID) ─────────────────────────

func (a *App) LocalSetPoolEnabled(id string, enabled bool) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	// 池开关只改 DB + 重载所属 provider 网关;用 codex mgr 即可(reload 各自网关由 mgr 持有)。
	// 由于 account.Store 共享,任一 mgr.SetPoolEnabled 都改同一行;为正确重载,按账号 provider 选 mgr。
	acc, err := localAcc.Get(id)
	if err != nil {
		return err
	}
	pc := localProviders[acc.Provider]
	if pc == nil {
		return localProviders[account.ProviderCodex].mgr.SetPoolEnabled(id, enabled)
	}
	return pc.mgr.SetPoolEnabled(id, enabled)
}

func (a *App) LocalDeleteAccount(id string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	acc, err := localAcc.Get(id)
	if err != nil {
		return err
	}
	if pc := localProviders[acc.Provider]; pc != nil {
		return pc.mgr.DeleteAccount(id)
	}
	return localAcc.Delete(id)
}

func (a *App) LocalDeleteAccounts(ids []string) error {
	for _, id := range ids {
		if err := a.LocalDeleteAccount(id); err != nil {
			return err
		}
	}
	return nil
}

// ───────────────────────── Codex ─────────────────────────

func (a *App) LocalListCodexAccounts() ([]manager.AccountView, error) {
	pc, err := ctxFor(account.ProviderCodex)
	if err != nil {
		return nil, err
	}
	return pc.mgr.ListAccounts()
}

func (a *App) LocalStartCodexLogin() (string, error) {
	pc, err := ctxFor(account.ProviderCodex)
	if err != nil {
		return "", err
	}
	return pc.mgr.StartLogin(), nil
}

func (a *App) LocalWaitCodexLogin(id string) (manager.AccountView, error) {
	pc, err := ctxFor(account.ProviderCodex)
	if err != nil {
		return manager.AccountView{}, err
	}
	return pc.mgr.WaitLogin(id)
}

func (a *App) LocalSetCodexPriority(id string) error {
	pc, err := ctxFor(account.ProviderCodex)
	if err != nil {
		return err
	}
	return pc.mgr.SetPriority(id)
}

func (a *App) LocalGatewayStart() (LocalGatewayStatusView, error) {
	pc, err := ctxFor(account.ProviderCodex)
	if err != nil {
		return LocalGatewayStatusView{}, err
	}
	if _, err := pc.gw.Start(0); err != nil {
		return LocalGatewayStatusView{}, err
	}
	return gwStatus(pc), nil
}

func (a *App) LocalGatewayStop() error {
	pc, err := ctxFor(account.ProviderCodex)
	if err != nil {
		return err
	}
	return pc.gw.Stop()
}

func (a *App) LocalGatewayStatus() LocalGatewayStatusView {
	pc, err := ctxFor(account.ProviderCodex)
	if err != nil {
		return LocalGatewayStatusView{}
	}
	return gwStatus(pc)
}

func (a *App) LocalCodexStats() (stats.Snapshot, error) {
	pc, err := ctxFor(account.ProviderCodex)
	if err != nil {
		return stats.Snapshot{}, err
	}
	return statsWithEmails(pc, account.ProviderCodex)
}

func (a *App) LocalExportCodexAccounts(ids []string) (string, error) {
	pc, err := ctxFor(account.ProviderCodex)
	if err != nil {
		return "", err
	}
	return pc.mgr.Export(ids)
}

func (a *App) LocalImportCodexFromJSON(jsonStr string) (int, error) {
	pc, err := ctxFor(account.ProviderCodex)
	if err != nil {
		return 0, err
	}
	return pc.mgr.ImportJSON(jsonStr)
}

// LocalGetCodexSource / LocalSetCodexSource:接管号源(codex 专有:config.toml 注入)。

func (a *App) LocalGetCodexSource() string {
	if err := ensureLocal(); err != nil {
		return string(takeover.SourceRemote)
	}
	return string(localSources.Get("codex"))
}

func (a *App) LocalSetCodexSource(source string) error {
	pc, err := ctxFor(account.ProviderCodex)
	if err != nil {
		return err
	}
	src := takeover.Normalize(source)
	if src == takeover.SourceLocal {
		port, err := pc.gw.Start(0)
		if err != nil {
			return err
		}
		if IsCodexInjected() {
			_ = RestoreCodexSettings()
			_ = RestoreFakeCodexAuth()
		}
		if err := InjectCodexSettings(port); err != nil {
			return err
		}
		if err := InjectFakeCodexAuth(); err != nil {
			return err
		}
	} else {
		if IsCodexInjected() {
			_ = RestoreCodexSettings()
			_ = RestoreFakeCodexAuth()
		}
		_ = pc.gw.Stop()
	}
	return localSources.Set("codex", src)
}

// ───────────────────────── Antigravity ─────────────────────────

func (a *App) LocalListAntigravityAccounts() ([]manager.AccountView, error) {
	pc, err := ctxFor(account.ProviderAntigravity)
	if err != nil {
		return nil, err
	}
	return pc.mgr.ListAccounts()
}

func (a *App) LocalStartAntigravityLogin() (string, error) {
	pc, err := ctxFor(account.ProviderAntigravity)
	if err != nil {
		return "", err
	}
	return pc.mgr.StartLogin(), nil
}

func (a *App) LocalWaitAntigravityLogin(id string) (manager.AccountView, error) {
	pc, err := ctxFor(account.ProviderAntigravity)
	if err != nil {
		return manager.AccountView{}, err
	}
	return pc.mgr.WaitLogin(id)
}

func (a *App) LocalSetAntigravityPriority(id string) error {
	pc, err := ctxFor(account.ProviderAntigravity)
	if err != nil {
		return err
	}
	return pc.mgr.SetPriority(id)
}

func (a *App) LocalAntigravityGatewayStart() (LocalGatewayStatusView, error) {
	pc, err := ctxFor(account.ProviderAntigravity)
	if err != nil {
		return LocalGatewayStatusView{}, err
	}
	if _, err := pc.gw.Start(0); err != nil {
		return LocalGatewayStatusView{}, err
	}
	return gwStatus(pc), nil
}

func (a *App) LocalAntigravityGatewayStop() error {
	pc, err := ctxFor(account.ProviderAntigravity)
	if err != nil {
		return err
	}
	return pc.gw.Stop()
}

func (a *App) LocalAntigravityGatewayStatus() LocalGatewayStatusView {
	pc, err := ctxFor(account.ProviderAntigravity)
	if err != nil {
		return LocalGatewayStatusView{}
	}
	return gwStatus(pc)
}

func (a *App) LocalAntigravityStats() (stats.Snapshot, error) {
	pc, err := ctxFor(account.ProviderAntigravity)
	if err != nil {
		return stats.Snapshot{}, err
	}
	return statsWithEmails(pc, account.ProviderAntigravity)
}

func (a *App) LocalExportAntigravityAccounts(ids []string) (string, error) {
	pc, err := ctxFor(account.ProviderAntigravity)
	if err != nil {
		return "", err
	}
	return pc.mgr.Export(ids)
}

func (a *App) LocalImportAntigravityFromJSON(jsonStr string) (int, error) {
	pc, err := ctxFor(account.ProviderAntigravity)
	if err != nil {
		return 0, err
	}
	return pc.mgr.ImportJSON(jsonStr)
}
