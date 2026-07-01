package economy

import "sort"

// ScopeMode 是自动切号的监控范围(照搬 codex_auto_switch_account_scope_mode)。
type ScopeMode string

const (
	ScopeAll      ScopeMode = "all"
	ScopeSelected ScopeMode = "selected"
)

// SwitchConfig 是自动切号配置。ThresholdPct 为「剩余」百分比阈值:
// 当前号任一窗口剩余 <= 阈值(或处于冷却)即需切号;候选号须所有窗口剩余 > 阈值且未冷却。
type SwitchConfig struct {
	Enabled            bool
	ThresholdPct       int
	ScopeMode          ScopeMode
	SelectedAccountIDs []string
}

func normalizeScope(m ScopeMode) ScopeMode {
	if m == ScopeSelected {
		return ScopeSelected
	}
	return ScopeAll
}

// monitoredSet 移植 resolve_monitored_auto_switch_account_ids:
// all 模式 = 全部存在的号;selected 模式 = 选中且存在的号(去重去空)。
func monitoredSet(cfg SwitchConfig, accounts []AccountView) map[string]bool {
	out := map[string]bool{}
	if normalizeScope(cfg.ScopeMode) != ScopeSelected {
		for _, a := range accounts {
			out[a.ID] = true
		}
		return out
	}
	exists := map[string]bool{}
	for _, a := range accounts {
		exists[a.ID] = true
	}
	seen := map[string]bool{}
	for _, id := range cfg.SelectedAccountIDs {
		if id == "" || seen[id] || !exists[id] {
			continue
		}
		seen[id] = true
		out[id] = true
	}
	return out
}

type switchCandidate struct {
	account    AccountView
	minMargin  int
	minPercent int
	avgPercent float64
}

// buildCandidate 移植 build_switch_candidate:候选须有配额、所有窗口剩余 > 阈值;
// 计算 min_margin / min_percentage / average_percentage。冷却号不作候选。
func buildCandidate(a AccountView, threshold int) *switchCandidate {
	if a.Cooling {
		return nil
	}
	metrics := a.quotaMetrics()
	if len(metrics) == 0 {
		return nil
	}
	minMargin := 1 << 30
	minPercent := 1 << 30
	for _, m := range metrics {
		if m.percentage <= threshold { // 任一窗口不达标即淘汰
			return nil
		}
		if margin := m.percentage - threshold; margin < minMargin {
			minMargin = margin
		}
		if m.percentage < minPercent {
			minPercent = m.percentage
		}
	}
	return &switchCandidate{
		account:    a,
		minMargin:  minMargin,
		minPercent: minPercent,
		avgPercent: averagePercentage(metrics),
	}
}

// pickBest 移植 pick_best_candidate 的排序:
// min_margin desc -> min_percentage desc -> average_percentage desc -> last_used asc(最久未用优先)。
func pickBest(cands []switchCandidate) *AccountView {
	if len(cands) == 0 {
		return nil
	}
	sort.SliceStable(cands, func(i, j int) bool {
		a, b := cands[i], cands[j]
		if a.minMargin != b.minMargin {
			return a.minMargin > b.minMargin
		}
		if a.minPercent != b.minPercent {
			return a.minPercent > b.minPercent
		}
		if a.avgPercent != b.avgPercent {
			return a.avgPercent > b.avgPercent
		}
		return a.account.LastUsedAt < b.account.LastUsedAt
	})
	winner := cands[0].account
	return &winner
}

// PickAutoSwitch 是纯函数:照搬 pick_auto_switch_target_if_needed 的判定 + 选号。
// 返回应切换到的目标号;无需切换或无可用候选时返回 nil。
func PickAutoSwitch(cfg SwitchConfig, accounts []AccountView, currentID string) *AccountView {
	if !cfg.Enabled {
		return nil
	}
	threshold := clampPct(cfg.ThresholdPct)

	monitored := monitoredSet(cfg, accounts)
	if len(monitored) == 0 || !monitored[currentID] {
		return nil
	}

	var current *AccountView
	for i := range accounts {
		if accounts[i].ID == currentID {
			current = &accounts[i]
			break
		}
	}
	if current == nil {
		return nil
	}

	if !shouldSwitch(*current, threshold) {
		return nil
	}

	var cands []switchCandidate
	for _, a := range accounts {
		if a.ID == currentID || !monitored[a.ID] {
			continue
		}
		if c := buildCandidate(a, threshold); c != nil {
			cands = append(cands, *c)
		}
	}
	return pickBest(cands)
}

// shouldSwitch 移植「当前号是否命中阈值」:冷却即切;否则任一窗口剩余 <= 阈值即切。
func shouldSwitch(current AccountView, threshold int) bool {
	if current.Cooling {
		return true
	}
	metrics := current.quotaMetrics()
	if len(metrics) == 0 {
		return false
	}
	for _, m := range metrics {
		if m.percentage <= threshold {
			return true
		}
	}
	return false
}
