package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/antigravityauth"
	"bcai-wails/internal/local/codexauth"
	"bcai-wails/internal/local/gateway"
	"bcai-wails/internal/local/instance"
	"bcai-wails/internal/local/manager"
	"bcai-wails/internal/local/stats"
	"bcai-wails/internal/local/takeover"
	"bcai-wails/internal/local/wakeup"
)

// 本地自有号(本地接管)Wails 绑定。所有方法薄薄委托给 internal/local/manager。
// 多 provider(codex / antigravity)各自一套 gateway+manager,共享一个账号 DB
//(account.Store 按 provider 列区分)与一份号源持久化。单例懒初始化。

type providerCtx struct {
	gw    *gateway.Gateway
	mgr   *manager.Manager
	wk    *wakeup.Scheduler
	wkCfg *wakeup.ConfigStore
}

var (
	localOnce      sync.Once
	localAcc       *account.Store
	localSources   *takeover.SourceStore
	localInstances *instance.Store
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
		localInstances = instance.NewStore(dir)
		localProviders = map[account.Provider]*providerCtx{}

		mk := func(p account.Provider, login manager.LoginFunc) *providerCtx {
			gw := gateway.New(acc, p, filepath.Join(dir, string(p)))
			// 保活 ping:对本 provider 的网关做一次 /v1/models 触达(网关在跑才有意义)。
			// 按号精度的保活(各号 token 刷新)作后续细化;此处先做网关级 keep-warm。
			ping := func(ctx context.Context, _ string) error {
				if !gw.Running() {
					return errors.New("gateway not running")
				}
				req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+gw.Addr()+"/v1/models", nil)
				if err != nil {
					return err
				}
				resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
				if err != nil {
					return err
				}
				_ = resp.Body.Close()
				return nil
			}
			accountsFn := func() []*account.Account {
				l, _ := acc.ListPoolEnabled(p)
				return l
			}
			wk := wakeup.New(ping, accountsFn)
			wkCfg := wakeup.NewConfigStore(dir, string(p))
			wk.SetConfig(wkCfg.Load())
			wk.Start(context.Background(), time.Minute)
			return &providerCtx{gw: gw, mgr: manager.New(acc, gw, p, login), wk: wk, wkCfg: wkCfg}
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
