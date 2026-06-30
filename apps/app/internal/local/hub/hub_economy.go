package hub

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/codexsettings"
	"bcai-wails/internal/local/economy"
	"bcai-wails/internal/local/takeover"
)

// 经济与自动化(① 超额预警 ② 自动切号 ③ 速度档)的薄委托 + 集成。
//
// economy 包是自包含纯逻辑:它用自己的 economy.AccountView 而不耦合 account.Account。
// 本文件负责适配 account.Account -> economy.AccountView,并把「自动切号」接到额度刷新路径:
// codex 额度刷完(RefreshAllQuotas / RefreshAccountQuota)后调 maybeAutoSwitchCodex,
// 超额时切到更空闲的号(置优先级 + 若处于 local 接管则重注入)。
//
// 红线:自动切号只动 codex 自有号的优先级与本机注入,不碰远程租号 / proxy.go / 网关出口。

// ── account.Account -> economy.AccountView 适配 ──

// economyView 把一个本地号适配成 economy 的只读视图。
// HourlyPercent/WeeklyPercent 在 account 里已是「剩余」百分比(0..100),与 economy 约定一致。
// 窗口存在性:用 reset_at(>0 表示上游返回了该窗口)反推;两者皆 0 时留 nil(未知,回退两窗口)。
// Cooling:QuotaStatus cooling/exhausted 或 BlockedUntil(unix ms)未过期。
func economyView(a *account.Account) economy.AccountView {
	v := economy.AccountView{
		ID:            a.ID,
		Email:         a.Email,
		HasQuota:      a.QuotaStatus != "",
		HourlyPercent: a.HourlyPercent,
		WeeklyPercent: a.WeeklyPercent,
		Cooling:       isCooling(a),
		LastUsedAt:    a.LastUsedAt,
	}
	if a.HourlyResetAt > 0 || a.WeeklyResetAt > 0 {
		hp := a.HourlyResetAt > 0
		wp := a.WeeklyResetAt > 0
		v.HourlyWindowPresent = &hp
		v.WeeklyWindowPresent = &wp
	}
	return v
}

func isCooling(a *account.Account) bool {
	if a.QuotaStatus == account.QuotaCooling || a.QuotaStatus == account.QuotaExhausted {
		return true
	}
	return a.BlockedUntil > 0 && a.BlockedUntil > time.Now().UnixMilli()
}

func (h *Hub) economyViews(p account.Provider) ([]economy.AccountView, error) {
	list, err := h.acc.List(p)
	if err != nil {
		return nil, err
	}
	out := make([]economy.AccountView, 0, len(list))
	for _, a := range list {
		out = append(out, economyView(a))
	}
	return out, nil
}

// ── ① 超额预警 ──

// GetAlertConfig 返回当前超额预警配置。
func (h *Hub) GetAlertConfig() economy.AlertConfig { return h.alertStore.Load() }

// SetAlertConfig 持久化超额预警配置,返回落盘后的值。
func (h *Hub) SetAlertConfig(cfg economy.AlertConfig) (economy.AlertConfig, error) {
	if err := h.alertStore.Save(cfg); err != nil {
		return economy.AlertConfig{}, err
	}
	return h.alertStore.Load(), nil
}

// EvaluateAlert 对某 provider 的当前(优先级)号求一次预警判定。
// 纯判定,不派发通知(派发/节流由调用方或前端负责)。无当前号时返回空结果。
func (h *Hub) EvaluateAlert(p account.Provider) (economy.AlertResult, error) {
	cfg := h.alertStore.Load()
	cur, err := h.currentAccount(p)
	if err != nil {
		return economy.AlertResult{}, err
	}
	if cur == nil {
		return economy.AlertResult{}, nil
	}
	return economy.ShouldAlert(cfg, economyView(cur)), nil
}

// ── ② 自动切号 ──

// GetSwitchConfig 返回当前自动切号配置。
func (h *Hub) GetSwitchConfig() economy.SwitchConfig { return h.switchStore.Load() }

// SetSwitchConfig 持久化自动切号配置,返回落盘后的值。
func (h *Hub) SetSwitchConfig(cfg economy.SwitchConfig) (economy.SwitchConfig, error) {
	if err := h.switchStore.Save(cfg); err != nil {
		return economy.SwitchConfig{}, err
	}
	return h.switchStore.Load(), nil
}

