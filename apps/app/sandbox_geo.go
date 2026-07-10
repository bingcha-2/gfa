package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// ─── 沙箱模式 · 出口 IP → 时区(Phase 2)──────────────────────────────────────
//
// Anthropic 把时区塞进提示词(随请求正文上行),故沙箱本地 TZ 会被 Anthropic 看到。
// 让沙箱 TZ 对齐出口 IP 的地理时区,避免「提示词时区 vs 出口 IP 地理」不一致这个检测点。
// 账号本已粘性(cachedToken + StartAutoLease 续租),出口 IP 整场稳定,故只在开沙箱时探一次。

const sandboxDefaultTimezone = "America/New_York"

// iana 时区名形如 Area/Location。用正则校验而非 time.LoadLocation:后者依赖系统 zoneinfo,
// Windows 无 /usr/share/zoneinfo 会把合法时区误判为非法。
var ianaTZPattern = regexp.MustCompile(`^[A-Za-z]+(?:/[A-Za-z0-9_+-]+)+$`)

// normalizeTimezone 校验 IANA 时区名;空/非法 → 默认美东。
func normalizeTimezone(tz string) string {
	tz = strings.TrimSpace(tz)
	if !ianaTZPattern.MatchString(tz) {
		return sandboxDefaultTimezone
	}
	return tz
}

// probeExitTimezone 经出口代理探一次「我在哪」→ 时区。仅沙箱开场调一次(非每请求)。
// 抑制态(go test)或代理为空 → 直接返回默认,不触网络。任何失败都回退默认。
func probeExitTimezone(proxyURL string) (string, error) {
	if appActionsSuppressed() || strings.TrimSpace(proxyURL) == "" {
		return sandboxDefaultTimezone, nil
	}
	pu, err := url.Parse(proxyURL)
	if err != nil {
		return sandboxDefaultTimezone, err
	}
	client := &http.Client{
		Timeout:   10 * time.Second,
		Transport: &http.Transport{Proxy: http.ProxyURL(pu)},
	}
	resp, err := client.Get("http://ip-api.com/json/?fields=timezone")
	if err != nil {
		return sandboxDefaultTimezone, err
	}
	defer resp.Body.Close()
	var body struct {
		Timezone string `json:"timezone"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return sandboxDefaultTimezone, err
	}
	return normalizeTimezone(body.Timezone), nil
}
