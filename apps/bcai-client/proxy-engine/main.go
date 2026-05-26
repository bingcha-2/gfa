// 冰茶AI 代理引擎 (独立进程)
// 由 Electron 主进程 spawn，通过 HTTP /status 端口通信
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
)

const StatusPort = 0 // will use proxyPort + 1 at runtime

func main() {
	cardFlag := flag.String("card", "", "Account card / API key")
	portFlag := flag.Int("port", DefaultProxyPort, "Proxy listen port")
	proxyFlag := flag.String("proxy", "", "Upstream proxy URL")
	deviceFlag := flag.String("device", "", "Device ID")
	flag.Parse()

	initLogger()
	Log("[engine] BingchaAI proxy engine starting...")

	// 从命令行参数或已有配置加载
	cfg := LoadConfig()
	if *cardFlag != "" {
		cfg.AccountCard = *cardFlag
	}
	if *portFlag > 0 {
		cfg.ProxyPort = *portFlag
	}
	if *proxyFlag != "" {
		cfg.UpstreamProxy = *proxyFlag
	}
	if *deviceFlag != "" {
		cfg.DeviceId = *deviceFlag
	}
	_ = SaveConfig(cfg)

	// 预热连接池
	WarmupConnectionPool(cfg.UpstreamProxy)

	// 加载用量统计
	GetUsageStats().Load()
	GetUsageStats().StartAutoSave()

	// 启动 Token 自动租约
	if cfg.AccountCard != "" {
		GetLeaser().StartAutoLease(cfg.AccountCard, cfg.DeviceId, cfg.UpstreamProxy)
		Log("[engine] Auto-lease started for card: %s...%s", cfg.AccountCard[:min(4, len(cfg.AccountCard))], cfg.AccountCard[max(0, len(cfg.AccountCard)-4):])
	}

	// 启动 HTTP 代理
	if err := GetHTTPProxy().Start(cfg.ProxyPort, cfg.AccountCard, cfg.DeviceId, cfg.UpstreamProxy); err != nil {
		Log("[engine] Failed to start proxy: %v", err)
		os.Exit(1)
	}
	Log("[engine] Proxy listening on 127.0.0.1:%d", cfg.ProxyPort)

	// 启动状态 API (供 Electron 轮询)
	go startStatusServer(cfg, cfg.ProxyPort+1)

	// 等待退出信号
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig

	Log("[engine] Shutting down...")
	GetHTTPProxy().Stop()
	GetLeaser().StopAutoLease()
	GetUsageStats().Save()
}

func startStatusServer(cfg Config, statusPort int) {
	mux := http.NewServeMux()

	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		proxyStatus := GetHTTPProxy().GetStatus()
		leaserStatus := GetLeaser().GetStatus()
		proxyStats := GetProxy().GetStats()
		usageStats := GetUsageStats()

		chartMode := "daily"
		if !usageStats.HasMultipleDays() {
			chartMode = "hourly"
		}

		resp := map[string]interface{}{
			"running":       proxyStatus.Running,
			"mode":          "relay",
			"listenPort":    proxyStatus.ListenPort,
			"lastError":     proxyStatus.LastError,
			"leaser":        leaserStatus,
			"totalRequests": proxyStats.TotalRequests,
			"totalErrors":   proxyStats.TotalErrors,
			"totalRetries":  proxyStats.TotalRetries,
			"totalInputTokens":  proxyStats.TotalInputTokens,
			"totalOutputTokens": proxyStats.TotalOutputTokens,
			"totalCachedTokens": proxyStats.TotalCachedTokens,
			"savedMoneyUSD":     proxyStats.SavedMoneyUSD,
			"today":         usageStats.GetTodayRecord(),
			"dailyHistory":  usageStats.GetDailyRecords(7),
			"hourlyHistory": usageStats.GetTodayHourlyRecords(),
			"chartMode":     chartMode,
			"accessKeyStatus": leaserStatus,
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})

	mux.HandleFunc("/shutdown", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
		go func() {
			GetHTTPProxy().Stop()
			GetLeaser().StopAutoLease()
			GetUsageStats().Save()
			os.Exit(0)
		}()
	})

	mux.HandleFunc("/update-config", func(w http.ResponseWriter, r *http.Request) {
		var newCfg Config
		if err := json.NewDecoder(r.Body).Decode(&newCfg); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		oldCfg := LoadConfig()

		if newCfg.AccountCard != "" {
			oldCfg.AccountCard = newCfg.AccountCard
		}
		if newCfg.DeviceId != "" {
			oldCfg.DeviceId = newCfg.DeviceId
		}
		if newCfg.UpstreamProxy != "" {
			oldCfg.UpstreamProxy = newCfg.UpstreamProxy
		}

		_ = SaveConfig(oldCfg)
		GetHTTPProxy().UpdateConfig(oldCfg.AccountCard, oldCfg.DeviceId, oldCfg.UpstreamProxy)

		// Restart leaser with new card
		GetLeaser().StopAutoLease()
		if oldCfg.AccountCard != "" {
			GetLeaser().StartAutoLease(oldCfg.AccountCard, oldCfg.DeviceId, oldCfg.UpstreamProxy)
		}

		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	})

	addr := fmt.Sprintf("127.0.0.1:%d", statusPort)
	Log("[engine] Status API on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		Log("[engine] Status server error: %v", err)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
