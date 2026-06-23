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

// detectClaudeCodeClient 检查请求体 + 头,判断是否真 Claude Code。
// genuine=false 时返回一个简短、无 PII 的 flag 说明哪儿对不上,供后台按卡聚合定位反代。
// 判定只看 system 指纹(决定性);UA 等头信息仅作为 flag 里的排查线索,不参与判定。
func detectClaudeCodeClient(body []byte, h http.Header) (genuine bool, flag string) {
	if bodyHasClaudeCodeSystem(body) {
		return true, ""
	}
	reasons := []string{"no_cc_system_prompt"}
	ua := strings.ToLower(strings.TrimSpace(h.Get("User-Agent")))
	if !strings.HasPrefix(ua, "claude-cli/") {
		reasons = append(reasons, "ua_not_cli")
	}
	// x-app: cli 与 x-stainless-* 是真 CLI 的附带头;缺失再加一条线索(仍只是线索)。
	if !strings.EqualFold(strings.TrimSpace(h.Get("x-app")), "cli") {
		reasons = append(reasons, "no_x_app_cli")
	}
	return false, strings.Join(reasons, ",")
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

// rewriteMetadataUserID 如果请求体里有 metadata.user_id,就地替换成 canonicalID;
// 没有 metadata 或 user_id 则原样返回(不注入新字段,避免干扰不带此字段的客户端)。
func rewriteMetadataUserID(body []byte, canonicalID string) []byte {
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
	if _, has := meta["user_id"]; !has {
		return body
	}
	uidJSON, _ := json.Marshal(canonicalID)
	meta["user_id"] = uidJSON
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
