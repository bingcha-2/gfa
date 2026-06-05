package main

// BoundAccountInfo 是绑定卡每个产品当前租到的账号信息(供客户端「绑定账号信息」面板显示)。
// 绑定卡恒为同一个号,池子卡每次请求轮换 —— 这里展示的是该产品「最近一次成功租到的号」,
// 以及该号当前的 access token(供用户手动取用 / 排障)。三个产品各对应一个 leaser:
//   antigravity → Leaser(主)   codex → CodexLeaser   anthropic → ClaudeLeaser
type BoundAccountInfo struct {
	Product     string `json:"product"` // antigravity / codex / anthropic
	AccountId   int    `json:"accountId"`
	EmailHint   string `json:"emailHint"`   // 服务端下发的账号邮箱(可能脱敏)
	PlanType    string `json:"planType"`    // 账号会员等级(antigravity: ultra/...; codex: plus/pro; anthropic: max/pro)
	AccessToken string `json:"accessToken"` // 当前租约的 access token
	ExpiresAt   int64  `json:"expiresAt"`   // token 过期时间(epoch ms)
	LeasedAt    int64  `json:"leasedAt"`    // 本次租到的时间(epoch ms)
	ProjectId   string `json:"projectId,omitempty"` // 仅 antigravity 有
}

// collectBoundAccounts 汇总三个 leaser 各自最近一次成功租到的账号信息;
// 尚未租到的产品不进列表(前端据此显示「获取中」)。
func collectBoundAccounts() []BoundAccountInfo {
	out := []BoundAccountInfo{}
	add := func(info *BoundAccountInfo) {
		if info == nil {
			return
		}
		// 绝不把真实 access token 下发到前端 —— 前端拿到的永远是不可还原的脱敏串,
		// 既无法显示原文也无法复制出可用 token。前端只需知道"有没有令牌"。
		info.AccessToken = redactToken(info.AccessToken)
		out = append(out, *info)
	}
	add(GetLeaser().BoundAccountInfo())
	add(GetCodexLeaser().BoundAccountInfo())
	add(GetClaudeLeaser().BoundAccountInfo())
	return out
}

// redactToken 把 access token 脱敏成不可还原的串:仅保留前缀(标识 token 类型,如
// sk-ant-oat01- / eyJ…),其余全部用固定省略号替代——不暴露主体、不暴露尾部、不暴露长度。
// 返回值只用于前端展示,绝不可还原出真实 token。
func redactToken(tok string) string {
	if tok == "" {
		return ""
	}
	r := []rune(tok)
	prefix := 6
	if len(r) < prefix {
		prefix = len(r)
	}
	return string(r[:prefix]) + "••••••(已隐藏)"
}

// BoundAccountInfo 读 antigravity 主 leaser 当前缓存的 token(cachedToken)。
func (l *Leaser) BoundAccountInfo() *BoundAccountInfo {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if l.cachedToken == nil {
		return nil
	}
	t := l.cachedToken
	return &BoundAccountInfo{
		Product:     "antigravity",
		AccountId:   t.AccountId,
		EmailHint:   t.EmailHint,
		PlanType:    t.PlanType,
		AccessToken: t.AccessToken,
		ExpiresAt:   t.ExpiresAt,
		LeasedAt:    t.LeasedAt,
		ProjectId:   t.ProjectId,
	}
}

// BoundAccountInfo 读 codex leaser 最近一次成功租到的号。
func (l *CodexLeaser) BoundAccountInfo() *BoundAccountInfo {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.lastLease == nil {
		return nil
	}
	t := l.lastLease
	return &BoundAccountInfo{
		Product:     "codex",
		AccountId:   t.AccountId,
		EmailHint:   t.EmailHint,
		PlanType:    t.PlanType,
		AccessToken: t.AccessToken,
		ExpiresAt:   t.ExpiresAt,
		LeasedAt:    t.LeasedAt,
	}
}

// BoundAccountInfo 读 anthropic(claude)leaser 最近一次成功租到的号。
func (l *ClaudeLeaser) BoundAccountInfo() *BoundAccountInfo {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.lastLease == nil {
		return nil
	}
	t := l.lastLease
	return &BoundAccountInfo{
		Product:     "anthropic",
		AccountId:   t.AccountId,
		EmailHint:   t.EmailHint,
		PlanType:    t.PlanType,
		AccessToken: t.AccessToken,
		ExpiresAt:   t.ExpiresAt,
		LeasedAt:    t.LeasedAt,
	}
}
