package main

import (
	"net/url"
	"strings"
	"sync"
)

var (
	// proxySchemeCache maps proxy host (e.g. "204.0.11.46:443") to the working scheme ("socks5" or "http")
	proxySchemeCache   = make(map[string]string)
	proxySchemeCacheMu sync.RWMutex
)

// setProxySchemeCache records the working scheme for a proxy host.
func setProxySchemeCache(host, scheme string) {
	proxySchemeCacheMu.Lock()
	defer proxySchemeCacheMu.Unlock()
	proxySchemeCache[host] = strings.ToLower(scheme)
}

// getProxySchemeCache returns the cached working scheme for a proxy host, if any.
func getProxySchemeCache(host string) (string, bool) {
	proxySchemeCacheMu.RLock()
	defer proxySchemeCacheMu.RUnlock()
	scheme, ok := proxySchemeCache[host]
	return scheme, ok
}

// maskProxyURL hides username and password in the proxy URL for safe logging.
func maskProxyURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "[invalid-url]"
	}
	if u.User != nil {
		u.User = url.UserPassword("***", "***")
	}
	return u.String()
}

// resolveEgressProxyURL rewrites the scheme of rawURL if a working scheme is cached.
func resolveEgressProxyURL(rawURL string) string {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return ""
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	// Only rewrite if scheme is http/https
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return rawURL
	}
	if workingScheme, ok := getProxySchemeCache(u.Host); ok {
		u.Scheme = workingScheme
		return u.String()
	}
	return rawURL
}
