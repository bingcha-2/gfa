package main

import (
	"time"
)

// 纯展示刷新,不上报用量;绑定号唯一,force 重租不会轮换账号。池子卡直接跳过
// (池子模式血条走本地号池额度,不在此机制内)。错误吞掉 —— 刷新失败不影响接管。
// force=true(激活/换卡那一下)绕过额度拉取的 5min 节流,立刻拉一次最新的 gemini/claude/codex;
// force=false(每 90s 定时)走节流,避免高频打上游。
func (l *Leaser) refreshBoundQuota(card, deviceId, upstreamProxy string, force bool) {
	l.mu.RLock()
	bound := l.cachedToken != nil && l.cachedToken.Bound
	model := l.lastModelKey
	l.mu.RUnlock()
	if !bound {
		return
	}
	var opts map[string]interface{}
	if model != "" {
		opts = map[string]interface{}{"modelKey": model}
	}
	// force=true 绕过本地缓存,真正打到服务端取最新额度(返回模式 + accountBuckets)。
	_, _ = l.LeaseToken(card, deviceId, true, opts, upstreamProxy)
	// 走到这里说明 antigravity 绑定有效(bound),主动拉一次上游 per-model 额度并上报,
	// 让血条/后台在"还没发请求"时也有真实数据(antigravity 否则只在生成上报后才拉)。
	l.refreshBoundAntigravityQuota(card, upstreamProxy, force)

	// codex / anthropic 预热 —— 独立于 antigravity 主 token。
	l.preheatBoundProducts(card, deviceId, upstreamProxy, force)
}

// preheatBoundProducts 预热 codex / anthropic(claude 模型)绑定号的额度。这两条走各自
// 独立的 leaser,不依赖 antigravity 主 token,因此 codex-only / anthropic-only 卡也能在
// 激活时把血条刷出真实余量(否则 StartAutoLease 因「未开通 antigravity」提前 return,
// 这两个预热永远不执行 → 血条「未知」)。
func (l *Leaser) preheatBoundProducts(card, deviceId, upstreamProxy string, force bool) {
	// 该卡若开通 codex,刷新 codex 5h/周窗口 + bucket(独立 leaser / 独立端点)。
	if cardCoversProduct(l.CardProducts(), "codex") {
		if lease, err := GetCodexLeaser().LeaseToken(card, deviceId, true, nil, upstreamProxy); err == nil {
			GetCodexLeaser().RefreshQuotaUpstream(card, upstreamProxy, lease, force)
		}
	}
	// 该卡若开通 anthropic,预热一次 claude 模型租号,让 5h 血条在首个 /v1/messages 之前
	// 就有数据(服务端把 claudeWindows + accountBuckets 随 lease 带回)。计量在代理请求时进行。
	if cardCoversProduct(l.CardProducts(), "anthropic") {
		_, _ = GetClaudeLeaser().LeaseToken(card, deviceId, true, nil, upstreamProxy)
	}
}

// markCardUnusable 标记卡密不可用并停掉自动租号(不再每 15s 刷 Invalid)。
// 保持接管不还原 —— 用户只能手动「退出接管」。重新激活有效卡会复位。
func (l *Leaser) markCardUnusable(err error) {
	l.mu.Lock()
	l.cardUnusable = true
	l.mu.Unlock()
	Log("[token-leaser] 卡密不可用(%v),已停止自动租号;请重新激活有效卡密或退出接管", err)
	l.StopAutoLease()
}

// CardProducts 返回当前卡密开通的产品列表(来自服务端 accessKeyStatus.products)。
// 空 = 池子卡(不限产品)。供接管前校验"卡是否开通该产品"。
func (l *Leaser) CardProducts() []string {
	l.mu.RLock()
	defer l.mu.RUnlock()
	raw, ok := l.accessKeyStatus["products"].([]interface{})
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

func (l *Leaser) StopAutoLease() {
	l.mu.Lock()
	if l.cancelLease != nil {
		l.cancelLease()
		l.cancelLease = nil
	}
	l.leaseRunning = false
	l.cachedToken = nil
	l.mu.Unlock()
}

func (l *Leaser) ClearCache() {
	l.mu.Lock()
	l.cachedToken = nil
	l.mu.Unlock()
}

// ClearAccessKeyStatus 清空缓存的卡密状态(含 products)。换卡时调用,避免旧卡的
// products 被新卡复用 —— 新卡 products 由下一次 Activate/成功租号重新写入。
func (l *Leaser) ClearAccessKeyStatus() {
	l.mu.Lock()
	l.accessKeyStatus = nil
	l.accessKeyStatusAt = time.Time{}
	l.mu.Unlock()
}

// ResetLocalQuota 换卡时清空本地额度跟踪
func (l *Leaser) ResetLocalQuota() {
	l.mu.Lock()
	l.localQuota = LocalQuota{}
	l.mu.Unlock()
	Log("[token-leaser] Local quota reset (card changed)")
}

// setLastError 设置/清空 token-leaser 的最近错误。换卡时清掉旧卡残留的额度 block 提示
// (与 claude/codex leaser 的 setLastError 同接口,三家一致)。
func (l *Leaser) setLastError(msg string) {
	l.mu.Lock()
	l.lastError = msg
	l.mu.Unlock()
}

// LastError 返回 token-leaser 的最近错误(与 claude/codex leaser 同接口,供测试与通知读取)。
func (l *Leaser) LastError() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.lastError
}