// maybeAutoSwitchCodex 在 codex 额度刷新后评估自动切号:
// 关闭/无当前号/未超额则不动;命中阈值且有更空闲候选时,把候选置为优先级号,
// 并在 codex 处于 local 接管态时重注入到 ~/.codex/auth.json。
func (h *Hub) maybeAutoSwitchCodex() {
	cfg := h.switchStore.Load()
	if !cfg.Enabled {
		return
	}
	views, err := h.economyViews(account.ProviderCodex)
	if err != nil {
		return
	}
	cur, err := h.currentAccount(account.ProviderCodex)
	if err != nil || cur == nil {
		return
	}
	target := economy.PickAutoSwitch(cfg, views, cur.ID)
	if target == nil || target.ID == cur.ID {
		return
	}
	pc, err := h.ctx(account.ProviderCodex)
	if err != nil {
		return
	}
	if err := pc.mgr.SetPriority(target.ID); err != nil {
		return
	}
	// 若当前是 local 接管态,重注入新优先级号(SetPriority 不碰 ~/.codex/auth.json)。
	if h.sources.Get(string(account.ProviderCodex)) == takeover.SourceLocal {
		if tok, err := h.pickCodexToken(); err == nil {
			_ = h.platform.CodexRestoreAccount()
			_ = h.platform.CodexInjectAccount(tok)
		}
	}
}

// currentAccount 返回某 provider 的「当前号」:优先级号;无优先级则第一个进池号;都无返回 nil。
func (h *Hub) currentAccount(p account.Provider) (*account.Account, error) {
	list, err := h.acc.ListPoolEnabled(p)
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, nil
	}
	for _, a := range list {
		if a.Priority {
			return a, nil
		}
	}
	return list[0], nil
}

// ── ③ 速度档 ──

// GetAppSpeed 返回当前速度档配置(上下文预设 + service tier)。
func (h *Hub) GetAppSpeed() economy.AppSpeed { return h.speedStore.Load() }

// SetAppSpeed 持久化速度档偏好,并真正落地到 Codex 的 config.toml(否则「快速」只是好看的开关):
//   - service tier(fast/standard)→ [desktop].default-service-tier + 全局原子态(对齐 cockpit);
//   - 仅当用户用「自定义」明确指定上下文窗口时才写 model_context_window —— 默认/快速不碰,
//     免得和「设置」里的 1M 上下文开关(LocalSaveCodexQuickConfig)互相覆盖。
func (h *Hub) SetAppSpeed(s economy.AppSpeed) (economy.AppSpeed, error) {
	if err := h.speedStore.Save(s); err != nil {
		return economy.AppSpeed{}, err
	}
	saved := h.speedStore.Load()
	if err := codexsettings.SaveCurrentServiceTier(saved.Tier == economy.TierFast); err != nil {
		return saved, err
	}
	if saved.ContextPreset == economy.PresetCustom {
		if mcw, acl := saved.ContextValues(); mcw != nil || acl != nil {
			if _, err := codexsettings.SaveCurrentQuickConfig(mcw, acl); err != nil {
				return saved, err
			}
		}
	}
	return saved, nil
}

// ── 自动切号配置的 JSON 持久化(economy.SwitchConfig 自身无 Store) ──

const switchConfigFile = "auto-switch-config.json"

type switchConfigStore struct {
	path string
	mu   sync.Mutex
}

func newSwitchConfigStore(dir string) *switchConfigStore {
	return &switchConfigStore{path: filepath.Join(dir, switchConfigFile)}
}

// switchConfigJSON 是 economy.SwitchConfig 的 camelCase 落盘形态(前端直读)。
type switchConfigJSON struct {
	Enabled            bool     `json:"enabled"`
	ThresholdPct       int      `json:"thresholdPct"`
	ScopeMode          string   `json:"scopeMode"`
	SelectedAccountIDs []string `json:"selectedAccountIds"`
}

func (s *switchConfigStore) Load() economy.SwitchConfig {
	s.mu.Lock()
	defer s.mu.Unlock()
	j := switchConfigJSON{ScopeMode: string(economy.ScopeAll)}
	if data, err := os.ReadFile(s.path); err == nil {
		_ = json.Unmarshal(data, &j)
	}
	return economy.SwitchConfig{
		Enabled:            j.Enabled,
		ThresholdPct:       j.ThresholdPct,
		ScopeMode:          economy.ScopeMode(j.ScopeMode),
		SelectedAccountIDs: j.SelectedAccountIDs,
	}
}

func (s *switchConfigStore) Save(c economy.SwitchConfig) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	scope := c.ScopeMode
	if scope != economy.ScopeSelected {
		scope = economy.ScopeAll
	}
	j := switchConfigJSON{
		Enabled:            c.Enabled,
		ThresholdPct:       c.ThresholdPct,
		ScopeMode:          string(scope),
		SelectedAccountIDs: c.SelectedAccountIDs,
	}
	data, err := json.MarshalIndent(j, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
