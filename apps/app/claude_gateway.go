package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// ─── Claude Code「网关托管」(CC Switch 直连模式式)──────────────────────────────────
//
// 与旧的「租号 + 本地代理」接管不同:这里不租 OAuth 令牌、不起本地 MITM、不要求 TUN,
// 也不做出口前置闸(enforceEgressGate)—— 请求由服务端的 /api/gateway/v1/messages 转发,
// 服务端用母号 key 去上游,客户端自始至终拿不到母号 key。
//
// 客户端只做两件事:
//  1. 调 POST /app/gateway/activate(带登录态),换回 gfa 为本人签发的专用 key + 模型 + 额度;
//  2. 往 ~/.claude/settings.json 里「打补丁」:只改 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN
//     等少数键,并记下这些键的原值;取消托管时只把这些键还原,用户的 hooks、插件、权限等
//     其余配置全程不动(旧接管是整份替换,网关模式不需要:key 只能打 gfa 网关、只能花本人额度)。
//
// 专用 key 写在本机 settings.json 里是明文(与 CC Switch 一致),因此文件和备份都是 0600;
// 它可在后台单独换 key 作废,不是母号凭证。

// prevVal 记录一个键托管前的状态(是否存在 + 原值)。
type prevVal struct {
	Present bool        `json:"present"`
	Value   interface{} `json:"value,omitempty"`
}

// gatewayPrev 是托管前被我们改动的键的原值快照,取消托管时据此还原。
type gatewayPrev struct {
	Env   map[string]prevVal `json:"env"`
	Model *prevVal           `json:"model,omitempty"` // 顶层 model 字段
}

// GatewayActivation 是 /app/gateway/activate 的响应。
type GatewayActivation struct {
	Key             string   `json:"key"`
	MotherAccountID string   `json:"motherAccountId"`
	Shares          int      `json:"shares"`
	LimitUSD        float64  `json:"limitUsd"`
	UsedUSD         float64  `json:"usedUsd"`
	RemainingUSD    float64  `json:"remainingUsd"`
	Models          []string `json:"models"`
}

// gatewayClaudeBaseURL 返回写进 Claude Code 的网关地址(Claude Code 会自己追加 /v1/messages)。
func gatewayClaudeBaseURL() string {
	return strings.TrimRight(authBaseURL, "/") + "/gateway"
}

// isGatewayKey 判断 token 是否是 gfa 签发的网关专用 key(前缀 gfa-)。
func isGatewayKey(v string) bool { return strings.HasPrefix(v, "gfa-") }

func asString(v interface{}) string {
	s, _ := v.(string)
	return s
}

// gatewayTouchedEnvKeys 是网关托管会读写的全部 env 键(托管前先抓原值)。
func gatewayTouchedEnvKeys() []string {
	keys := []string{claudeBaseURLKey, claudeAuthTokenKey, claudeApiKeyKey}
	keys = append(keys, claudeFoundryKeys...)
	keys = append(keys, claudeModelOverrideKeys...)
	return keys
}

// claudeModelAliases 是 Claude Code 自己认的模型别名,由客户端解析成具体 id,不属于「写死的模型名」,保留。
var claudeModelAliases = map[string]bool{
	"default": true, "sonnet": true, "opus": true, "haiku": true,
	"opusplan": true, "best": true, "sonnet[1m]": true, "opus[1m]": true,
}

// modelAllowed 判断用户配置的模型名是否能被该母号服务:在模型列表里,或是 Claude Code 别名。
func modelAllowed(model string, allowed map[string]bool) bool {
	m := strings.TrimSpace(model)
	if m == "" || claudeModelAliases[strings.ToLower(m)] {
		return true
	}
	m = strings.TrimSuffix(m, "[1m]") // 1M 上下文标记不是模型 id 的一部分
	return allowed[m]
}

func capturePrev(settings map[string]interface{}) *gatewayPrev {
	prev := &gatewayPrev{Env: map[string]prevVal{}}
	env, _ := settings["env"].(map[string]interface{})
	for _, k := range gatewayTouchedEnvKeys() {
		if v, ok := env[k]; ok {
			prev.Env[k] = prevVal{Present: true, Value: v}
		} else {
			prev.Env[k] = prevVal{Present: false}
		}
	}
	if v, ok := settings["model"]; ok {
		prev.Model = &prevVal{Present: true, Value: v}
	}
	return prev
}

