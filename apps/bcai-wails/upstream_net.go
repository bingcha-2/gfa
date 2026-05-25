package main

import (
	"crypto/tls"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"
)

func isDirectProxyMode(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", "direct", "none", "off":
		return true
	default:
		return false
	}
}

var (
	systemProxyOnce sync.Once
	systemProxyURL  string

	// 全局复用 HTTP client，避免每个请求都创建新连接
	httpClientOnce sync.Once
	httpClientPool *http.Client
)

// detectSystemProxy 检测系统代理设置（macOS + Windows）
func detectSystemProxy() string {
	switch runtime.GOOS {
	case "darwin":
		return detectSystemProxyDarwin()
	case "windows":
		return detectSystemProxyWindows()
	default:
		// Linux: 读取环境变量
		for _, env := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"} {
			if v := os.Getenv(env); v != "" {
				Log("[系统] 检测到环境变量代理 (%s): %s", env, v)
				return v
			}
		}
		return ""
	}
}

func detectSystemProxyDarwin() string {
	out, err := hideCmd("scutil", "--proxy").Output()
	if err != nil {
		return ""
	}

	lines := strings.Split(string(out), "\n")
	var httpsEnabled bool
	var httpsHost, httpsPort string
	var httpEnabled bool
	var httpHost, httpPort string

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "HTTPSEnable : 1") {
			httpsEnabled = true
		}
		if strings.HasPrefix(line, "HTTPSProxy : ") {
			httpsHost = strings.TrimPrefix(line, "HTTPSProxy : ")
		}
		if strings.HasPrefix(line, "HTTPSPort : ") {
			httpsPort = strings.TrimPrefix(line, "HTTPSPort : ")
		}
		if strings.HasPrefix(line, "HTTPEnable : 1") {
			httpEnabled = true
		}
		if strings.HasPrefix(line, "HTTPProxy : ") {
			httpHost = strings.TrimPrefix(line, "HTTPProxy : ")
		}
		if strings.HasPrefix(line, "HTTPPort : ") {
			httpPort = strings.TrimPrefix(line, "HTTPPort : ")
		}
	}

	// 优先 HTTPS 代理
	if httpsEnabled && httpsHost != "" && httpsPort != "" {
		proxyURL := "http://" + httpsHost + ":" + httpsPort
		Log("[系统] 检测到 macOS 系统代理 (HTTPS): %s", proxyURL)
		return proxyURL
	}
	if httpEnabled && httpHost != "" && httpPort != "" {
		proxyURL := "http://" + httpHost + ":" + httpPort
		Log("[系统] 检测到 macOS 系统代理 (HTTP): %s", proxyURL)
		return proxyURL
	}

	return ""
}

func detectSystemProxyWindows() string {
	// 从注册表读取 Internet Settings 代理配置
	out, err := hideCmd("reg", "query",
		`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`,
		"/v", "ProxyEnable").Output()
	if err != nil {
		return ""
	}
	if !strings.Contains(string(out), "0x1") {
		return "" // 代理未启用
	}

	out, err = hideCmd("reg", "query",
		`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`,
		"/v", "ProxyServer").Output()
	if err != nil {
		return ""
	}

	// 解析 REG_SZ 值，格式如 "127.0.0.1:7897" 或 "http=127.0.0.1:7897;https=127.0.0.1:7897"
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.Contains(line, "ProxyServer") {
			parts := strings.Fields(line)
			if len(parts) >= 3 {
				proxyVal := parts[len(parts)-1]
				// 处理分号分隔的多协议格式
				if strings.Contains(proxyVal, "=") {
					for _, seg := range strings.Split(proxyVal, ";") {
						if strings.HasPrefix(seg, "https=") {
							proxyURL := "http://" + strings.TrimPrefix(seg, "https=")
							Log("[系统] 检测到 Windows 系统代理 (HTTPS): %s", proxyURL)
							return proxyURL
						}
						if strings.HasPrefix(seg, "http=") {
							proxyURL := "http://" + strings.TrimPrefix(seg, "http=")
							Log("[系统] 检测到 Windows 系统代理 (HTTP): %s", proxyURL)
							return proxyURL
						}
					}
				}
				// 统一代理格式 "host:port"
				if !strings.HasPrefix(proxyVal, "http") {
					proxyVal = "http://" + proxyVal
				}
				Log("[系统] 检测到 Windows 系统代理: %s", proxyVal)
				return proxyVal
			}
		}
	}
	return ""
}

// getSystemProxy 获取系统代理（缓存结果，只检测一次）
func getSystemProxy() string {
	systemProxyOnce.Do(func() {
		systemProxyURL = detectSystemProxy()
		if systemProxyURL == "" {
			Log("[系统] 未检测到系统代理，将使用直连")
		}
	})
	return systemProxyURL
}

