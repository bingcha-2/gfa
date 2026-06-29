package main

import (
	"os"
	"path/filepath"
	"sync"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/gateway"
	"bcai-wails/internal/local/manager"
	"bcai-wails/internal/local/takeover"
)

// 本地自有号(本地接管)相关的 Wails 绑定。所有方法薄薄委托给 internal/local/manager,
// App 层不含业务逻辑。单例懒初始化(首次使用时打开 SQLite + 建网关)。

var (
	localOnce    sync.Once
	localMgr     *manager.Manager
	localGw      *gateway.Gateway
	localAcc     *account.Store
	localSources *takeover.SourceStore
	localErr     error
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
		localGw = gateway.New(acc, account.ProviderCodex, dir)
		localMgr = manager.New(acc, localGw)
		localSources = takeover.NewSourceStore(dir)
	})
	return localErr
}

// LocalGatewayStatusView 网关状态视图(前端用)。
type LocalGatewayStatusView struct {
	Running bool   `json:"running"`
	Addr    string `json:"addr"`
	Port    int    `json:"port"`
}

func (a *App) LocalListCodexAccounts() ([]manager.AccountView, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localMgr.ListAccounts(account.ProviderCodex)
}

func (a *App) LocalStartCodexLogin() (string, error) {
	if err := ensureLocal(); err != nil {
		return "", err
	}
	return localMgr.StartCodexLogin(), nil
}

func (a *App) LocalWaitCodexLogin(id string) (manager.AccountView, error) {
	if err := ensureLocal(); err != nil {
		return manager.AccountView{}, err
	}
	return localMgr.WaitCodexLogin(id)
}

func (a *App) LocalDeleteAccount(id string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localMgr.DeleteAccount(id)
}

func (a *App) LocalSetPoolEnabled(id string, enabled bool) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localMgr.SetPoolEnabled(id, enabled)
}

func (a *App) LocalSetCodexPriority(id string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localMgr.SetPriority(account.ProviderCodex, id)
}

func (a *App) LocalGatewayStart() (LocalGatewayStatusView, error) {
	if err := ensureLocal(); err != nil {
		return LocalGatewayStatusView{}, err
	}
	port, err := localGw.Start(0)
	if err != nil {
		return LocalGatewayStatusView{}, err
	}
	return LocalGatewayStatusView{Running: true, Addr: localGw.Addr(), Port: port}, nil
}

func (a *App) LocalGatewayStop() error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localGw.Stop()
}

func (a *App) LocalGatewayStatus() LocalGatewayStatusView {
	if err := ensureLocal(); err != nil {
		return LocalGatewayStatusView{}
	}
	return LocalGatewayStatusView{Running: localGw.Running(), Addr: localGw.Addr(), Port: localGw.Port()}
}

// LocalGetCodexSource 返回 codex 当前号源(remote|local)。
func (a *App) LocalGetCodexSource() string {
	if err := ensureLocal(); err != nil {
		return string(takeover.SourceRemote)
	}
	return string(localSources.Get("codex"))
}

// LocalSetCodexSource 切换 codex 接管号源。
//
//	local  → 启动本地网关,把 Codex 的 config.toml 指向网关端口(若已远程注入先还原)
//	remote → 还原本地注入并停网关(远程接管仍由主页接管面板按原流程开启)
//
// 同一产品同时只有一种接管生效(互斥)。
func (a *App) LocalSetCodexSource(source string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	src := takeover.Normalize(source)
	if src == takeover.SourceLocal {
		port, err := localGw.Start(0)
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
		_ = localGw.Stop()
	}
	return localSources.Set("codex", src)
}
