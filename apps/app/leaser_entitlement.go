package main

// 订阅授权门控:解决「冷启动盲租 antigravity」误判整卡不可用的问题。
//
// 老问题:客户端启动时还不知道订阅开了哪些产品(products 只能从一次成功租号的响应里拿),
// 于是无脑去租 antigravity;若订阅只开了 codex/anthropic,服务端回 SUBSCRIPTION_EXPIRED,
// 客户端把它当致命错 → markCardUnusable 把整卡判死,其实 codex/anthropic 本可用。
//
// 解药:心跳已经把每条生效订阅的 products 返回了(见服务端 buildSubscriptionSummary)。
// 接管启动前把「产品授权并集 + 是否有生效订阅」喂给 leaser,启动时据此决策,不再盲租。

// antigravityPlan 是接管启动时 antigravity 常驻租号路径的三种走法。
type antigravityPlan int

const (
	agAttempt antigravityPlan = iota // 尝试 antigravity 常驻租号(已授权,或冷启动尚未知)
	agSkip                           // 有生效订阅但未开 antigravity → 跳过,改预热 codex/anthropic
	agNoSub                          // 确无生效订阅 → 卡密不可用(引导续费)
)

// decideAntigravity 决定 antigravity 路径怎么走。纯函数,便于测试。
//   - entKnown:      是否已从心跳拿到订阅授权(冷启动尚无心跳时为 false)
//   - entitled:      授权的产品并集(entKnown=true 时,空表示无任何产品)
//   - subActive:     是否有生效订阅
//   - leaseProducts: 上次成功租号回写的 products(entKnown=false 时回退老逻辑用)
func decideAntigravity(entKnown bool, entitled []string, subActive bool, leaseProducts []string) antigravityPlan {
	if entKnown {
		if !subActive {
			return agNoSub
		}
		if productListContains(entitled, "antigravity") {
			return agAttempt
		}
		return agSkip
	}
	// 冷启动尚无心跳授权 → 回退老逻辑:按 lease 响应 products 判断(空=池子卡=先尝试)。
	if cardCoversProduct(leaseProducts, "antigravity") {
		return agAttempt
	}
	return agSkip
}

// SetEntitlements 喂入从心跳解析出的订阅授权(产品并集 + 是否有生效订阅)。
// 由接管启动(startServicesForUser)与心跳(HeartbeatCheck)调用,让 StartAutoLease
// 启动时就能正确决定 antigravity 路径,不必先盲租一次才知道。
func (l *Leaser) SetEntitlements(products []string, hasActiveSub bool) {
	l.mu.Lock()
	l.entitledProducts = products
	l.entitlementsKnown = true
	l.subActive = hasActiveSub
	l.mu.Unlock()
}

// ResetEntitlements 清空订阅授权与「卡密不可用」latch。换卡/换会话时调用(见 clearLocalCardState):
// 新会话的授权必须由新 token 的心跳重新 seed,旧授权不能续用;同时复位 cardUnusable,
// 避免上一会话的判死状态被新会话误继承(否则新登录可能仍顶着旧的「订阅已到期」横幅)。
func (l *Leaser) ResetEntitlements() {
	l.mu.Lock()
	l.entitledProducts = nil
	l.entitlementsKnown = false
	l.subActive = false
	l.cardUnusable = false
	l.mu.Unlock()
}

// entitlementsKnownNoSub 报告「已确知无生效订阅」—— 心跳已返回且 subscriptions 为空。
// 区别于冷启动尚未知(entitlementsKnown=false):后者不该据此判卡密不可用。
func (l *Leaser) entitlementsKnownNoSub() bool {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.entitlementsKnown && !l.subActive
}

// IsCardUnusable 读当前「卡密不可用」态。供心跳在确认有生效订阅后判断是否需要恢复。
func (l *Leaser) IsCardUnusable() bool {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.cardUnusable
}

// productsFromAKS 从 accessKeyStatus 抽出 products 字符串切片(缺/空 → nil)。
// 给 CardProducts 与 coversAntigravity 共用,后者可在已持锁时直接调用、避免重复加锁。
func productsFromAKS(aks map[string]interface{}) []string {
	raw, ok := aks["products"].([]interface{})
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// productListContains 是严格成员判断(空列表 → false),区别于 cardCoversProduct
// 的「空=覆盖一切」语义 —— 授权列表为空意味着「没有该产品」,不能放行。
func productListContains(products []string, target string) bool {
	for _, p := range products {
		if p == target {
			return true
		}
	}
	return false
}

// parseHeartbeatEntitlements 从 /app/heartbeat 响应里取出「产品授权并集」+「是否有生效订阅」。
// 心跳 body: { subscriptions: [{products:[...]}, ...] };服务端只下发 ACTIVE 且未过期的订阅,
// 故 len(subscriptions)>0 即「有生效订阅」。ok=false 表示响应未携带 subscriptions 字段
// (老服务端)—— 此时授权未知,调用方不应据此 seed/判死。
func parseHeartbeatEntitlements(result map[string]interface{}) (products []string, hasActiveSub bool, ok bool) {
	raw, hasKey := result["subscriptions"]
	if !hasKey {
		return nil, false, false
	}
	subs, _ := raw.([]interface{})
	seen := map[string]bool{}
	for _, s := range subs {
		sm, ok := s.(map[string]interface{})
		if !ok {
			continue
		}
		prods, _ := sm["products"].([]interface{})
		for _, p := range prods {
			if ps, ok := p.(string); ok && ps != "" && !seen[ps] {
				seen[ps] = true
				products = append(products, ps)
			}
		}
	}
	return products, len(subs) > 0, true
}
