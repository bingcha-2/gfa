// Package hub 是本地接管(自有号)的编排中枢:把账号 store、各 provider 的网关+
// 管理器+保活、号源、实例 store 收成一个 Hub,对外暴露所有非平台操作。
//
// 平台专有动作(codex/antigravity 的接管注入、app 路径检测、进程启停)由调用方
// 通过 Platform 接口注入(实现在 package main,因依赖那里的注入/检测函数)。
// 这样 Wails 绑定层只剩薄薄一层委托。
package hub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/accountgroups"
	"bcai-wails/internal/local/aghistory"
	"bcai-wails/internal/local/antigravityauth"
	"bcai-wails/internal/local/codexauth"
	"bcai-wails/internal/local/codexsettings"
	"bcai-wails/internal/local/economy"
	"bcai-wails/internal/local/gateway"
	"bcai-wails/internal/local/gatewaycfg"
	"bcai-wails/internal/local/gatewaykeys"
	"bcai-wails/internal/local/instance"
	"bcai-wails/internal/local/manager"
	"bcai-wails/internal/local/modelprovider"
	"bcai-wails/internal/local/quota"
	"bcai-wails/internal/local/refreshcfg"
	"bcai-wails/internal/local/routingcfg"
	"bcai-wails/internal/local/stats"
	"bcai-wails/internal/local/takeover"
	"bcai-wails/internal/local/wakeup"
)

// AntigravityToken 是注入 Antigravity IDE 所需的一份自有号登录态(不经网关)。
type AntigravityToken struct {
	AccessToken  string
	RefreshToken string
	IDToken      string
	Email        string
	ProjectID    string
	Expiry       int64 // access_token 过期时刻,unix 秒(0=未知)
	IsGCPTos     bool
}

// CodexToken 是注入 codex auth.json 的一份自有号登录态。
type CodexToken struct {
	AuthKind     string // "oauth" | "apikey"
	IDToken      string
	AccessToken  string
	RefreshToken string
	AccountID    string
	APIKey       string
}

// Platform 抽象 package main 里的平台专有动作(接管注入 / app 检测 / 进程启停)。
//
// 接管模型(对齐 cockpit)—— 接管都是「把号注入正版客户端」,与反代(cliproxy 网关)无关:
//   - codex 'local':CodexInjectAccount 把自有号写进 ~/.codex/auth.json,真 codex CLI 直连 OpenAI。
//   - antigravity 'local':AntigravityInjectAccount 把自有号写进 IDE state.vscdb,真 IDE 直连 Google。
//
// 反代(网关)是单独的附加功能,只 codex 有,由反代 tab 经 GatewayStart/Stop 独立开关。
type Platform interface {
	// CodexInjectAccount 把一份自有号写进 ~/.codex/auth.json(注入式接管,不经网关)。
	CodexInjectAccount(tok CodexToken) error
	// CodexRestoreAccount 还原 codex 注入前的 auth.json。
	CodexRestoreAccount() error
	// AntigravityInjectAccount 把一份自有号 token 注入 Antigravity IDE(state.vscdb),不经网关。
	AntigravityInjectAccount(tok AntigravityToken) error
	// AntigravityRestoreAccount 移除 Antigravity IDE 的注入登录态。
	AntigravityRestoreAccount() error
	// 变体化注入/还原/读取:variant="ide"/"standalone",分别落到对应 app 的 state.vscdb。
	AntigravityInjectAccountTo(variant string, tok AntigravityToken) error
	AntigravityRestoreAccountFor(variant string) error
	AntigravityReadTokenFrom(variant string) (AntigravityToken, error)

	// CodexAuthJSONPath 返回本机 codex 的 ~/.codex/auth.json 路径(本地导入用)。
	CodexAuthJSONPath() string
	// AntigravityReadIDEToken 读当前 Antigravity IDE(state.vscdb)里注入/登录的自有号
	// 登录态(从已装 IDE 同步号用)。未登录/未装 IDE 返回错误。
	AntigravityReadIDEToken() (AntigravityToken, error)

	DetectAppPath(provider string) string
	LaunchApp(appPath, workingDir string, args []string) (int, error)
	StopProcess(pid int) error

	// Antigravity 「默认实例」运行时控制(拉起/聚焦/停 已装 IDE 进程,复用平台探测/启停)。
	// 对齐 cockpit runtime.startDefault/stopDefault/restartDefault/focusDefault/status。
	AntigravityStartDefault() error
	AntigravityStopDefault() error
	AntigravityFocusDefault() error
	AntigravityRuntimeRunning() bool

	// 变体化运行时:同时支持 Antigravity IDE 与独立版 Antigravity(variant="ide"/"standalone")。
	// cockpit 把两者作两个独立 app(RuntimeTarget::Ide / ::Legacy),各自可检测/启停/聚焦。
	AntigravityAppRunning(variant string) bool
	AntigravityAppDetected(variant string) bool
	AntigravityAppStart(variant string) error
	AntigravityAppStop(variant string) error
	AntigravityAppFocus(variant string) error

	// CodexRestartApp 重启常驻 Codex GUI app(切号后重读 auth.json);未装则 no-op。
	CodexRestartApp() error

	// RestartSpecifiedApp 杀掉并重启用户在「Codex 设置」里指定的联动应用(切号后)。
	// 对齐 cockpit codex_restart_specified_app_on_switch / codex_specified_app_path。
	RestartSpecifiedApp(appPath string) error
}

