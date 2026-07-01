package hub

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"bcai-wails/internal/local/account"
)

// 本地接管注入目标(IDE / 独立版)—— 决定 SetSource(antigravity,'local') 把自有号
// 注入进哪个 Antigravity app 的 state.vscdb。红线:注入目标只影响本地落点,不碰远程租号 / 网关出口。

const antigravityTargetFile = "antigravity-inject-target.json"

// GetAntigravityTarget 返回本地接管注入的目标 app 变体("ide"/"standalone");缺省 ide。
// 决定 SetSource(antigravity,'local') 把自有号注入哪个 app 的 state.vscdb。
func (h *Hub) GetAntigravityTarget() string {
	data, err := os.ReadFile(filepath.Join(h.dir, antigravityTargetFile))
	if err != nil {
		return "ide"
	}
	var m struct {
		Variant string `json:"variant"`
	}
	if json.Unmarshal(data, &m) == nil && m.Variant == "standalone" {
		return "standalone"
	}
	return "ide"
}

// SetAntigravityTarget 持久化注入目标变体;若当前处于 local 接管态,立即重注入到新目标
// (先撤两个 app 的旧注入,再注入到新目标,避免旧 app 残留登录态)。
func (h *Hub) SetAntigravityTarget(variant string) error {
	v := "ide"
	if strings.TrimSpace(variant) == "standalone" {
		v = "standalone"
	}
	data, _ := json.Marshal(struct {
		Variant string `json:"variant"`
	}{v})
	path := filepath.Join(h.dir, antigravityTargetFile)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	h.reinjectIfLocal(account.ProviderAntigravity)
	return nil
}

// injectAntigravityToTarget 先撤两个变体的旧注入,再把 tok 注入当前目标变体。
func (h *Hub) injectAntigravityToTarget(tok AntigravityToken) error {
	h.restoreAntigravityAll()
	return h.platform.AntigravityInjectAccountTo(h.GetAntigravityTarget(), tok)
}

// restoreAntigravityAll 撤销两个变体 app 的注入登录态(未装的变体为 no-op)。
func (h *Hub) restoreAntigravityAll() {
	_ = h.platform.AntigravityRestoreAccountFor("ide")
	_ = h.platform.AntigravityRestoreAccountFor("standalone")
}
