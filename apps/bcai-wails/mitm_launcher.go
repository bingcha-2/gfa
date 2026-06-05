package main

import "strings"

// ─── Claude 桌面端接管：启动器（route A）的 OS 无关部分 ─────────────────────
//
// 桌面端在 spawn Code/Cowork 子进程(Node)时硬覆盖 ANTHROPIC_BASE_URL，env 注入接管
// 无效；但它不会动 HTTPS_PROXY/NODE_EXTRA_CA_CERTS。故接管方式是：带这些代理 env
// 重启整个 Claude.app，子进程继承后即把 api.anthropic.com 流量导向本地 MITM。
// （Node 不认 macOS 系统 PAC，只认这些 env，所以必须重启 App 而非设系统代理。）

// mitmUpsertEnv 在 env 切片里设置 key=value：已存在则覆盖，否则追加。
func mitmUpsertEnv(env []string, key, value string) []string {
	prefix := key + "="
	for i, kv := range env {
		if strings.HasPrefix(kv, prefix) {
			env[i] = prefix + value
			return env
		}
	}
	return append(env, prefix+value)
}

// mitmProxyEnv 基于 base 环境，注入把流量导向本地 MITM 所需的代理变量。
func mitmProxyEnv(base []string, proxyAddr, caCertPath string) []string {
	env := make([]string, len(base))
	copy(env, base)

	proxyURL := "http://" + proxyAddr
	env = mitmUpsertEnv(env, "HTTPS_PROXY", proxyURL)
	env = mitmUpsertEnv(env, "HTTP_PROXY", proxyURL)
	env = mitmUpsertEnv(env, "https_proxy", proxyURL)
	env = mitmUpsertEnv(env, "http_proxy", proxyURL)
	env = mitmUpsertEnv(env, "NODE_TLS_REJECT_UNAUTHORIZED", "0")
	if caCertPath != "" {
		env = mitmUpsertEnv(env, "NODE_EXTRA_CA_CERTS", caCertPath)
		env = mitmUpsertEnv(env, "SSL_CERT_FILE", caCertPath)
		env = mitmUpsertEnv(env, "REQUESTS_CA_BUNDLE", caCertPath)
	}
	env = mitmUpsertEnv(env, "NO_PROXY", "127.0.0.1,localhost")
	env = mitmUpsertEnv(env, "no_proxy", "127.0.0.1,localhost")
	return env
}