// GatewayStatus 网关状态视图(前端用)。
type GatewayStatus struct {
	Running bool   `json:"running"`
	Addr    string `json:"addr"`
	Port    int    `json:"port"`
}

type providerCtx struct {
	mgr       *manager.Manager
	wk        *wakeup.Scheduler
	wkCfg     *wakeup.ConfigStore
	wkVerify  *wakeup.Verification // 保活验证 + 单号测试(复用同一 keepAlive)
	refresher manager.Refresher
}

type Hub struct {
	dir         string
	acc         *account.Store
	gw          *gateway.Gateway // 反代网关:只喂 codex 自有号(antigravity 接管走 IDE 注入)
	sources     *takeover.SourceStore
	instances   *instance.Store
	platform    Platform
	providers   map[account.Provider]*providerCtx
	refreshCfg  *refreshcfg.Store
	routingCfg  *routingcfg.Store
	gwKeys      *gatewaykeys.Store
	gwScope     *gatewaycfg.Store
	modelProv   *modelprovider.Store
	autoRefresh *autoRefresher

	// 经济与自动化(① 超额预警 ② 自动切号 ③ 速度档):纯逻辑 + JSON 持久化。
	alertStore  *economy.AlertStore
	switchStore *switchConfigStore
	speedStore  *economy.SpeedStore
	// codexSettings 是「Codex 设置」面板的本地持久化。
	codexSettings *codexsettings.Store

	// 账号组织 / 切号历史(均为自包含纯逻辑包,本地 JSON 持久化)。
	groups    *accountgroups.Store
	agHistory *aghistory.Store
}

