package hub

import (
	"encoding/json"
	"os"
	"strings"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/codeximport"
)

// ── 账号获取(导入 / 同步,移植 cockpit) ──
//
// 与 SetSource 的「注入式接管」相反:这里是「把现成的号读进 store」。三条来源:
//   - ImportCodexFromLocal:读本机 ~/.codex/auth.json(codexinject 写入的反向)。
//   - ImportCodexAuthFiles / ImportAntigravityAuthFiles:用户拖进来的文件文本,
//     依次试 codex auth.json / antigravity 凭证 JSON / 我们导出的 ExportRecord[]。
//   - SyncAntigravityFromIDE:读已装 IDE 的 state.vscdb 注入/登录态。
// 全部按 email 去重,返回新增数量。

// ImportCodexFromLocal 读本机 ~/.codex/auth.json,解析成自有号加入 store(按 email 去重)。
func (h *Hub) ImportCodexFromLocal() (int, error) {
	path := h.platform.CodexAuthJSONPath()
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	a, err := codeximport.ParseAuthJSON(raw)
	if err != nil {
		return 0, err
	}
	return h.addAccountsDedup(account.ProviderCodex, []*account.Account{a})
}

// ImportCodexAuthFiles 把多段文件文本导入为 codex 自有号(按 email 去重),返回新增数量。
// 每段依次尝试:我们导出的 ExportRecord[](manager.ImportJSON 兜底)→ codex auth.json。
func (h *Hub) ImportCodexAuthFiles(contents []string) (int, error) {
	pc, err := h.ctx(account.ProviderCodex)
	if err != nil {
		return 0, err
	}
	total := 0
	for _, c := range contents {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		// 先试我们自己的导出格式(ExportRecord[]),它自带去重。
		if n, ierr := pc.mgr.ImportJSON(c); ierr == nil {
			total += n
			continue
		}
		// 再试 codex auth.json(单账号)。
		a, perr := codeximport.ParseAuthJSON([]byte(c))
		if perr != nil {
			continue
		}
		n, aerr := h.addAccountsDedup(account.ProviderCodex, []*account.Account{a})
		if aerr != nil {
			return total, aerr
		}
		total += n
	}
	return total, nil
}

// ImportAntigravityAuthFiles 把多段文件文本导入为 antigravity 自有号(按 email 去重)。
// 每段依次尝试:我们导出的 ExportRecord[](manager.ImportJSON 兜底)→ antigravity 凭证 JSON。
func (h *Hub) ImportAntigravityAuthFiles(contents []string) (int, error) {
	pc, err := h.ctx(account.ProviderAntigravity)
	if err != nil {
		return 0, err
	}
	total := 0
	for _, c := range contents {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		if n, ierr := pc.mgr.ImportJSON(c); ierr == nil {
			total += n
			continue
		}
		a, ok := parseAntigravityCredential([]byte(c))
		if !ok {
			continue
		}
		n, aerr := h.addAccountsDedup(account.ProviderAntigravity, []*account.Account{a})
		if aerr != nil {
			return total, aerr
		}
		total += n
	}
	return total, nil
}

// SyncAntigravityFromIDE 读已装 Antigravity IDE 的登录态(state.vscdb)同步成自有号
// (按 email 去重),返回新增数量。对齐 cockpit accounts.syncCurrentFromClient。
func (h *Hub) SyncAntigravityFromIDE() (int, error) {
	tok, err := h.platform.AntigravityReadIDEToken()
	if err != nil {
		return 0, err
	}
	a := &account.Account{
		Provider:     account.ProviderAntigravity,
		Email:        tok.Email,
		AuthKind:     account.AuthOAuth,
		AccessToken:  tok.AccessToken,
		RefreshToken: tok.RefreshToken,
		IDToken:      tok.IDToken,
		ProjectID:    tok.ProjectID,
		Expiry:       tok.Expiry,
		IsGCPTos:     tok.IsGCPTos,
		PoolEnabled:  true,
		QuotaStatus:  account.QuotaOK,
	}
	return h.addAccountsDedup(account.ProviderAntigravity, []*account.Account{a})
}

// dedupKey 去重键:优先 email;email 为空(API-key/无邮箱 auth)时退到 token/key/accountID,
// 避免「无 email 的号每次导入都重复新增」。
func dedupKey(a *account.Account) string {
	if a.Email != "" {
		return "email:" + a.Email
	}
	if a.RefreshToken != "" {
		return "rt:" + a.RefreshToken
	}
	if a.AccessToken != "" {
		return "at:" + a.AccessToken
	}
	if a.APIKey != "" {
		return "key:" + a.APIKey
	}
	if a.AccountID != "" {
		return "acc:" + a.AccountID
	}
	return ""
}

// addAccountsDedup 把账号加入 store,按 dedupKey 去重(已存在则跳过)。
// 有新增则 reload 网关。返回新增数量。
func (h *Hub) addAccountsDedup(p account.Provider, accs []*account.Account) (int, error) {
	pc, err := h.ctx(p)
	if err != nil {
		return 0, err
	}
	existing, err := h.acc.List(p)
	if err != nil {
		return 0, err
	}
	seen := map[string]bool{}
	for _, a := range existing {
		if k := dedupKey(a); k != "" {
			seen[k] = true
		}
	}
	added := 0
	for _, a := range accs {
		if a == nil {
			continue
		}
		k := dedupKey(a)
		if k != "" && seen[k] {
			continue
		}
		a.Provider = p
		if err := h.acc.Add(a); err != nil {
			return added, err
		}
		if k != "" {
			seen[k] = true
		}
		added++
	}
	if added > 0 {
		pc.mgr.ReloadGateway()
	}
	return added, nil
}

// parseAntigravityCredential 解析 antigravity 凭证 JSON(对齐我们注入/导出的字段),
// 兼容 snake/camel 键。无可用 token 返回 false。
func parseAntigravityCredential(raw []byte) (*account.Account, bool) {
	var v map[string]any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, false
	}
	src := v
	if nested, ok := v["tokens"].(map[string]any); ok {
		src = nested
	}
	access := credString(src, "access_token", "accessToken")
	refresh := credString(src, "refresh_token", "refreshToken")
	if access == "" && refresh == "" {
		return nil, false
	}
	return &account.Account{
		Provider:     account.ProviderAntigravity,
		Email:        credString(v, "email", "account_email"),
		AuthKind:     account.AuthOAuth,
		AccessToken:  access,
		RefreshToken: refresh,
		IDToken:      credString(src, "id_token", "idToken"),
		ProjectID:    credString(v, "project_id", "projectId", "project"),
		PoolEnabled:  true,
		QuotaStatus:  account.QuotaOK,
	}, true
}

func credString(v map[string]any, keys ...string) string {
	for _, k := range keys {
		if s, ok := v[k].(string); ok && strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}
