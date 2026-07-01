package main

import (
	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/wakeup"
)

// 保活验证 + 单号测试(Wave P)Wails 绑定 —— 仅薄薄委托给 hub。
// 复用 wakeup 的 keepAlive(真 token 续约 + 轻探额度);与反代/远程租号无关。

// ── Codex ──

func (a *App) LocalCodexWakeupVerifyBatch(ids []string) (wakeup.VerifyBatch, error) {
	if err := ensureLocal(); err != nil {
		return wakeup.VerifyBatch{}, err
	}
	return localHub.WakeupVerifyBatch(account.ProviderCodex, ids)
}

func (a *App) LocalCodexWakeupVerificationState() ([]wakeup.VerifyResult, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.WakeupVerificationState(account.ProviderCodex)
}

func (a *App) LocalCodexWakeupVerificationHistory() ([]wakeup.VerifyBatch, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.WakeupVerificationHistory(account.ProviderCodex)
}

func (a *App) LocalCodexWakeupClearVerificationHistory(batchIDs []string) (int, error) {
	if err := ensureLocal(); err != nil {
		return 0, err
	}
	return localHub.ClearWakeupVerificationHistory(account.ProviderCodex, batchIDs)
}

// ── Antigravity ──

func (a *App) LocalAntigravityWakeupVerifyBatch(ids []string) (wakeup.VerifyBatch, error) {
	if err := ensureLocal(); err != nil {
		return wakeup.VerifyBatch{}, err
	}
	return localHub.WakeupVerifyBatch(account.ProviderAntigravity, ids)
}

func (a *App) LocalAntigravityWakeupVerificationState() ([]wakeup.VerifyResult, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.WakeupVerificationState(account.ProviderAntigravity)
}

func (a *App) LocalAntigravityWakeupVerificationHistory() ([]wakeup.VerifyBatch, error) {
	if err := ensureLocal(); err != nil {
		return nil, err
	}
	return localHub.WakeupVerificationHistory(account.ProviderAntigravity)
}

func (a *App) LocalAntigravityWakeupClearVerificationHistory(batchIDs []string) (int, error) {
	if err := ensureLocal(); err != nil {
		return 0, err
	}
	return localHub.ClearWakeupVerificationHistory(account.ProviderAntigravity, batchIDs)
}

// ── 单号测试(按 id,provider 无关) ──

func (a *App) LocalWakeupTestOne(id string) (wakeup.VerifyResult, error) {
	if err := ensureLocal(); err != nil {
		return wakeup.VerifyResult{}, err
	}
	return localHub.WakeupTestOne(id)
}