// getHttpClient 获取全局复用的 HTTP client（懒初始化）
// 优先级：用户显式配置 > 系统代理 > 直连
func getHttpClient(upstreamProxy string) *http.Client {
	upstreamProxy = strings.TrimSpace(upstreamProxy)

	// 用户显式配了上游代理 → 创建独立 client（不缓存，因为代理可能变）
	if upstreamProxy != "" && !isDirectProxyMode(upstreamProxy) {
		transport := newTransport()
		proxyURL, err := url.Parse(upstreamProxy)
		if err == nil {
			transport.Proxy = http.ProxyURL(proxyURL)
		}
		return &http.Client{Timeout: 120 * time.Second, Transport: transport}
	}

	// 否则复用全局 client
	httpClientOnce.Do(func() {
		transport := newTransport()
		// 使用系统代理（Clash/Mihomo 等）
		sysProxy := getSystemProxy()
		if sysProxy != "" {
			proxyURL, err := url.Parse(sysProxy)
			if err == nil {
				transport.Proxy = http.ProxyURL(proxyURL)
				Log("[http-client] Using system proxy: %s", sysProxy)
			}
		} else {
			Log("[http-client] No proxy detected, using direct connection")
		}
		httpClientPool = &http.Client{Timeout: 120 * time.Second, Transport: transport}
	})
	return httpClientPool
}

func newTransport() *http.Transport {
	return &http.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: false,
			MinVersion:         tls.VersionTLS12,
		},
		MaxIdleConns:        200,
		MaxIdleConnsPerHost: 20,
		MaxConnsPerHost:     0,
		IdleConnTimeout:     120 * time.Second,
		TLSHandshakeTimeout: 15 * time.Second,
		ForceAttemptHTTP2:   false, // 禁用 HTTP/2，HTTP/1.1 通过代理更稳定
	}
}

// createHttpClient 兼容旧调用，内部使用连接池
func createHttpClient(upstreamProxy string) *http.Client {
	return getHttpClient(upstreamProxy)
}

// createStreamingHttpClient 用于流式生成请求，不设全局 Timeout
// 流式请求的超时由 proxy.go 中的 stream timer goroutine 控制（first-byte + idle timeout）
// 全局 Timeout 会截断长生成（thinking model 可能输出 3-5 分钟）
func createStreamingHttpClient(upstreamProxy string) *http.Client {
	upstreamProxy = strings.TrimSpace(upstreamProxy)

	transport := newTransport()
	// 设置更长的 ResponseHeaderTimeout，等待服务端开始返回 header
	transport.ResponseHeaderTimeout = 180 * time.Second // 3 min for thinking

	if upstreamProxy != "" && !isDirectProxyMode(upstreamProxy) {
		proxyURL, err := url.Parse(upstreamProxy)
		if err == nil {
			transport.Proxy = http.ProxyURL(proxyURL)
		}
	} else {
		sysProxy := getSystemProxy()
		if sysProxy != "" {
			proxyURL, err := url.Parse(sysProxy)
			if err == nil {
				transport.Proxy = http.ProxyURL(proxyURL)
			}
		}
	}

	return &http.Client{
		Timeout:   0, // 无全局超时，由 stream timer 控制
		Transport: transport,
	}
}

// WarmupConnectionPool 预热连接池，提前建立到上游的 TLS 连接
// 避免 IDE 启动时并发请求导致冷启动 EOF
func WarmupConnectionPool(upstreamProxy string) {
	client := createHttpClient(upstreamProxy)
	hosts := []string{
		"https://cloudcode-pa.googleapis.com",
	}
	for _, host := range hosts {
		go func(h string) {
			req, err := http.NewRequest("HEAD", h, nil)
			if err != nil {
				return
			}
			resp, err := client.Do(req)
			if err != nil {
				Log("[warmup] Connection warmup to %s failed: %v (will retry on first real request)", h, err)
				return
			}
			resp.Body.Close()
			Log("[warmup] Connection pool warmed up: %s", h)
		}(host)
	}
}

// ── bcai.site 专用直连 client ──
// 独立连接池、15s 超时、不走任何代理
// 用于 lease-token / report-result / activate 等 bcai.site 请求
var (
	bcaiClientOnce sync.Once
	bcaiClient     *http.Client
)

func createBcaiClient() *http.Client {
	bcaiClientOnce.Do(func() {
		t := newTransport()
		t.Proxy = nil // bcai.site 直连，不走代理
		bcaiClient = &http.Client{Timeout: 15 * time.Second, Transport: t}
		Log("[http-client] Created bcai.site direct client (15s timeout, no proxy)")
	})
	return bcaiClient
}

// postBcaiWithFallback 优先直连 bcai.site，失败后回退到 upstream 代理
// 用于替代 leaser.go 中所有发往 bcai.site 的 postJsonWithSecret 调用
func postBcaiWithFallback(path string, payload interface{}, card string, upstreamProxy string) ([]byte, int, error) {
	// 优先直连
	body, status, err := postJsonWithSecret(createBcaiClient(), path, payload, card)
	if err == nil {
		return body, status, nil
	}

	// 直连失败 → 回退到代理
	Log("[bcai] Direct connection failed (%v), retrying via proxy", err)
	return postJsonWithSecret(createHttpClient(upstreamProxy), path, payload, card)
}
