package authsync

import (
	"testing"

	"bcai-wails/internal/local/account"
)

// accountRemainingPct 取「更紧的剩余窗口」(min),字段本就是剩余%。
// 回归:旧实现是 100-max(把剩余当已用 + max),会把流量打到快用尽的号。
func TestAccountRemainingPct_MinOfRemaining(t *testing.T) {
	cases := []struct {
		hourly, weekly, want int
	}{
		{70, 20, 20}, // 周更紧 → 取 20(旧 bug:100-max(70,20)=30)
		{20, 70, 20}, // 小时更紧 → 取 20
		{100, 100, 100},
		{0, 0, 0},   // 真用尽
		{80, 80, 80},
	}
	for _, c := range cases {
		got := accountRemainingPct(&account.Account{HourlyPercent: c.hourly, WeeklyPercent: c.weekly})
		if got != c.want {
			t.Errorf("remaining(hourly=%d,weekly=%d)=%d, want %d", c.hourly, c.weekly, got, c.want)
		}
	}
}
