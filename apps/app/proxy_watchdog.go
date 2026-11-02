package main

import "time"

// proxyWatchdogInterval 是自愈巡检周期。够快(用户几秒内就恢复、横幅自动消失),
// 又不至于在持续失败时空转太凶。
const proxyWatchdogInterval = 5 * time.Second

// startProxyWatchdog 启动后台自愈巡检:周期性检查本地代理"该运行却没运行"的情况并重试拉起。
// 解决两类问题:
//   - HTTP 代理(48800)启动时被占/绑不上、或运行中 Serve 挂掉 → 永久 down、要用户手动重启;
//
// 一旦重新跑起来,proxyRunning 翻 true,"本地代理未启动"横幅会在下一次 GetStats 轮询自动消失。
// 单 goroutine 串行执行,Start/StartProxy 内部各有 startMu/锁,不会并发重入。
func startProxyWatchdog() {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				Log("[watchdog] panic 已恢复: %v", r)
			}
		}()
		for {
			time.Sleep(proxyWatchdogInterval)
			runProxyWatchdogOnce()
		}
	}()
}

// runProxyWatchdogOnce 跑一轮自愈检查(拆出来便于单测/复用)。
func runProxyWatchdogOnce() {
	cfg := LoadConfig()

	// ① HTTP 代理:已登录却没在跑 → 重试 Start(内部含端口兜底)。
	// 账号制:凭据是 UserToken(卡密 AccountCard 已下线,运行时不再用于鉴权)。
	if cfg.UserToken != "" && !GetHTTPProxy().GetStatus().Running {
		Log("[watchdog] HTTP 代理未运行,尝试自愈重启…")
		if err := startHTTPProxyAndAlign(cfg.ProxyPort, cfg.UserToken, cfg.DeviceId, ""); err != nil {
			Log("[watchdog] HTTP 代理自愈失败(下个周期再试): %v", err)
		}
	}

}
