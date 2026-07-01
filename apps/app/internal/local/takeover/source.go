// Package takeover 协调「同一产品同时只有一种接管生效」(远程租号 或 本地自有号)。
//
// 号源是远程世界与本地世界唯一的耦合点,刻意做成极薄协调(见 spec §7):
// 这里只定义/归一号源,实际接管动作(本地→注入自有号,远程→指向租号 proxy)
// 由 internal/local/hub 按号源分发。
package takeover

type AccountSource string

const (
	SourceRemote AccountSource = "remote"
	SourceLocal  AccountSource = "local"
)

// Normalize 把任意字符串归一成合法号源(默认远程,保持现状行为)。
func Normalize(s string) AccountSource {
	if AccountSource(s) == SourceLocal {
		return SourceLocal
	}
	return SourceRemote
}