// applyGatewayPatch 在 settings 上就地打补丁(不碰其余任何键)。models 为空表示不处理模型覆盖。
func applyGatewayPatch(settings map[string]interface{}, baseURL, key string, models []string) {
	env, _ := settings["env"].(map[string]interface{})
	if env == nil {
		env = map[string]interface{}{}
	}
	env[claudeBaseURLKey] = baseURL
	env[claudeAuthTokenKey] = key
	env[claudeApiKeyKey] = "" // 置空覆盖 shell export 的真实 key,强制走 AUTH_TOKEN(只留一个,避免 Claude Code 双 key 警告)
	for _, k := range claudeFoundryKeys {
		env[k] = ""
	}
	if len(models) > 0 {
		allowed := map[string]bool{}
		for _, m := range models {
			allowed[m] = true
		}
		// 母号不支持的写死模型名会被网关拒绝 → 直接移除,让 Claude Code 用默认模型。
		for _, k := range claudeModelOverrideKeys {
			if v, ok := env[k]; ok && !modelAllowed(asString(v), allowed) {
				delete(env, k)
			}
		}
		if v, ok := settings["model"]; ok && !modelAllowed(asString(v), allowed) {
			delete(settings, "model")
		}
	}
	settings["env"] = env
}

// InjectClaudeGateway 以补丁方式写入网关配置(备份被改键原值,不整份替换用户文件)。
func InjectClaudeGateway(baseURL, key string, models []string) error {
	if key == "" {
		return fmt.Errorf("网关 key 为空")
	}
	claudeInjectMu.Lock()
	defer claudeInjectMu.Unlock()

	bk := readClaudeBackup()
	if bk == nil {
		bk = &claudeBackup{}
	}
	// 旧租号接管仍在生效:先把用户原文件还原回来,再在原文件上打补丁。
	if bk.CLIActive && !bk.GatewayActive && bk.OriginalCaptured {
		if err := restoreClaudeOriginalFile(bk, false); err != nil {
			return err
		}
		bk.CLIActive = false
	}

	raw, had := readClaudeSettingsRaw()
	settings := map[string]interface{}{}
	if had {
		if err := json.Unmarshal(raw, &settings); err != nil {
			// 用户的文件不是合法 JSON:不擅自覆盖,让用户先修。
			return fmt.Errorf("~/.claude/settings.json 不是合法 JSON,请先修复后再托管: %v", err)
		}
	}
	if !bk.OriginalCaptured {
		captureClaudeOriginal(bk) // 兜底整份副本(备份文件 0600)
	}
	if !bk.GatewayActive {
		// 首次托管才抓原值;重复激活(换 key / 刷新模型)时沿用,避免把我们自己写的值当成用户原值。
		bk.GatewayPrev = capturePrev(settings)
		bk.GatewayHadFile = had
	}
	bk.GatewayActive = true
	bk.GatewayBaseURL = baseURL
	writeClaudeBackup(bk) // 先写备份再改文件:中途崩溃也能还原

	applyGatewayPatch(settings, baseURL, key, models)
	if err := writeClaudeSettings(settings); err != nil {
		return err
	}
	ensureClaudeOnboardingComplete()
	// 日志里不打印 key。
	Log("[claude-gateway] 已写入网关托管配置: %s=%s (path: %s)", claudeBaseURLKey, baseURL, claudeSettingsPath())
	return nil
}

