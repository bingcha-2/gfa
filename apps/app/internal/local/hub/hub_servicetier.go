package hub

import (
	"fmt"

	"bcai-wails/internal/local/account"
)

// SetCodexAccountServiceTier 设某 codex 自有号的「按号服务档」(对齐 cockpit accounts.updateAppSpeed):
//   - tier ∈ {fast, priority, flex} → 快速(出口需带 service_tier:"priority");
//   - tier ∈ {空, standard, 未知}    → 继承标准档。
//
// 仅 codex 支持(antigravity 走 IDE 注入,与反代/服务档无关),对非 codex 号显式拒绝。
// 落库后热刷网关,让 authsync 下次向嵌入式 CLIProxyAPI 喂号时带上最新档位。
func (h *Hub) SetCodexAccountServiceTier(id, tier string) error {
	a, err := h.acc.Get(id)
	if err != nil {
		return err
	}
	if a.Provider != account.ProviderCodex {
		return fmt.Errorf("hub: 按号服务档仅 codex 自有号支持(该号 provider=%q)", a.Provider)
	}
	pc, err := h.ctx(account.ProviderCodex)
	if err != nil {
		return err
	}
	return pc.mgr.SetServiceTier(id, tier)
}
