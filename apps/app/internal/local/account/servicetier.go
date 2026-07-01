package account

import "strings"

// NormalizeServiceTier 把任意服务档字符串归一为本地存储值:
//   - {fast, priority, flex}(大小写不敏感)→ "fast"(= 上游 service_tier "priority");
//   - 其余(空 / standard / default / 未知)→ ""(继承/标准档)。
//
// 对齐 cockpit codex_speed.rs normalize_service_tier_speed。存储用最小集("" / "fast"),
// 出口映射(fast→"priority")在真正注入 service_tier 时再做(见 authsync egress TODO)。
func NormalizeServiceTier(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "fast", "priority", "flex":
		return "fast"
	default:
		return ""
	}
}

// ServiceTierFast 报告某档是否为「快速」(= 出口需带 service_tier:"priority")。
func ServiceTierFast(s string) bool { return NormalizeServiceTier(s) == "fast" }
