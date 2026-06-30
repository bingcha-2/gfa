package main

import (
	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/manager"
	"bcai-wails/internal/local/stats"
	"bcai-wails/internal/local/takeover"
)

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

// LocalGetAntigravitySource / LocalSetAntigravitySource:接管号源
//(antigravity 专有:把 IDE settings.json 指向本地网关端口,复用既有 InjectIDESettings)。
// 真机生效:需已装 Antigravity IDE;本机无 IDE 时注入安全 no-op。

func (a *App) LocalGetAntigravitySource() string {
	if err := ensureLocal(); err != nil {
		return string(takeover.SourceRemote)
	}
	return string(localSources.Get("antigravity"))
}

func (a *App) LocalSetAntigravitySource(source string) error {
	pc, err := ctxFor(account.ProviderAntigravity)
	if err != nil {
		return err
	}
	src := takeover.Normalize(source)
	if src == takeover.SourceLocal {
		port, err := pc.gw.Start(0)
		if err != nil {
			return err
		}
		_ = RestoreIDESettings() // 清理可能的远程注入,避免端口指向错
		if err := InjectIDESettings(port); err != nil {
			return err
		}
	} else {
		_ = RestoreIDESettings()
		_ = pc.gw.Stop()
	}
	return localSources.Set("antigravity", src)
}
