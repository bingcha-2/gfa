package main

import "net/url"

// 双域名故障转移：主域名优先，失败回退到备域名。
// 可通过环境变量 BCAI_PRIMARY_HOST / BCAI_FALLBACK_HOST 覆盖。
var (
	BcaiPrimaryHost  = getEnvOrDefault("BCAI_PRIMARY_HOST", "bcai.lol")
	BcaiFallbackHost = getEnvOrDefault("BCAI_FALLBACK_HOST", "bcai.site")
)

// bcaiHostPair 返回去重后的有序域名列表：[主, 备]。
func bcaiHostPair() []string {
	if BcaiFallbackHost == "" || BcaiFallbackHost == BcaiPrimaryHost {
		return []string{BcaiPrimaryHost}
	}
	return []string{BcaiPrimaryHost, BcaiFallbackHost}
}

// bcaiURLCandidates 把 rawURL 改写成主/备两个域名的候选列表（主域名在前）。
// 仅当 rawURL 的 host 属于已知的 bcai 域名对时才生效；否则原样返回（例如自定义
// BCAI_API_BASE，或来自更新清单的第三方下载地址，不做切换）。
// scheme / port / path / query 全部保留。
func bcaiURLCandidates(rawURL string) []string {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return []string{rawURL}
	}
	host := u.Hostname()
	if host != BcaiPrimaryHost && host != BcaiFallbackHost {
		return []string{rawURL}
	}
	port := u.Port()
	out := make([]string, 0, 2)
	seen := make(map[string]bool, 2)
	for _, h := range bcaiHostPair() {
		c := *u
		if port != "" {
			c.Host = h + ":" + port
		} else {
			c.Host = h
		}
		s := c.String()
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
