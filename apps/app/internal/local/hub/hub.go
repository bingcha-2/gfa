// Package hub 是本地接管(自有号)的编排中枢:把账号 store、各 provider 的网关+
// 管理器+保活、号源、实例 store 收成一个 Hub,对外暴露所有非平台操作。
//
// 平台专有动作(codex/antigravity 的接管注入、app 路径检测、进程启停)由调用方
// 通过 Platform 接口注入(实现在 package main,因依赖那里的注入/检测函数)。
// 这样 Wails 绑定层只剩薄薄一层委托。
package hub

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
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

// Platform 抽象 package main 里的平台专有动作(接管注入 / app 检测 / 进程启停)。
type Platform interface {
	CodexInject(port int) error
	CodexRestore() error
	CodexInjected() bool
	AntigravityIDEInject(port int) error
	AntigravityIDERestore() error

	DetectAppPath(provider string) string
	LaunchApp(appPath, workingDir string, args []string) (int, error)
	StopProcess(pid int) error
}

// GatewayStatus 网关状态视图(前端用)。
type GatewayStatus struct {
	Running bool   `json:"running"`
	Addr    string `json:"addr"`
	Port    int    `json:"port"`
}

type providerCtx struct {
	mgr   *manager.Manager
	wk    *wakeup.Scheduler
	wkCfg *wakeup.ConfigStore
}

type Hub struct {
	dir       string
	acc       *account.Store
	gw        *gateway.Gateway // 共享网关:codex + antigravity 自有号同喂同一实例
	sources   *takeover.SourceStore
	instances *instance.Store
	platform  Platform
	providers map[account.Provider]*providerCtx
}

// New 打开账号 DB,构建【单个共享网关】+ codex/antigravity 两套 manager+wakeup
//(各自启动保活循环,但都打向共享网关)。
func New(dir string, platform Platform) (*Hub, error) {
	acc, err := account.OpenStore(filepath.Join(dir, "accounts.db"))
	if err != nil {
		return nil, err
	}
	h := &Hub{
		dir:       dir,
		acc:       acc,
		gw:        gateway.NewShared(acc, filepath.Join(dir, "gateway")),
		sources:   takeover.NewSourceStore(dir),
		instances: instance.NewStore(dir),
		platform:  platform,
		providers: map[account.Provider]*providerCtx{},
	}
	h.providers[account.ProviderCodex] = h.mkProvider(account.ProviderCodex, codexauth.Login)
	h.providers[account.ProviderAntigravity] = h.mkProvider(account.ProviderAntigravity, antigravityauth.Login)
	return h, nil
}

func (h *Hub) mkProvider(p account.Provider, login manager.LoginFunc) *providerCtx {
	// 保活 ping:对共享网关做一次 /v1/models 触达(网关级 keep-warm)。
	ping := func(ctx context.Context, _ string) error {
		if !h.gw.Running() {
			return errors.New("gateway not running")
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+h.gw.Addr()+"/v1/models", nil)
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
		l, _ := h.acc.ListPoolEnabled(p)
		return l
	}
	wk := wakeup.New(ping, accountsFn)
	wkCfg := wakeup.NewConfigStore(h.dir, string(p))
	wk.SetConfig(wkCfg.Load())
	wk.Start(context.Background(), time.Minute)
	return &providerCtx{mgr: manager.New(h.acc, h.gw, p, login), wk: wk, wkCfg: wkCfg}
}

func (h *Hub) ctx(p account.Provider) (*providerCtx, error) {
	pc := h.providers[p]
	if pc == nil {
		return nil, fmt.Errorf("hub: unknown provider %q", p)
	}
	return pc, nil
}

// ── 账号级(按 ID,provider 无关) ──

func (h *Hub) SetPoolEnabled(id string, enabled bool) error {
	a, err := h.acc.Get(id)
	if err != nil {
		return err
	}
	pc, err := h.ctx(a.Provider)
	if err != nil {
		return err
	}
	return pc.mgr.SetPoolEnabled(id, enabled)
}

func (h *Hub) DeleteAccount(id string) error {
	a, err := h.acc.Get(id)
	if err != nil {
		return err
	}
	pc, err := h.ctx(a.Provider)
	if err != nil {
		return err
	}
	return pc.mgr.DeleteAccount(id)
}

func (h *Hub) DeleteAccounts(ids []string) error {
	for _, id := range ids {
		if err := h.DeleteAccount(id); err != nil {
			return err
		}
	}
	return nil
}

