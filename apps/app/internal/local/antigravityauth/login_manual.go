package antigravityauth

import (
	"context"

	"bcai-wails/internal/local/account"
	sdkauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/auth"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

// LoginWithPrompt 与 Login 相同,但额外接受 prompt 回调:防火墙/无浏览器/端口占用
// 时,SDK 会调用 prompt 拿到用户手动粘贴的回调 URL(SDK 内部 misc.ParseOAuthCallback
// 解析 code/state 并继续换 token)。ctx 取消会中止后续 code→token/项目发现请求。
//
// prompt 为 nil 时行为等价于 Login(SDK 仅走浏览器回调,不提供手动兜底)。
func LoginWithPrompt(ctx context.Context, cfg *config.Config, prompt func(string) (string, error)) (*account.Account, error) {
	if cfg == nil {
		cfg = &config.Config{}
	}
	opts := &sdkauth.LoginOptions{Prompt: prompt}
	auth, err := sdkauth.NewAntigravityAuthenticator().Login(ctx, cfg, opts)
	if err != nil {
		return nil, err
	}
	return authToAccount(auth), nil
}
