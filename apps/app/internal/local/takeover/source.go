// Package takeover 协调「同一产品同时只有一种接管生效」(远程租号 或 本地自有号)。
//
// 号源是远程世界与本地世界唯一的耦合点,刻意做成极薄协调(见 spec §7):
// 这里只定义/归一号源,实际接管动作(本地→注入自有号,远程→指向租号 proxy)
// 由 internal/local/hub 按号源分发。
package takeover

import "strings"

type AccountSource string

const (
	SourceRemote AccountSource = "remote"
	SourceLocal  AccountSource = "local"
	// SourceProvider 是「用自定义模型厂商接管」——把 codex config.toml 指向某个
	// OpenAI 兼容供应商。持久化时存成 "provider:<providerID>" 复合值(见 SourceStore),
	// 故归一/取 id 都要能吃复合形态。
	SourceProvider AccountSource = "provider"
)

// base 取复合值(如 "provider:abc")的基础号源部分。
func base(s string) string {
	if i := strings.IndexByte(s, ':'); i >= 0 {
		return s[:i]
	}
	return s
}

// Normalize 把任意字符串(含复合 "provider:<id>")归一成合法号源(默认远程,保持现状行为)。
func Normalize(s string) AccountSource {
	switch AccountSource(base(s)) {
	case SourceLocal:
		return SourceLocal
	case SourceProvider:
		return SourceProvider
	default:
		return SourceRemote
	}
}

// ProviderID 从复合值 "provider:<id>" 取出 provider id;非 provider 或无 id 返回空。
func ProviderID(s string) string {
	if AccountSource(base(s)) != SourceProvider {
		return ""
	}
	if i := strings.IndexByte(s, ':'); i >= 0 {
		return s[i+1:]
	}
	return ""
}
