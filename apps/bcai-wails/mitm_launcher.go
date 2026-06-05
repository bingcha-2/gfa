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

// mitmProxyEnvPairs 返回把流量导向本地 MITM 所需的代理变量(KEY=VALUE 列表)。
// 用于 macOS `open --env`(逐条注入,保留 LaunchServices/TCC),也是 mitmProxyEnv 的来源。
func mitmProxyEnvPairs(proxyAddr, caCertPath string) []string {
	proxyURL := "http://" + proxyAddr
	pairs := []string{
		"HTTPS_PROXY=" + proxyURL,
		"HTTP_PROXY=" + proxyURL,
		"https_proxy=" + proxyURL,
		"http_proxy=" + proxyURL,
		"NODE_TLS_REJECT_UNAUTHORIZED=0",
		"NO_PROXY=127.0.0.1,localhost",
		"no_proxy=127.0.0.1,localhost",
	}
	if caCertPath != "" {
		pairs = append(pairs,
			"NODE_EXTRA_CA_CERTS="+caCertPath,
			"SSL_CERT_FILE="+caCertPath,
			"REQUESTS_CA_BUNDLE="+caCertPath,
		)
	}
	return pairs
}

// mitmProxyEnv 基于 base 环境 upsert 代理变量(用于直接传 exec.Cmd.Env 的场景/测试)。
func mitmProxyEnv(base []string, proxyAddr, caCertPath string) []string {
	env := make([]string, len(base))
	copy(env, base)
	for _, kv := range mitmProxyEnvPairs(proxyAddr, caCertPath) {
		if i := strings.IndexByte(kv, '='); i >= 0 {
			env = mitmUpsertEnv(env, kv[:i], kv[i+1:])
		}
	}
	return env
}