// New 打开账号 DB,构建【单个反代网关(只服务 codex)】+ codex/antigravity 两套
// manager+wakeup(各自启动保活循环;antigravity 接管不经网关,走 IDE 注入)。
func New(dir string, platform Platform) (*Hub, error) {
	acc, err := account.OpenStore(filepath.Join(dir, "accounts.db"))
	if err != nil {
		return nil, err
	}
	h := &Hub{
		dir:        dir,
		acc:        acc,
		gw:         gateway.NewShared(acc, filepath.Join(dir, "gateway"), routingcfg.NewStore(dir).Load()),
		routingCfg: routingcfg.NewStore(dir),
		gwKeys:     gatewaykeys.NewStore(dir),
		gwScope:    gatewaycfg.NewStore(dir),
		sources:    takeover.NewSourceStore(dir),
		instances:  instance.NewStore(dir),
		platform:   platform,
		providers:  map[account.Provider]*providerCtx{},
		refreshCfg: refreshcfg.NewStore(dir),
		modelProv:  modelprovider.NewStore(dir),

		alertStore:    economy.NewAlertStore(dir),
		switchStore:   newSwitchConfigStore(dir),
		speedStore:    economy.NewSpeedStore(dir),
		codexSettings: codexsettings.NewStore(dir),

		groups:    accountgroups.NewStore(dir),
		agHistory: aghistory.NewStore(dir),
	}
	// 把持久化的访问 key / 局域网范围套到网关上(网关此刻未启动,仅记录;Start 时生效)。
	_ = h.gw.SetAPIKeys(h.gwKeys.Values())
	_ = h.gw.SetHost(h.gwScope.Load().Host())
	h.providers[account.ProviderCodex] = h.mkProvider(account.ProviderCodex, codexauth.Login, quota.NewCodexRefresher(quota.CodexEndpoints{}))
	h.providers[account.ProviderAntigravity] = h.mkProvider(account.ProviderAntigravity, antigravityauth.Login, quota.NewAntigravityRefresher(quota.AntigravityEndpoints{}))
	// 配额自动刷新:后台 ticker 按「配额自动刷新」间隔遍历各 provider 刷额度。
	h.autoRefresh = newAutoRefresher(h, h.refreshCfg.Load())
	h.autoRefresh.start(context.Background())
	return h, nil
}

