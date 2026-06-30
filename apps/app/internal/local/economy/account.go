// Package economy 直接照 cockpit 移植「经济与自动化」三件套的纯逻辑 + 持久化:
//
//  1. 超额预警(ShouldAlert / AlertConfig)
//     移植自 cockpit crates/cockpit-core/src/modules/codex_account.rs::run_quota_alert_if_needed —
//     取当前号配额指标,任一窗口剩余 <= 阈值即预警。
//  2. 自动切号(PickAutoSwitch / SwitchConfig)
//     移植自同文件 pick_auto_switch_target_if_needed + build_switch_candidate + pick_best_candidate;
//     当前号超额/冷却时按 (min_margin, min_percentage, average_percentage, 最久未用) 选下一个可用号。
//  3. 速度档(AppSpeed / ResolveContextPreset / ServiceTierValue)
//     移植自 codex_speed.rs(service tier:Fast->priority、Standard->删键)+ QuickSettingsPopover.tsx
//     的上下文预设(default/516K/1M/自定义 -> model_context_window + model_auto_compact_token_limit)。
//
// 设计约束:
//   - 本包自包含、可独立 go test:不 import account 包,改用包内 AccountView 视图,
//     由集成层(hub/bindings)把 account.Account 适配进来。
//   - 三件套均为纯函数 + JSON 持久化,无上游 HTTP。若后续需要上游调用,
//     一律通过注入的 *http.Client,绝不走远程租号路径。
package economy

const (
	metricPrimary   = "primary_window"
	metricSecondary = "secondary_window"
)

// AccountView 是 economy 包对一个本地号的只读视图。
// 集成层从 account.Account 适配:HourlyPercent/WeeklyPercent 为「剩余」百分比(0..100),
// 越大越空闲(照搬 cockpit remaining = 100 - used 语义)。
type AccountView struct {
	ID            string
	Email         string
	HasQuota      bool
	HourlyPercent int
	WeeklyPercent int
	// 窗口存在性:nil 表示未知(回退到两个窗口都计入)。
	HourlyWindowPresent *bool
	WeeklyWindowPresent *bool
	// Cooling 表示该号处于冷却/封禁,等价于 account.QuotaStatus cooling/exhausted 或 BlockedUntil 未过期。
	Cooling    bool
	LastUsedAt int64
}

type quotaMetric struct {
	key        string
	percentage int
}

func clampPct(v int) int {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

// quotaMetrics 照搬 extract_quota_metrics:依据窗口存在性挑选 primary/secondary 指标,
// 百分比裁剪到 0..100;无配额返回空。
func (a AccountView) quotaMetrics() []quotaMetric {
	if !a.HasQuota {
		return nil
	}
	hasPresence := a.HourlyWindowPresent != nil || a.WeeklyWindowPresent != nil
	var metrics []quotaMetric

	if !hasPresence || (a.HourlyWindowPresent != nil && *a.HourlyWindowPresent) {
		metrics = append(metrics, quotaMetric{key: metricPrimary, percentage: clampPct(a.HourlyPercent)})
	}
	if !hasPresence || (a.WeeklyWindowPresent != nil && *a.WeeklyWindowPresent) {
		metrics = append(metrics, quotaMetric{key: metricSecondary, percentage: clampPct(a.WeeklyPercent)})
	}
	if len(metrics) == 0 {
		metrics = append(metrics, quotaMetric{key: metricPrimary, percentage: clampPct(a.HourlyPercent)})
	}
	return metrics
}

func averagePercentage(metrics []quotaMetric) float64 {
	if len(metrics) == 0 {
		return 0
	}
	sum := 0
	for _, m := range metrics {
		sum += m.percentage
	}
	return float64(sum) / float64(len(metrics))
}
