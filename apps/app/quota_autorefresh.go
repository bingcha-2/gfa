package main

import (
	"sync"
	"time"
)

// QuotaAutoRefreshInterval 后台自动刷新上游额度的周期。手动「刷新」走 App.RefreshQuota;
// 此 loop 让闲置(不主动发请求)时,血条与服务端也能每 30min 同步一次上游真实余量并上报。
//
// 背景:额度刷新原本是「按需」(搭真实用量上报的车 + 激活时 force 一次),刻意不定时轮询,以免
// 闲置时空打上游(当年 5min 心跳 + codex usage 401 刷屏的来源)。这里加回一个低频(30min,远长
// 于当年被诟病的 5min)兜底:只在已登录且卡可用时跑,且 RefreshQuotaNow 内部按 products 守卫
// (未开 codex/anthropic 不会去打对应端点),不会重现当年的刷屏。
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
				Log("[quota-autorefresh] 周期性刷新上游额度并上报")
				l.RefreshQuotaNow(cfg.UserToken, cfg.DeviceId, "")
			}
		}()
	})
}