func (h *Hub) mkProvider(p account.Provider, login manager.LoginFunc, refresher manager.Refresher) *providerCtx {
	mgr := manager.New(h.acc, h.gw, p, login)
	mgr.SetRefresher(refresher)

	// 续约保活:逐个 pool_enabled 自有号刷 token(防过期)+ 轻探额度,
	// 续约成功就持久化新过期时刻,返回给 wakeup history(NewExpiry)。
	keepAlive := func(ctx context.Context, a *account.Account) (int64, error) {
		if a.AuthKind == account.AuthAPIKey {
			return 0, nil // API Key 号无 token 续约,视为存活。
		}
		if refresher.TokenExpired(a) {
			if err := refresher.RefreshToken(a); err != nil {
				return 0, err
			}
			if err := h.acc.Update(a); err != nil {
				return a.Expiry, err
			}
		}
		// 轻探额度(codex 真去上游 wham/usage;antigravity 满血占位)。
		if _, err := refresher.FetchQuota(a); err != nil {
			return a.Expiry, err
		}
		return a.Expiry, nil
	}
	accountsFn := func() []*account.Account {
		l, _ := h.acc.ListPoolEnabled(p)
		return l
	}
	wk := wakeup.New(keepAlive, accountsFn)
	wkCfg := wakeup.NewConfigStore(h.dir, string(p))
	wk.SetConfig(wkCfg.Load())
	wk.Start(context.Background(), time.Minute)
	// 保活验证 + 单号测试:复用同一 keepAlive(真 token 续约 + 轻探额度),
	// 按 id 解析账号 = acc.Get。历史/状态各 provider 独立落盘。
	wkVerify := wakeup.NewVerification(h.dir, string(p), keepAlive, func(id string) (*account.Account, error) {
		return h.acc.Get(id)
	})
	return &providerCtx{mgr: mgr, wk: wk, wkCfg: wkCfg, wkVerify: wkVerify, refresher: refresher}
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
	if err := pc.mgr.DeleteAccount(id); err != nil {
		return err
	}
	h.cleanupAccountGroups()
	return nil
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

// CurrentAccount 返回某 provider 的当前(优先级)号视图;空池返回 (nil,nil)。
// 对齐 cockpit accounts.current。
func (h *Hub) CurrentAccount(p account.Provider) (*manager.AccountView, error) {
	pc, err := h.ctx(p)
	if err != nil {
		return nil, err
	}
	cur, err := pc.mgr.Current()
	if err != nil || cur == nil {
		return nil, err
	}
	v := manager.ToView(cur)
	return &v, nil
}

// SetCurrentAccount 显式设当前号(= 设优先出口,并清同 provider 其它号优先)。
// codex 处于 local 接管态时重注入新当前号到 ~/.codex/auth.json。对齐 cockpit accounts.setCurrent。
func (h *Hub) SetCurrentAccount(p account.Provider, id string) error {
	pc, err := h.ctx(p)
	if err != nil {
		return err
	}
	if err := pc.mgr.SetCurrent(id); err != nil {
		return err
	}
	h.reinjectIfLocal(p)
	return nil
}

// ReorderAccounts 按 ids 顺序持久化某 provider 账号排序(未列出的排末尾)。
// 对齐 cockpit accounts.reorder。
func (h *Hub) ReorderAccounts(p account.Provider, ids []string) error {
	pc, err := h.ctx(p)
	if err != nil {
		return err
	}
	return pc.mgr.Reorder(ids)
}

// reinjectIfLocal 若某 provider 当前为 local 接管态,重注入其当前号(切当前号需同步本机注入)。
func (h *Hub) reinjectIfLocal(p account.Provider) {
	if h.sources.Get(string(p)) != takeover.SourceLocal {
		return
	}
	switch p {
	case account.ProviderCodex:
		if tok, err := h.pickCodexToken(); err == nil {
			_ = h.platform.CodexRestoreAccount()
			_ = h.platform.CodexInjectAccount(tok)
		}
	case account.ProviderAntigravity:
		if tok, err := h.pickAntigravityToken(); err == nil {
			_ = h.injectAntigravityToTarget(tok)
		}
	}
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

// ── 反代运营:路由策略 / 访问 key / 局域网范围 / 请求日志 / 连通测试 ──
// 红线:全部只服务 codex 自有号网关;不碰远程租号路径。

// GetRoutingStrategy 返回当前路由(选号)策略。
func (h *Hub) GetRoutingStrategy() string { return string(h.routingCfg.Load()) }

// SetRoutingStrategy 校验并持久化路由策略,热切换到运行中的网关(无需重启)。
func (h *Hub) SetRoutingStrategy(s string) error {
	// 拒绝无法识别为已知策略的输入(Normalize 会把未知折成默认,这里显式校验)。
	if !routingcfg.IsKnown(s) {
		return fmt.Errorf("hub: 未知路由策略 %q", s)
	}
	strategy := routingcfg.Normalize(s)
	if err := h.routingCfg.Save(strategy); err != nil {
		return err
	}
	h.gw.SetStrategy(strategy)
	return nil
}

// ListGatewayKeys 返回客户端访问 key 列表。
func (h *Hub) ListGatewayKeys() []gatewaykeys.Key { return h.gwKeys.List() }

// CreateGatewayKey 新建一条访问 key,并把更新后的列表写入网关(重启生效)。
func (h *Hub) CreateGatewayKey(name string) (gatewaykeys.Key, error) {
	k, err := h.gwKeys.Create(name)
	if err != nil {
		return gatewaykeys.Key{}, err
	}
	if err := h.gw.SetAPIKeys(h.gwKeys.Values()); err != nil {
		return gatewaykeys.Key{}, err
	}
	return k, nil
}

// DeleteGatewayKey 删除一条访问 key,并把更新后的列表写入网关(重启生效)。
func (h *Hub) DeleteGatewayKey(id string) error {
	if err := h.gwKeys.Delete(id); err != nil {
		return err
	}
	return h.gw.SetAPIKeys(h.gwKeys.Values())
}

// RotateGatewayKey 重置一条访问 key 的值,并把更新后的列表写入网关(重启生效)。
func (h *Hub) RotateGatewayKey(id string) (gatewaykeys.Key, error) {
	k, err := h.gwKeys.Rotate(id)
	if err != nil {
		return gatewaykeys.Key{}, err
	}
	if err := h.gw.SetAPIKeys(h.gwKeys.Values()); err != nil {
		return gatewaykeys.Key{}, err
	}
	return k, nil
}

// GetGatewayAccessScope 返回局域网范围(local=仅本机 / lan=局域网)。
func (h *Hub) GetGatewayAccessScope() string { return string(h.gwScope.Load()) }

// SetGatewayAccessScope 校验并持久化局域网范围,改网关绑定主机(重启生效)。
func (h *Hub) SetGatewayAccessScope(scope string) error {
	if !gatewaycfg.IsKnown(scope) {
		return fmt.Errorf("hub: 未知访问范围 %q", scope)
	}
	sc := gatewaycfg.Normalize(scope)
	if err := h.gwScope.Save(sc); err != nil {
		return err
	}
	return h.gw.SetHost(sc.Host())
}

// QueryGatewayLogs 分页 + 过滤查询请求日志。filterJSON 为空表示无额外过滤。
func (h *Hub) QueryGatewayLogs(offset, limit int, filterJSON string) (stats.LogPage, error) {
	f := stats.QueryFilter{Offset: offset, Limit: limit}
	if s := strings.TrimSpace(filterJSON); s != "" {
		if err := json.Unmarshal([]byte(s), &f); err != nil {
			return stats.LogPage{}, fmt.Errorf("hub: 解析过滤条件失败: %w", err)
		}
		f.Offset, f.Limit = offset, limit // offset/limit 以显式参数为准
	}
	page := h.gw.Stats0().Query(f)
	emails := h.accountEmails(account.ProviderCodex)
	for i := range page.Entries {
		if e, ok := emails[page.Entries[i].AuthID]; ok {
			page.Entries[i].Email = e
		}
	}
	return page, nil
}

// ClearGatewayStats 清空网关统计与请求日志。
func (h *Hub) ClearGatewayStats() error {
	h.gw.Stats0().Clear()
	return nil
}

// GatewayConnTest 对本地网关发一个最小真请求,返回连通结果。
func (h *Hub) GatewayConnTest() gateway.ConnTestResult { return h.gw.ConnTest() }

func (h *Hub) accountEmails(p account.Provider) map[string]string {
	list, _ := h.acc.List(p)
	emails := make(map[string]string, len(list))
	for _, ac := range list {
		emails[ac.ID] = ac.Email
	}
	return emails
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
		switch p {
		case account.ProviderCodex:
			// codex 'local' = 注入式接管:挑一个自有号直接写进 ~/.codex/auth.json,
			// 真 codex CLI 直连 OpenAI。不碰反代网关(反代是单独功能,反代 tab 自开自关)。
			tok, err := h.pickCodexToken()
			if err != nil {
				return err
			}
			_ = h.platform.CodexRestoreAccount()
			if err := h.platform.CodexInjectAccount(tok); err != nil {
				return err
			}
		case account.ProviderAntigravity:
			// antigravity 'local' = 不走网关:挑一个自有号直接注入目标 app 的 state.vscdb。
			tok, err := h.pickAntigravityToken()
			if err != nil {
				return err
			}
			if err := h.injectAntigravityToTarget(tok); err != nil {
				return err
			}
		}
	} else {
		// 还原:仅撤注入。网关生命周期与接管解耦——不在此处停网关(反代 tab 独立控制)。
		switch p {
		case account.ProviderCodex:
			_ = h.platform.CodexRestoreAccount()
		case account.ProviderAntigravity:
			h.restoreAntigravityAll()
		}
	}
	if err := h.sources.Set(string(p), src); err != nil {
		return err
	}
	// 切换接管源后重启对应客户端,让注入/还原的登录真正生效。
	h.restartClientAfterSwitch(p)
	return nil
}

// restartClientAfterSwitch 切换接管源后重启对应客户端,让注入的新登录生效:
//   - antigravity:IDE 常驻、把 state.vscdb 缓存在内存,若在跑则重启(停+起)才会重读新号;
//     没在跑就不动(下次用户自己打开即读到新态)。
//   - codex:CLI 每次运行自读 auth.json 无需重启;仅当用户开了「切换时启动 Codex App」才重启常驻 GUI。
func (h *Hub) restartClientAfterSwitch(p account.Provider) {
	switch p {
	case account.ProviderAntigravity:
		// 重启当前注入目标 app(IDE 或独立版),让它重读 state.vscdb 里的新号;没在跑就不动。
		target := h.GetAntigravityTarget()
		if h.platform.AntigravityAppRunning(target) {
			_ = h.platform.AntigravityAppStop(target)
			_ = h.platform.AntigravityAppStart(target)
		}
	case account.ProviderCodex:
		cs := h.GetCodexSettings()
		if cs.LaunchOnSwitch {
			_ = h.platform.CodexRestartApp()
		}
		// 切号后联动重启用户指定的应用(如自建 IDE/编辑器);未开或未配路径则跳过。
		if cs.RestartAppOnSwitch && strings.TrimSpace(cs.RestartAppPath) != "" {
			_ = h.platform.RestartSpecifiedApp(cs.RestartAppPath)
		}
	}
}

// pickCodexToken 选要注入的 codex 自有号:优先级号,否则第一个进池号。
func (h *Hub) pickCodexToken() (CodexToken, error) {
	list, err := h.acc.ListPoolEnabled(account.ProviderCodex)
	if err != nil {
		return CodexToken{}, err
	}
	if len(list) == 0 {
		return CodexToken{}, errors.New("hub: 没有可用的 codex 自有号(请先登录并进池)")
	}
	chosen := list[0]
	for _, a := range list {
		if a.Priority {
			chosen = a
			break
		}
	}
	return CodexToken{
		AuthKind:     string(chosen.AuthKind),
		IDToken:      chosen.IDToken,
		AccessToken:  chosen.AccessToken,
		RefreshToken: chosen.RefreshToken,
		AccountID:    chosen.AccountID,
		APIKey:       chosen.APIKey,
	}, nil
}

// pickAntigravityToken 选要注入的 antigravity 自有号:优先级号,否则第一个进池号。
func (h *Hub) pickAntigravityToken() (AntigravityToken, error) {
	list, err := h.acc.ListPoolEnabled(account.ProviderAntigravity)
	if err != nil {
		return AntigravityToken{}, err
	}
	if len(list) == 0 {
		return AntigravityToken{}, errors.New("hub: 没有可用的 antigravity 自有号(请先登录并进池)")
	}
	chosen := list[0]
	for _, a := range list {
		if a.Priority {
			chosen = a
			break
		}
	}
	return AntigravityToken{
		AccessToken:  chosen.AccessToken,
		RefreshToken: chosen.RefreshToken,
		IDToken:      chosen.IDToken,
		Email:        chosen.Email,
		ProjectID:    chosen.ProjectID,
		Expiry:       chosen.Expiry,
		IsGCPTos:     chosen.IsGCPTos,
	}, nil
}

// ── 按号额度刷新(真去上游,移植 cockpit;持久化回填) ──

// RefreshAccountQuota 刷新单个账号额度(按 id,provider 无关)。
func (h *Hub) RefreshAccountQuota(id string) error {
	a, err := h.acc.Get(id)
	if err != nil {
		return err
	}
	pc, err := h.ctx(a.Provider)
	if err != nil {
		return err
	}
	if err := pc.mgr.RefreshQuota(id); err != nil {
		return err
	}
	if a.Provider == account.ProviderCodex {
		h.maybeAutoSwitchCodex()
	}
	return nil
}

// RefreshAllQuotas 刷新某 provider 的所有 pool_enabled 自有号额度,返回成功数量。
// codex 刷完后顺带触发一次自动切号评估(超额则切到更空闲的号 + 重注入)。
func (h *Hub) RefreshAllQuotas(p account.Provider) (int, error) {
	pc, err := h.ctx(p)
	if err != nil {
		return 0, err
	}
	n, err := pc.mgr.RefreshAllQuotas()
	if p == account.ProviderCodex {
		h.maybeAutoSwitchCodex()
	}
	return n, err
}

// ── 自动刷新间隔(配额自动刷新 / 当前账号刷新,分钟) ──

func (h *Hub) GetRefreshConfig() refreshcfg.Config { return h.refreshCfg.Load() }

func (h *Hub) SetRefreshConfig(quotaMinutes, currentMinutes int) (refreshcfg.Config, error) {
	cfg := refreshcfg.Config{QuotaMinutes: quotaMinutes, CurrentMinutes: currentMinutes}
	if err := h.refreshCfg.Save(cfg); err != nil {
		return refreshcfg.Config{}, err
	}
	saved := h.refreshCfg.Load()
	if h.autoRefresh != nil {
		h.autoRefresh.setConfig(saved)
	}
	return saved, nil
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
