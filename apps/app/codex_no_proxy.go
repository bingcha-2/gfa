package main

import "strings"

var codexLocalNoProxyHosts = []string{
	"127.0.0.1",
	"127.0.0.0/8",
	"localhost",
	"::1",
	"::1/128",
}

// codexLaunchEnv 保留用户已有代理环境，只确保 Codex 访问本机接管端口时不会被
// Clash/Mihomo 等系统代理截走。对齐 Cockpit 的 merge_local_no_proxy 行为。
func codexLaunchEnv(base []string) []string {
	out := make([]string, 0, len(base)+2)
	values := make([]string, 0, 2)
	for _, item := range base {
		key, value, ok := strings.Cut(item, "=")
		if ok && strings.EqualFold(strings.TrimSpace(key), "no_proxy") {
			values = append(values, value)
			continue
		}
		out = append(out, item)
	}

	seen := make(map[string]bool)
	merged := make([]string, 0, len(values)+len(codexLocalNoProxyHosts))
	appendValues := func(raw string) {
		for _, item := range strings.Split(raw, ",") {
			item = strings.TrimSpace(item)
			key := strings.ToLower(item)
			if item == "" || seen[key] {
				continue
			}
			seen[key] = true
			merged = append(merged, item)
		}
	}
	for _, value := range values {
		appendValues(value)
	}
	for _, host := range codexLocalNoProxyHosts {
		appendValues(host)
	}

	value := strings.Join(merged, ",")
	return append(out, "NO_PROXY="+value, "no_proxy="+value)
}
