package main

import (
	"fmt"
	"strings"
)

// clientHealth holds derived signals (not raw error strings) that should also
// surface as notifications: the local proxy down while a card is configured, or
// a backlog of un-flushed usage reports.
type clientHealth struct {
	CardConfigured bool
	ProxyRunning   bool
	PendingReports int
}

// derivedNotifications turns health signals into notifications. A down proxy is
// a blocking error the user must fix (port busy / restart); a report backlog is
// transient info (web-side usage may lag until it flushes).
func derivedNotifications(h clientHealth) []Notification {
	out := []Notification{}
	if h.CardConfigured && !h.ProxyRunning {
		out = append(out, Notification{
			Level: "block", Category: "startup", Recoverable: false,
			Message:  "本地代理未启动,请重启客户端或检查端口是否被占用",
			DedupKey: "proxy-down", Source: "proxy",
		})
	}
	if h.PendingReports > 0 {
		out = append(out, Notification{
			Level: "transient", Category: "report", Recoverable: true,
			Message:  fmt.Sprintf("%d 条用量待补发,期间 web 端额度可能暂未刷新", h.PendingReports),
			DedupKey: "pending-reports", Source: "report",
		})
	}
	return out
}

// Notification is one client-facing problem, classified so the UI can route it:
//   - Level "block"     → needs user action (dead account, proxy unset, port busy) → red banner
//   - Level "transient" → self-heals (quota cooldown, busy, transient upstream)    → toast/health
type Notification struct {
	Level       string `json:"level"`
	Category    string `json:"category"`
	Message     string `json:"message"`
	Recoverable bool   `json:"recoverable"`
	DedupKey    string `json:"dedupKey"`
	Source      string `json:"source"`
}

// actionableHints (lowercased) mark errors the user must DO something about —
// these never self-heal, so they get a blocking banner with a clear next step.
var actionableHints = []string{
	"invalid_grant", "鉴权失效", "联系客服", "联系管理员", "重新绑定", "重新授权",
	"需要验证", "需验证", // 验证挑战:号需人工验证,短重试无用 → 明确提示用户/管理员去验证
	"代理未配置", "proxyurl",
	"端口", "占用", "启动失败",
	"不存在或已禁用",
	"额度已用完", // 硬额度超限(token limit exceeded):窗口内不会恢复,短重试无用 → 明确告诉用户
}

// classifyError decides whether an error needs user action (block, not
// recoverable) or will recover on its own (transient, recoverable). Unknown
// errors default to transient so a one-off blip doesn't raise a blocking banner.
func classifyError(msg string) Notification {
	low := strings.ToLower(msg)
	for _, h := range actionableHints {
		if strings.Contains(low, h) {
			return Notification{Level: "block", Category: categoryFor(low), Message: msg, Recoverable: false, DedupKey: msg}
		}
	}
	return Notification{Level: "transient", Category: categoryFor(low), Message: msg, Recoverable: true, DedupKey: msg}
}

// errorSource is one raw error string tagged with where it came from.
type errorSource struct {
	Source string
	Msg    string
}

// buildNotifications turns the leasers' (and other subsystems') raw error
// strings into a deduped, classified notification list for GetStats. Empty
// errors (no problem) are skipped; duplicate messages collapse to one.
func buildNotifications(sources []errorSource) []Notification {
	out := []Notification{}
	seen := map[string]bool{}
	for _, s := range sources {
		if strings.TrimSpace(s.Msg) == "" {
			continue
		}
		n := classifyError(s.Msg)
		n.Source = s.Source
		if seen[n.DedupKey] {
			continue
		}
		seen[n.DedupKey] = true
		out = append(out, n)
	}
	return out
}

func categoryFor(low string) string {
	switch {
	case strings.Contains(low, "代理") || strings.Contains(low, "proxy"):
		return "proxy"
	case strings.Contains(low, "端口") || strings.Contains(low, "启动失败"):
		return "startup"
	case strings.Contains(low, "invalid_grant") || strings.Contains(low, "鉴权") || strings.Contains(low, "绑定") || strings.Contains(low, "授权"):
		return "auth"
	case strings.Contains(low, "额度") || strings.Contains(low, "限额") || strings.Contains(low, "繁忙") || strings.Contains(low, "容量"):
		return "quota"
	default:
		return "lease"
	}
}
