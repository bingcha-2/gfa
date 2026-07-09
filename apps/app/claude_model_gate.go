package main

import "strings"

// claude_model_gate.go —— 本地模型闸:接管期间只放行 Anthropic Claude 模型,其余一律
// 就地拒绝,【绝不】发往上游 api.anthropic.com。
//
// 背景:接管走「租令牌 + 客户端自证」链路,model 字段由客户端请求体原样带入,无任何
// 服务端白名单(见 claude_proxy.go extractClaudeModelKey)。用户若在 shell 里
// export ANTHROPIC_MODEL=deepseek-v4-pro[1m],或跑第三方多后端工具,这些非 Claude
// 模型会被原样转发给公开 API → 上游回 404(徒耗一次取号 + 污染号池指纹 + 触发按模型
// 冷却)。故在转发前本地拦下:非 claude / 国产·第三方厂商 / 中转别名后缀 一律拒。
//
// 判定顺序(命中即拒):
//  1. 黑名单兜底:命中已知第三方/国产厂商关键词 —— 即便名字里塞了 "claude" 做诱饵
//     (如 deepseek-claude-proxy)也拒。
//  2. 别名后缀:含 '[' 或 ']'(如 claude-opus-4-8[1m])—— 中转工具的 1M/thinking
//     别名写法,公开 API 不认,发上去也是 404。
//  3. 白名单:模型名必须包含 "claude",否则拒。
//
// 空模型名不在此拦(由调用方回落到合法默认模型)。

// claudeThirdPartyModelSubstrings 是显式黑名单:国产 + 常见西方第三方厂商关键词(小写)。
// 命中即判非 Anthropic 模型。列表只需覆盖厂商标识,不必穷举具体版本号。
var claudeThirdPartyModelSubstrings = []string{
	// 国产
	"deepseek",
	"qwen", "tongyi",
	"kimi", "moonshot",
	"glm", "zhipu", "chatglm",
	"doubao", "volcengine",
	"ernie", "wenxin",
	"hunyuan",
	"minimax", "abab",
	"baichuan",
	"spark", "xinghuo",
	"step-", "yi-",
	// 西方第三方
	"gpt", "openai", "o1-", "o3-", "o4-",
	"gemini", "palm",
	"grok",
	"llama",
	"mistral", "mixtral",
	"command-r", "cohere",
}

// isBlockedClaudeModel 判断模型名是否应被本地拦截(不发上游)。返回 (blocked, 中文原因)。
func isBlockedClaudeModel(model string) (bool, string) {
	m := strings.ToLower(strings.TrimSpace(model))
	if m == "" {
		return false, "" // 空由调用方回落默认模型,不在此拦
	}
	for _, bad := range claudeThirdPartyModelSubstrings {
		if strings.Contains(m, bad) {
			return true, "第三方/非 Anthropic 模型"
		}
	}
	if strings.ContainsAny(m, "[]") {
		return true, "非法模型别名后缀(公开 API 不认)"
	}
	if !strings.Contains(m, "claude") {
		return true, "非 Claude 模型"
	}
	return false, ""
}