// restoreGatewayLocked 只还原网关托管改过的键(调用方已持有 claudeInjectMu)。
// 对每个键,仅当它当前仍是我们写的值才还原;用户托管期间自己改过的值不覆盖。
func restoreGatewayLocked(bk *claudeBackup) error {
	raw, had := readClaudeSettingsRaw()
	if had && bk.GatewayPrev != nil {
		settings := map[string]interface{}{}
		if err := json.Unmarshal(raw, &settings); err != nil {
			return fmt.Errorf("~/.claude/settings.json 已不是合法 JSON,无法自动还原: %v", err)
		}
		env, _ := settings["env"].(map[string]interface{})
		if env == nil {
			env = map[string]interface{}{}
		}
		for k, pv := range bk.GatewayPrev.Env {
			cur, exists := env[k]
			ours := false
			switch k {
			case claudeBaseURLKey:
				ours = exists && asString(cur) == bk.GatewayBaseURL
			case claudeAuthTokenKey:
				ours = exists && isGatewayKey(asString(cur))
			case claudeApiKeyKey:
				ours = exists && asString(cur) == ""
			default:
				if isFoundryKey(k) {
					ours = exists && asString(cur) == ""
				} else {
					ours = !exists // 模型覆盖键:被我们移除过才还原
				}
			}
			if !ours {
				continue
			}
			if pv.Present {
				env[k] = pv.Value
			} else {
				delete(env, k)
			}
		}
		if pm := bk.GatewayPrev.Model; pm != nil && pm.Present {
			if _, exists := settings["model"]; !exists {
				settings["model"] = pm.Value
			}
		}
		if len(env) == 0 {
			delete(settings, "env")
		} else {
			settings["env"] = env
		}
		if !bk.GatewayHadFile && len(settings) == 0 {
			_ = os.Remove(claudeSettingsPath())
		} else if err := writeClaudeSettings(settings); err != nil {
			return err
		}
	}

	bk.GatewayActive = false
	bk.GatewayPrev = nil
	bk.GatewayBaseURL = ""
	if !bk.CLIActive && !bk.DesktopActive {
		_ = os.Remove(claudeBackupPath())
	} else {
		writeClaudeBackup(bk)
	}
	Log("[claude-gateway] 已取消网关托管,仅还原被改动的键 (path: %s)", claudeSettingsPath())
	return nil
}

func isFoundryKey(k string) bool {
	for _, f := range claudeFoundryKeys {
		if f == k {
			return true
		}
	}
	return false
}

// IsClaudeGatewayInjected 判断 settings.json 当前是否指向 gfa 网关。
func IsClaudeGatewayInjected() bool {
	settings, had := loadClaudeSettings()
	if !had {
		return false
	}
	env, ok := settings["env"].(map[string]interface{})
	if !ok {
		return false
	}
	base, _ := env[claudeBaseURLKey].(string)
	return base != "" && base == gatewayClaudeBaseURL()
}

// HostClaudeGateway 是「一键托管」(网关模式)入口:激活 → 写配置。
// 不检查出口代理、不要求 TUN;只要求已登录。
func (a *App) HostClaudeGateway() (string, error) {
	cfg := LoadConfig()
	if err := validateTakeoverPrereqs(cfg); err != nil {
		return "", err
	}
	body, status, err := doAuthPostWithBearer("/app/gateway/activate", struct{}{}, cfg.UserToken)
	if err != nil {
		return "", fmt.Errorf("连接服务器失败: %v", err)
	}
	if status != 200 && status != 201 {
		return "", fmt.Errorf("%s", gatewayActivateError(body, status))
	}
	var act GatewayActivation
	if err := json.Unmarshal(body, &act); err != nil || act.Key == "" {
		return "", fmt.Errorf("服务器返回的托管信息无效")
	}
	if err := InjectClaudeGateway(gatewayClaudeBaseURL(), act.Key, act.Models); err != nil {
		return "", takeoverErrorForUser(err)
	}
	return fmt.Sprintf(
		"Claude Code: ✓ 已托管(母号 %s) —— 额度 $%.2f,剩余 $%.2f,可用 %d 个模型。请【重启 CLI / Reload VSCode 窗口】使配置生效",
		act.MotherAccountID, act.LimitUSD, act.RemainingUSD, len(act.Models)), nil
}

// RestoreClaudeGateway 取消网关托管,只还原被改动的键。
func (a *App) RestoreClaudeGateway() (string, error) {
	if err := RestoreClaudeSettings(); err != nil {
		return "", takeoverErrorForUser(err)
	}
	return "Claude Code: ✓ 已取消托管(CLI 下次启动生效;VSCode 扩展请 Reload Window)", nil
}

// gatewayActivateError 把服务端的错误体翻成给用户看的一句话。
func gatewayActivateError(body []byte, status int) string {
	var e struct {
		Message interface{} `json:"message"`
	}
	if json.Unmarshal(body, &e) == nil {
		switch m := e.Message.(type) {
		case string:
			if m != "" {
				return m
			}
		case []interface{}:
			if len(m) > 0 {
				return fmt.Sprint(m[0])
			}
		}
	}
	if status == 401 || status == 403 {
		return "登录状态已失效,请重新登录"
	}
	return fmt.Sprintf("托管失败(HTTP %d)", status)
}