// RenameAccount/SetAccountNote/SetAccountTags 是账号级编辑(按 id,provider 无关)。
func (h *Hub) RenameAccount(id, name string) error {
	return h.editByID(id, func(m *manager.Manager) error { return m.Rename(id, name) })
}

func (h *Hub) SetAccountNote(id, note string) error {
	return h.editByID(id, func(m *manager.Manager) error { return m.SetNote(id, note) })
}

func (h *Hub) SetAccountTags(id string, tags []string) error {
	return h.editByID(id, func(m *manager.Manager) error { return m.SetTags(id, tags) })
}

func (h *Hub) editByID(id string, fn func(*manager.Manager) error) error {
	a, err := h.acc.Get(id)
	if err != nil {
		return err
	}
	pc, err := h.ctx(a.Provider)
	if err != nil {
		return err
	}
	return fn(pc.mgr)
}

// ── 账号管理(provider 显式) ──

func (h *Hub) ListAccounts(p account.Provider) ([]manager.AccountView, error) {
	pc, err := h.ctx(p)
	if err != nil {
		return nil, err
	}
	return pc.mgr.ListAccounts()
}

func (h *Hub) StartLogin(p account.Provider) (string, error) {
	pc, err := h.ctx(p)
	if err != nil {
		return "", err
	}
	return pc.mgr.StartLogin(), nil
}

func (h *Hub) WaitLogin(p account.Provider, id string) (manager.AccountView, error) {
	pc, err := h.ctx(p)
	if err != nil {
		return manager.AccountView{}, err
	}
	return pc.mgr.WaitLogin(id)
}

func (h *Hub) AddByToken(p account.Provider, refreshToken, accessToken, email string) (manager.AccountView, error) {
	pc, err := h.ctx(p)
	if err != nil {
		return manager.AccountView{}, err
	}
	return pc.mgr.AddByToken(refreshToken, accessToken, email)
}

func (h *Hub) AddByAPIKey(p account.Provider, apiKey, baseURL, email string) (manager.AccountView, error) {
	pc, err := h.ctx(p)
	if err != nil {
		return manager.AccountView{}, err
	}
	return pc.mgr.AddByAPIKey(apiKey, baseURL, email)
}

func (h *Hub) SetPriority(p account.Provider, id string) error {
	pc, err := h.ctx(p)
	if err != nil {
		return err
	}
	return pc.mgr.SetPriority(id)
}

func (h *Hub) Export(p account.Provider, ids []string) (string, error) {
	pc, err := h.ctx(p)
	if err != nil {
		return "", err
	}
	return pc.mgr.Export(ids)
}

func (h *Hub) Import(p account.Provider, jsonStr string) (int, error) {
	pc, err := h.ctx(p)
	if err != nil {
		return 0, err
	}
	return pc.mgr.ImportJSON(jsonStr)
}

// ── 网关 + 统计(共享网关:按 provider 查询但返回同一个实例的地址) ──

func (h *Hub) gwStatus() GatewayStatus {
	return GatewayStatus{Running: h.gw.Running(), Addr: h.gw.Addr(), Port: h.gw.Port()}
}

func (h *Hub) GatewayStart(p account.Provider) (GatewayStatus, error) {
	if _, err := h.ctx(p); err != nil {
		return GatewayStatus{}, err
	}
	if _, err := h.gw.Start(gateway.DefaultGatewayPort); err != nil {
		return GatewayStatus{}, err
	}
	return h.gwStatus(), nil
}

func (h *Hub) GatewayStop(p account.Provider) error {
	if _, err := h.ctx(p); err != nil {
		return err
	}
	return h.gw.Stop()
}

func (h *Hub) GatewayStatusOf(p account.Provider) GatewayStatus {
	if _, err := h.ctx(p); err != nil {
		return GatewayStatus{}
	}
	return h.gwStatus()
}

// SetGatewayPort 改共享反代端口并重启网关。
func (h *Hub) SetGatewayPort(port int) (GatewayStatus, error) {
	if _, err := h.gw.SetPort(port); err != nil {
		return GatewayStatus{}, err
	}
	return h.gwStatus(), nil
}

func (h *Hub) Stats(p account.Provider) (stats.Snapshot, error) {
	if _, err := h.ctx(p); err != nil {
		return stats.Snapshot{}, err
	}
	snap := h.gw.Stats()
	list, _ := h.acc.List(p)
	emails := make(map[string]string, len(list))
	for _, ac := range list {
		emails[ac.ID] = ac.Email
	}
	snap.SetEmails(emails)
	return snap, nil
}

// ── 接管号源(平台专有注入经 Platform） ──

