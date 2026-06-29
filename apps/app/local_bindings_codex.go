package main

import (
	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/manager"
	"bcai-wails/internal/local/stats"
	"bcai-wails/internal/local/takeover"
)

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
