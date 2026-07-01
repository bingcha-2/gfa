package hub

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// Antigravity 本地接管状态 —— 按 app 独立。IDE 与独立版各自可单独把自有号注入其
// state.vscdb,互不影响,和远程那两行(IDE + Hub)对称。
// 红线:只影响本地注入落点(直连官方),不碰远程租号 / 网关出口。

const antigravityLocalFile = "antigravity-local-injected.json"

// antigravityLocalState 记录两个 Antigravity app 各自是否处于本地自有号注入接管态。
type antigravityLocalState struct {
	IDE        bool `json:"ide"`
	Standalone bool `json:"standalone"`
}

// normalizeAntigravityVariant 归一到 "ide" / "standalone"(未知回退 ide)。
func normalizeAntigravityVariant(v string) string {
	if s := strings.TrimSpace(v); s == "standalone" || s == "antigravity" {
		return "standalone"
	}
	return "ide"
}

func (st antigravityLocalState) get(variant string) bool {
	if normalizeAntigravityVariant(variant) == "standalone" {
		return st.Standalone
	}
	return st.IDE
}

func (st *antigravityLocalState) set(variant string, on bool) {
	if normalizeAntigravityVariant(variant) == "standalone" {
		st.Standalone = on
	} else {
		st.IDE = on
	}
}

func (st antigravityLocalState) anyInjected() bool { return st.IDE || st.Standalone }

func (h *Hub) loadAntigravityLocal() antigravityLocalState {
	var st antigravityLocalState
	data, err := os.ReadFile(filepath.Join(h.dir, antigravityLocalFile))
	if err != nil {
		return st
	}
	_ = json.Unmarshal(data, &st)
	return st
}

func (h *Hub) saveAntigravityLocal(st antigravityLocalState) error {
	data, _ := json.Marshal(st)
	path := filepath.Join(h.dir, antigravityLocalFile)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// AntigravityLocalInjected 报告某 Antigravity app 变体(ide/standalone)是否本地自有号接管中。
func (h *Hub) AntigravityLocalInjected(variant string) bool {
	return h.loadAntigravityLocal().get(variant)
}

// SetAntigravityLocalInjected 独立开/关某变体的本地自有号注入接管:
//
//	on  = 挑一个自有号(优先号,否则第一个进池号)注入该 app 的 state.vscdb,直连官方、不经网关;
//	off = 撤销该 app 的注入登录态。
//
// 两个 app 互不影响(和远程那两行对称)。改动后若该 app 在跑则重启它以重读 state.vscdb。
func (h *Hub) SetAntigravityLocalInjected(variant string, on bool) error {
	v := normalizeAntigravityVariant(variant)
	st := h.loadAntigravityLocal()
	if on {
		tok, err := h.pickAntigravityToken()
		if err != nil {
			return err
		}
		if err := h.platform.AntigravityInjectAccountTo(v, tok); err != nil {
			return err
		}
	} else {
		_ = h.platform.AntigravityRestoreAccountFor(v)
	}
	st.set(v, on)
	if err := h.saveAntigravityLocal(st); err != nil {
		return err
	}
	h.restartAntigravityRunning(v)
	return nil
}

// restartAntigravityRunning 若某变体 app 在跑,停+起让它重读 state.vscdb;没跑则不动。
func (h *Hub) restartAntigravityRunning(variant string) {
	v := normalizeAntigravityVariant(variant)
	if h.platform.AntigravityAppRunning(v) {
		_ = h.platform.AntigravityAppStop(v)
		_ = h.platform.AntigravityAppStart(v)
	}
}

// restoreAntigravityAll 撤销两个变体 app 的注入登录态(未装的变体为 no-op)。
func (h *Hub) restoreAntigravityAll() {
	_ = h.platform.AntigravityRestoreAccountFor("ide")
	_ = h.platform.AntigravityRestoreAccountFor("standalone")
}

// reinjectAntigravityInjected 把当前号重注入到所有已处于本地接管态的 app(切当前号时同步)。
func (h *Hub) reinjectAntigravityInjected() {
	st := h.loadAntigravityLocal()
	if !st.anyInjected() {
		return
	}
	tok, err := h.pickAntigravityToken()
	if err != nil {
		return
	}
	if st.IDE {
		_ = h.platform.AntigravityInjectAccountTo("ide", tok)
	}
	if st.Standalone {
		_ = h.platform.AntigravityInjectAccountTo("standalone", tok)
	}
}
