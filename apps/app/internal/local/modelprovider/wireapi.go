package modelprovider

import (
	"net/url"
	"strings"
)

// chatCompletionsHosts 是已知的 OpenAI /chat/completions 兼容厂商域名片段,
// 逐字移植自 cockpit normalize_model_provider_wire_api。命中即判为 chat_completions。
var chatCompletionsHosts = []string{
	"/chat/completions",
	"api.deepseek.com",
	"api.moonshot.cn",
	"api.siliconflow.cn",
	"api.siliconflow.com",
	"open.bigmodel.cn",
	"api.z.ai",
	"volces.com",
	"bytepluses.com",
	"qianfan.baidubce.com",
	"dashscope.aliyuncs.com",
	"api.stepfun.com",
	"api.stepfun.ai",
	"modelscope.cn",
	"api.longcat.chat",
	"api.minimax.io",
	"api.mini-max.chat",
	"api.minimaxi.com",
	"api.mimo.dev",
	"token-plan-cn.xiaomimimo.com",
	"api.novita.ai",
	"integrate.api.nvidia.com",
	"runapi.co",
	"relaxycode.com",
	"compshare.cn",
	"api.lemondata.cc",
	"e-flowcode.cc",
	"cc-api.pipellm.ai",
	"openrouter.ai",
	"api.therouter.ai",
}

// NormalizeWireAPI 把外部 wireApi 值(可能空/别名)归一到合法协议。
// 显式 responses / chat_completions(含 openai 别名)优先;否则按 baseURL 域名启发式。
// 移植自 cockpit normalize_model_provider_wire_api(默认回退 responses)。
func NormalizeWireAPI(value, baseURL string) WireAPI {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "chat_completions", "chat-completions", "chatcompletions", "openai":
		return WireChatCompletions
	case "responses":
		return WireResponses
	}
	lower := strings.ToLower(strings.TrimSpace(baseURL))
	for _, frag := range chatCompletionsHosts {
		if strings.Contains(lower, frag) {
			return WireChatCompletions
		}
	}
	return WireResponses
}

// modelsURL 由 baseURL 推出 /models 端点(对齐 cockpit codex_model_provider_models_url)。
// 保留 baseURL 既有路径(如 /v1),仅追加 /models;清掉 query;校验 http(s) scheme。
func modelsURL(baseURL string) (string, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if trimmed == "" {
		return "", errInvalidBaseURL
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		return "", errInvalidBaseURL
	}
	switch u.Scheme {
	case "http", "https":
	default:
		return "", errInvalidBaseURL
	}
	if u.Host == "" {
		return "", errInvalidBaseURL
	}
	if u.Path == "" || u.Path == "/" {
		u.Path = "/models"
	} else {
		u.Path = strings.TrimRight(u.Path, "/") + "/models"
	}
	u.RawQuery = ""
	return u.String(), nil
}

type sentinelErr string

func (e sentinelErr) Error() string { return string(e) }

const errInvalidBaseURL = sentinelErr("PROVIDER_BASE_URL_INVALID")
