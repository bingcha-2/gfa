package hub

import (
	"context"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/wakeup"
)

// ── 保活验证 + 单号测试(Wave P) ──
//
// 红线:仍是账号级 keepalive/验证(真 token 续约 + 轻探额度),与反代/远程租号无关。
// 复用 mkProvider 为 wakeup 注入的同一个 keepAlive(providerCtx.wkVerify 持有)。

// WakeupVerifyBatch 对选中的一批账号跑一次真 keepAlive 验证(确认确实可用),
// 记录每号 pass/fail + 聚合 + 落盘历史/状态。返回本批聚合与明细。
func (h *Hub) WakeupVerifyBatch(p account.Provider, ids []string) (wakeup.VerifyBatch, error) {
	pc, err := h.ctx(p)
	if err != nil {
		return wakeup.VerifyBatch{}, err
	}
	return pc.wkVerify.RunBatch(context.Background(), ids)
}

// WakeupVerificationState 返回某 provider 每账号最新一次验证结果(从磁盘)。
func (h *Hub) WakeupVerificationState(p account.Provider) ([]wakeup.VerifyResult, error) {
	pc, err := h.ctx(p)
	if err != nil {
		return nil, err
	}
	return pc.wkVerify.LoadState()
}

// WakeupVerificationHistory 返回某 provider 的验证历史批次(新→旧)。
func (h *Hub) WakeupVerificationHistory(p account.Provider) ([]wakeup.VerifyBatch, error) {
	pc, err := h.ctx(p)
	if err != nil {
		return nil, err
	}
	return pc.wkVerify.LoadHistory()
}

// ClearWakeupVerificationHistory 删除某 provider 指定 batchId 的验证历史,返回删除数量。
func (h *Hub) ClearWakeupVerificationHistory(p account.Provider, batchIDs []string) (int, error) {
	pc, err := h.ctx(p)
	if err != nil {
		return 0, err
	}
	return pc.wkVerify.DeleteHistory(batchIDs)
}

// WakeupTestOne 对单个账号(按 id,provider 无关)即席跑一次 keepAlive 验证。
func (h *Hub) WakeupTestOne(id string) (wakeup.VerifyResult, error) {
	a, err := h.acc.Get(id)
	if err != nil {
		return wakeup.VerifyResult{}, err
	}
	pc, err := h.ctx(a.Provider)
	if err != nil {
		return wakeup.VerifyResult{}, err
	}
	return pc.wkVerify.SingleTest(context.Background(), id)
}
