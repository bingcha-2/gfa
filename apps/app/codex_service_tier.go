package main

import (
	"encoding/json"
	"strings"
)

// codexFastServiceTier 是 Codex「快速(Fast)」档在 responses 请求体 service_tier 字段里的
// 字面值。cockpit 把 fast/priority/flex 都归一显示为「Fast」,但真正写进请求/config 的是
// priority(≠ 字面 "fast",也 ≠ reasoning effort)。
const codexFastServiceTier = "priority"

// codexPlanSupportsFast 判断某会员等级的 ChatGPT 号是否具备「快速」服务档能力。
// 快速(priority)是 Pro / Team / Business / Enterprise / Edu 的特性;Plus / Free / 未知
// 一律不发 priority —— 上游对不具此能力的号会忽略或直接报错,发了纯属浪费(还可能触发 4xx
// 换号抖动)。这是「能力闸」,与服务端下发的「授权闸」(FastAllowed)叠加才注入。
func codexPlanSupportsFast(planType string) bool {
	p := strings.ToLower(strings.TrimSpace(planType))
	if p == "" {
		return false
	}
	// 注意:"plus" 不含子串 "pro",故下面的 "pro" 命中不会误伤 Plus。
	switch {
	case strings.Contains(p, "enterprise"),
		strings.Contains(p, "business"),
		strings.Contains(p, "team"),
		strings.Contains(p, "edu"),
		strings.Contains(p, "pro"):
		return true
	default:
		return false
	}
}

// applyCodexServiceTier 按「用户开了快速档 + 被租号 plan 支持」主动注入/剥离请求体的 service_tier:
//   - 都满足(fastWanted && plan 支持)→ 注入 service_tier=priority。
//     必须主动注入:自定义 provider 接管模式下 Codex **根本不把 service_tier 写进请求体**
//     (它是 ChatGPT 模式的东西,被自定义 provider 忽略),写 config.toml 也没用,只能代理来加。
//   - 否则 → 剥掉请求体里任何残留的 priority,回落标准档(上游对不支持的号发 priority 会忽略/报错;
//     也堵住共享号被白嫖快速额度)。
//
// fastWanted 来自客户端 codexFastMode 开关;planType 是租约带回的真实被租号 plan。
// 解析失败一律原样返回(绝不因改写破坏请求体)。
func applyCodexServiceTier(body []byte, fastWanted bool, planType string) []byte {
	var payload map[string]interface{}
	if err := json.Unmarshal(body, &payload); err != nil {
		return body
	}
	cur, _ := payload["service_tier"].(string)
	changed := false
	if fastWanted && codexPlanSupportsFast(planType) {
		if cur != codexFastServiceTier {
			payload["service_tier"] = codexFastServiceTier
			changed = true
		}
	} else if strings.EqualFold(cur, codexFastServiceTier) {
		delete(payload, "service_tier")
		changed = true
	}
	if !changed {
		return body
	}
	rewritten, err := json.Marshal(payload)
	if err != nil {
		return body
	}
	return rewritten
}

// codexRequestServiceTier 读出请求体最终生效的 service_tier(空=标准档)。在 applyCodexServiceTier
// 之后调用,反映真正发往上游的档位,供用量上报(服务端按 priority 乘数扣公平份额)。
func codexRequestServiceTier(body []byte) string {
	var payload map[string]interface{}
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}
	tier, _ := payload["service_tier"].(string)
	return tier
}
