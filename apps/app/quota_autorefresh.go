package main

import (
	"sync"
	"time"
)

// QuotaAutoRefreshInterval 后台自动刷新“可独立查询”的上游额度周期。手动刷新走
// App.RefreshQuota；Claude没有独立额度接口，因此不会在这个loop里空租Token。
//
// 背景:额度刷新原本是「按需」(搭真实用量上报的车 + 激活时 force 一次),刻意不定时轮询,以免
// 闲置时空打上游(当年5min心跳 + codex usage 401刷屏的来源)。这里只给Codex/Antigravity
// 保留30min兜底，并按产品授权守卫。
const QuotaAutoRefreshInterval = 30 * time.Minute

var quotaRefreshOnce sync.Once

// startQuotaRefreshLoop 启动常驻的额度自动刷新 goroutine(进程级,随 app 退出结束)。幂等:
// 多次调用只起一个。登录态/卡可用态每个周期实时重读 —— 登出或订阅失效时自动跳过,无需显式停止。
func startQuotaRefreshLoop() {
	quotaRefreshOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(QuotaAutoRefreshInterval)
			defer ticker.Stop()
			for range ticker.C {
				cfg := LoadConfig()
				if cfg.UserToken == "" {
					continue // 未登录:不刷
				}
				l := GetLeaser()
				if l.IsCardUnusable() {
					continue // 订阅失效/卡不可用:已停租号,别空打上游
				}
				Log("[quota-autorefresh] 周期性刷新可主动查询的上游额度并上报")
				l.RefreshQuotaInBackground(cfg.UserToken, cfg.DeviceId, "")
			}
		}()
	})
}
