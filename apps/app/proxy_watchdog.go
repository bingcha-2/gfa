package main

import "time"

// proxyWatchdogInterval 是自愈巡检周期。够快(用户几秒内就恢复、横幅自动消失),
// 又不至于在持续失败时空转太凶。
const proxyWatchdogInterval = 5 * time.Second

// startProxyWatchdog 启动后台自愈巡检:周期性检查本地代理"该运行却没运行"的情况并重试拉起。
// 解决两类问题:
//   - HTTP 代理(48800)启动时被占/绑不上、或运行中 Serve 挂掉 → 永久 down、要用户手动重启;
//   - MITM 代理(48801)在接管激活期间意外停掉 → 桌面端接管静默失效。
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

	// ① HTTP 代理:配了卡却没在跑 → 重试 Start(内部含端口兜底)。
	if cfg.AccountCard != "" && !GetHTTPProxy().GetStatus().Running {
		Log("[watchdog] HTTP 代理未运行,尝试自愈重启…")
		if err := GetHTTPProxy().Start(cfg.ProxyPort, cfg.AccountCard, cfg.DeviceId, ""); err != nil {
			Log("[watchdog] HTTP 代理自愈失败(下个周期再试): %v", err)
		}
	}

	// ② MITM 代理:接管激活中却没在跑 → 重启(桌面端 Code/Cowork 接管要靠它)。
	if mitmIsTakeoverActive() && !GetMitmManager().IsProxyRunning() {
		Log("[watchdog] MITM 代理未运行(接管激活中),尝试自愈重启…")
		if err := GetMitmManager().StartProxy(mitmDefaultPort, cfg.AccountCard, cfg.DeviceId, ""); err != nil {
			Log("[watchdog] MITM 自愈失败(下个周期再试): %v", err)
		}
	}
}
