package main

import "bcai-wails/internal/local/account"

// 本地自有号 OAuth 手动回调 / 取消绑定 —— Wave O。
//
// 场景:防火墙 / 无浏览器 / 端口占用时,SDK 起的本地回调 server 拿不到浏览器回调。
// 用户可手动把 OAuth 回调 URL(浏览器地址栏那串 code/state)粘贴回来完成登录;
// 或在挂起时显式取消。全部薄薄委托给 hub(编排在 internal/local/manager)。

// LocalSubmitCodexLoginCallback 为一个挂起的 Codex 登录提交手动粘贴的回调 URL。
func (a *App) LocalSubmitCodexLoginCallback(id, callbackURL string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.SubmitLoginCallback(account.ProviderCodex, id, callbackURL)
}

// LocalCancelCodexLogin 取消一个挂起的 Codex 登录。
func (a *App) LocalCancelCodexLogin(id string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.CancelLogin(account.ProviderCodex, id)
}

// LocalSubmitAntigravityLoginCallback 为一个挂起的 Antigravity 登录提交手动回调 URL。
func (a *App) LocalSubmitAntigravityLoginCallback(id, callbackURL string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.SubmitLoginCallback(account.ProviderAntigravity, id, callbackURL)
}

// LocalCancelAntigravityLogin 取消一个挂起的 Antigravity 登录。
func (a *App) LocalCancelAntigravityLogin(id string) error {
	if err := ensureLocal(); err != nil {
		return err
	}
	return localHub.CancelLogin(account.ProviderAntigravity, id)
}