func (h *Hub) GetSource(p account.Provider) string {
	return string(h.sources.Get(string(p)))
}

func (h *Hub) SetSource(p account.Provider, source string) error {
	if _, err := h.ctx(p); err != nil {
		return err
	}
	src := takeover.Normalize(source)
	if src == takeover.SourceLocal {
		// 共享网关:两个 provider 都指向同一个固定默认端口(被占用回退)。
		port, err := h.gw.Start(gateway.DefaultGatewayPort)
		if err != nil {
			return err
		}
		switch p {
		case account.ProviderCodex:
			if h.platform.CodexInjected() {
				_ = h.platform.CodexRestore()
			}
			if err := h.platform.CodexInject(port); err != nil {
				return err
			}
		case account.ProviderAntigravity:
			_ = h.platform.AntigravityIDERestore()
			if err := h.platform.AntigravityIDEInject(port); err != nil {
				return err
			}
		}
	} else {
		switch p {
		case account.ProviderCodex:
			if h.platform.CodexInjected() {
				_ = h.platform.CodexRestore()
			}
		case account.ProviderAntigravity:
			_ = h.platform.AntigravityIDERestore()
		}
		// 共享网关:仅当另一个 provider 也不是 local 时才停网关。
		if !h.anyOtherLocal(p) {
			_ = h.gw.Stop()
		}
	}
	return h.sources.Set(string(p), src)
}

// anyOtherLocal 判断除 except 外是否还有 provider 处于 local 号源。
func (h *Hub) anyOtherLocal(except account.Provider) bool {
	for p := range h.providers {
		if p == except {
			continue
		}
		if takeover.Normalize(h.GetSource(p)) == takeover.SourceLocal {
			return true
		}
	}
	return false
}

// ── 保活 ──

func (h *Hub) WakeupConfig(p account.Provider) (wakeup.Config, error) {
	pc, err := h.ctx(p)
	if err != nil {
		return wakeup.Config{}, err
	}
	return pc.wk.GetConfig(), nil
}

func (h *Hub) SetWakeupConfig(p account.Provider, enabled bool, intervalMinutes int) error {
	pc, err := h.ctx(p)
	if err != nil {
		return err
	}
	pc.wk.SetConfig(wakeup.Config{Enabled: enabled, IntervalMinutes: intervalMinutes})
	return pc.wkCfg.Save(pc.wk.GetConfig())
}

func (h *Hub) WakeupRunNow(p account.Provider) ([]wakeup.RunEntry, error) {
	pc, err := h.ctx(p)
	if err != nil {
		return nil, err
	}
	return pc.wk.RunOnce(context.Background(), time.Now().UnixMilli()), nil
}

func (h *Hub) WakeupHistory(p account.Provider) ([]wakeup.RunEntry, error) {
	pc, err := h.ctx(p)
	if err != nil {
		return nil, err
	}
	return pc.wk.History(), nil
}

// ── 多实例(启动/停止经 Platform） ──

func (h *Hub) InstanceList(provider string) ([]*instance.Profile, error) {
	return h.instances.List(provider)
}

func (h *Hub) InstanceCreate(provider, name, userDataDir, workingDir, extraArgs, bindAccountID string) (*instance.Profile, error) {
	p := &instance.Profile{
		Provider: provider, Name: name, UserDataDir: userDataDir,
		WorkingDir: workingDir, ExtraArgs: extraArgs, BindAccountID: bindAccountID,
	}
	if err := h.instances.Create(p); err != nil {
		return nil, err
	}
	return p, nil
}

func (h *Hub) InstanceUpdate(p instance.Profile) error { return h.instances.Update(&p) }
func (h *Hub) InstanceDelete(id string) error          { return h.instances.Delete(id) }

func (h *Hub) InstanceLaunch(id string) error {
	p, ok := h.instances.Get(id)
	if !ok {
		return fmt.Errorf("实例不存在")
	}
	appPath := h.platform.DetectAppPath(p.Provider)
	if appPath == "" {
		return fmt.Errorf("未检测到 %s 的应用,请先安装", p.Provider)
	}
	pid, err := h.platform.LaunchApp(appPath, p.WorkingDir, BuildInstanceLaunchArgs(p))
	if err != nil {
		return err
	}
	return h.instances.SetPid(id, pid)
}

func (h *Hub) InstanceStop(id string) error {
	p, ok := h.instances.Get(id)
	if !ok {
		return fmt.Errorf("实例不存在")
	}
	if p.Pid > 0 {
		_ = h.platform.StopProcess(p.Pid)
	}
	return h.instances.SetPid(id, 0)
}
