// Package takeover 协调「同一产品的本地接管端口指向」。
//
// 一个产品同时只有一种接管生效(远程租号 或 本地自有号)。号源决定接管把
// 本地 CLI 的 config 指向哪个端口:本地→网关端口,远程→租号 proxy 端口。
// 这是远程世界与本地世界唯一的耦合点,刻意做成极薄协调(见 spec §7)。
package takeover

type AccountSource string

const (
	SourceRemote AccountSource = "remote"
	SourceLocal  AccountSource = "local"
)

// ResolvePort 决定接管注入指向哪个本地端口。
func ResolvePort(src AccountSource, remoteProxyPort, localGatewayPort int) int {
	if src == SourceLocal {
		return localGatewayPort
	}
	return remoteProxyPort
}

// Normalize 把任意字符串归一成合法号源(默认远程,保持现状行为)。
func Normalize(s string) AccountSource {
	if AccountSource(s) == SourceLocal {
		return SourceLocal
	}
	return SourceRemote
}
