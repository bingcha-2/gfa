package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

// 反代检测:判定一条 /v1/messages 请求是否来自「真 Claude Code」。
//
// 背景:一个订阅号被多张卡共享。如果某张卡的持有者在自己那头架了反向代理、或换了
// 别的客户端(Cline / Roo / OpenAI 兼容壳 / 裸 API 转卖)再分发出去,这种流量不长得
// 像真 Claude Code —— 而它正是把共享订阅号用成「转卖 API」、招致上游 403 封号的主因。
//
// 真 Claude Code 每次 /v1/messages 的 system 第一块【必然】带固定开场白(下方常量)。
// 反代/换客户端几乎不可能原样带上这一模一样的 system 块,所以「缺失」基本等于反代。
// 这是最硬、最低误伤的硬指纹;能被肯花功夫的高仿反代照抄绕过,那一层得靠并发/节奏统计。
const claudeCodeSystemSignature = "You are Claude Code, Anthropic's official CLI for Claude"

// detectClaudeCodeClient 检查请求体 + 头,判断是否真 Claude Code。正版需命中以下之一:
//
//	(A) system 第一块带 CLI 开场白 —— body 里的硬指纹,最难伪造;
//	(B) 整套客户端指纹【同时】出现:claude-cli/ UA + anthropic-beta 带 oauth-(或
//	    claude-code) + X-Claude-Code-Session-Id。单带一个头不算 —— 那太容易塞;要的是
//	    "非 CLI 正版面(VSCode/JetBrains/Agent SDK/后台 haiku 任务)不被误杀,又不给随手
//	    塞一个头的反代放行"。oauth- 是订阅客户端【每条请求】都带的本质标记;claude-code 只是
//	    feature flag,后台 haiku 任务会丢 —— 故二者任一即可。
//
// 注:能照搬整套指纹的高仿照样能骗过这层(头/system 都可复制)—— 那一层靠统计兜底
// (一个母号下多 user_id / 多来源 IP / 高并发 / 每分钟多 session)。这层只过滤掉
// 懒的、外来的客户端(Cline/Roo/裸 API/OpenAI 壳),它们占转卖的大头。
func detectClaudeCodeClient(body []byte, h http.Header) (genuine bool, flag string) {
	if bodyHasClaudeCodeSystem(body) {
		return true, ""
	}
	ua := strings.ToLower(strings.TrimSpace(h.Get("User-Agent")))
	hasCliUA := strings.HasPrefix(ua, "claude-cli/")
	// oauth- 是第一方订阅客户端【每条请求】都带的本质标记(主对话 + 后台 haiku 任务都带);
	// claude-code 只是 feature flag,后台任务会丢 —— 故二者任一即可。两个都按【去日期前缀 +
	// 整 token】匹配,Anthropic 滚版本号(oauth-2026-… / claude-code-…)也不受影响。
	beta := h.Get("Anthropic-Beta")
	hasOAuthBeta := betaHasToken(beta, "oauth-")
	hasCCBeta := betaHasToken(beta, "claude-code")
	hasSession := strings.TrimSpace(h.Get("X-Claude-Code-Session-Id")) != ""
	if hasCliUA && hasSession && (hasOAuthBeta || hasCCBeta) {
		return true, ""
	}
	// 反代嫌疑:返回简短、无 PII 的 flag 说明缺了哪几样,后台据此分辨"非 CLI 正版" vs "真转卖"。
	reasons := []string{"no_cc_system_prompt"}
	if ua == "" {
		reasons = append(reasons, "no_ua")
	} else if !hasCliUA {
		// 长着别的客户端的脸(Cline/Roo/python-requests/axios/openai-* 等)= 反代正向标记。
		reasons = append(reasons, "foreign_ua")
	}
	if !hasOAuthBeta && !hasCCBeta {
		reasons = append(reasons, "no_oauth_beta")
	}
	if !hasSession {
		reasons = append(reasons, "no_session_id")
	}
	return false, strings.Join(reasons, ",")
}

// betaHasToken 判断逗号分隔的 anthropic-beta 里是否有 token 以 prefix 开头(忽略大小写/空白)。
// 用前缀 + 整 token 匹配:带日期的 flag(oauth-2025-04-20 / claude-code-20250219)随版本号
// 变化也命中,且不会被某个 token 中间碰巧含该串误伤。
func betaHasToken(beta, prefix string) bool {
	for _, tok := range strings.Split(strings.ToLower(beta), ",") {
		if strings.HasPrefix(strings.TrimSpace(tok), prefix) {
			return true
		}
	}
	return false
}

// extractMetadataUserID 从请求体抠 Claude Code 的 metadata.user_id(每用户稳定 hash)。
// 缺失/非 JSON → ""。用于按母号统计"多少个不同真实用户在用一个订阅号"(转卖/共享的硬信号)。
func extractMetadataUserID(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	var payload struct {
		Metadata struct {
			UserID string `json:"user_id"`
		} `json:"metadata"`
	}
	if json.Unmarshal(body, &payload) != nil {
		return ""
	}
	return strings.TrimSpace(payload.Metadata.UserID)
}

