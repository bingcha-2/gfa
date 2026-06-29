package authsync

import (
	"context"
	"errors"

	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
)

// Selector 实现 coreauth.Selector:优先出口号优先,否则取第一个。
// 配额排序留待 P2 接入 usage 数据后细化。
type Selector struct{}

func (Selector) Pick(ctx context.Context, provider, model string, opts cliproxyexecutor.Options, auths []*coreauth.Auth) (*coreauth.Auth, error) {
	if len(auths) == 0 {
		return nil, errors.New("authsync: no available account")
	}
	for _, a := range auths {
		if a.Attributes["priority"] == "1" {
			return a, nil
		}
	}
	return auths[0], nil
}