// canonicalUserID 把 accountID 映射成固定 64 字符 hex(对齐 Claude Code 原生格式:
// crypto.randomBytes(32).toString("hex")),作为转发给上游的 metadata.user_id。
// 同一个订阅号永远输出同一个值 → 上游只看到「一个号 = 一个用户」。
func canonicalUserID(accountID int) string {
	h := sha256.Sum256([]byte("gfa-uid-" + strconv.Itoa(accountID)))
	return hex.EncodeToString(h[:])
}

// rewriteMetadataUserID 改写请求体里的 metadata.user_id,让上游把这个订阅号看成「一个用户」。
//
// Claude Code 现行 user_id 是一段 JSON:{"device_id","account_uuid","session_id"}。
//   - device_id 每台安装唯一、且【不与 OAuth token 绑定】→ 多客户共用一个母号 = 多个 device_id
//     打同一上游号 = 共享铁证;伪造它不会"对不上 token",安全 → 归一成按母号固定的 canonical。
//   - account_uuid 是 Anthropic 账户 uuid,【很可能与 token 绑定】→ 伪造成 hash 会对不上、反而露馅;
//     实测它每母号也非恒定(母号真账户 + 部分客户残留旧账户 + 空,混在一起)。故【透传不动】:
//     真要关这个弱泄露,得由服务端下发母号真实 account_uuid 再改写(既恒定又匹配 token),非此处。
//   - session_id 透传(留着才像正常多会话,不塌成"一个 session 干所有"那种更像 bot 的样子)。
//   - 保留 JSON 结构,否则上游看到的 user_id 不是 Claude Code 格式,反而暴露是代理。
// 老格式(user_id 是裸 hash / 非 JSON)→ 整段替换成 canonicalID(回退旧行为)。
// 没有 metadata 或 user_id 则原样返回。
func rewriteMetadataUserID(body []byte, canonicalID, realAccountUUID string) []byte {
	if len(body) == 0 || canonicalID == "" {
		return body
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal(body, &payload) != nil {
		return body
	}
	metaRaw, ok := payload["metadata"]
	if !ok {
		return body
	}
	var meta map[string]json.RawMessage
	if json.Unmarshal(metaRaw, &meta) != nil {
		return body
	}
	uidRaw, has := meta["user_id"]
	if !has {
		return body
	}
	meta["user_id"] = rewriteUserIDValue(uidRaw, canonicalID, realAccountUUID)
	metaJSON, err := json.Marshal(meta)
	if err != nil {
		return body
	}
	payload["metadata"] = metaJSON
	out, err := json.Marshal(payload)
	if err != nil {
		return body
	}
	return out
}

// rewriteUserIDValue 改写单个 user_id 值(uidRaw 是它的 JSON 编码)。JSON 格式:device_id 换成
// canonicalID;account_uuid 换成母号真实 uuid(realAccountUUID 非空时,既统一又匹配 token);
// session_id 保留。其余情况整段替换成 canonicalID。返回新值的 JSON 编码。
func rewriteUserIDValue(uidRaw json.RawMessage, canonicalID, realAccountUUID string) json.RawMessage {
	flat, _ := json.Marshal(canonicalID) // 兜底:裸 hash / 非 JSON
	var uidStr string
	if json.Unmarshal(uidRaw, &uidStr) != nil {
		return flat // user_id 不是字符串 → 整段替换
	}
	// 结构固定、字段顺序对齐 Claude Code(device_id, account_uuid, session_id)。
	var inner struct {
		DeviceID    string `json:"device_id"`
		AccountUUID string `json:"account_uuid"`
		SessionID   string `json:"session_id"`
	}
	if json.Unmarshal([]byte(uidStr), &inner) != nil || inner.DeviceID == "" {
		return flat // 非 JSON 或没有 device_id → 整段替换
	}
	inner.DeviceID = canonicalID
	if realAccountUUID != "" {
		inner.AccountUUID = realAccountUUID // 服务端下发的母号真 uuid → 每母号恒定 + 匹配 token
	}
	newInner, err := json.Marshal(inner)
	if err != nil {
		return flat
	}
	out, err := json.Marshal(string(newInner))
	if err != nil {
		return flat
	}
	return out
}

// bodyHasClaudeCodeSystem 解析请求体的 system 字段,判断其中是否含 Claude Code 开场白。
// system 既可能是普通字符串,也可能是 [{type,text}] 内容块数组,两种都覆盖。
func bodyHasClaudeCodeSystem(body []byte) bool {
	if len(body) == 0 {
		return false
	}
	var payload struct {
		System json.RawMessage `json:"system"`
	}
	if json.Unmarshal(body, &payload) != nil || len(payload.System) == 0 {
		return false
	}
	// 形态一:system 是普通字符串
	var asString string
	if json.Unmarshal(payload.System, &asString) == nil {
		return strings.Contains(asString, claudeCodeSystemSignature)
	}
	// 形态二:system 是内容块数组 [{type,text}]
	var blocks []struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(payload.System, &blocks) == nil {
		for _, blk := range blocks {
			if strings.Contains(blk.Text, claudeCodeSystemSignature) {
				return true
			}
		}
	}
	return false
}
