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
	var tok AntigravityToken
	if on {
		var err error
		if tok, err = h.pickAntigravityToken(); err != nil {
			return err
		}
	}
	if err := h.mutateAntigravityState(v, func() error {
		if on {
			return h.platform.AntigravityInjectAccountTo(v, tok)
		}
		_ = h.platform.AntigravityRestoreAccountFor(v)
		return nil
	}); err != nil {
		return err
	}
	st.set(v, on)
	return h.saveAntigravityLocal(st)
}

// mutateAntigravityState 对某变体的 state.vscdb 做变更(注入/还原),并保证「先停 → 再写 → 后起」:
// VS Code/Electron 把全局状态存内存,优雅退出会回写 state.vscdb —— 若边跑边写,退出回写会
// 冲掉我们刚写入的登录态(接管不生效的根因)。app 没在跑则直接写,下次启动自然读到。
func (h *Hub) mutateAntigravityState(variant string, mutate func() error) error {
	v := normalizeAntigravityVariant(variant)
	wasRunning := h.platform.AntigravityAppRunning(v)
	if wasRunning {
		_ = h.platform.AntigravityAppStop(v)
	}
	err := mutate()
	if wasRunning {
		_ = h.platform.AntigravityAppStart(v)
	}
	return err
}

// restoreAntigravityAll 撤销两个变体 app 的注入登录态(先停后清再起,未装的变体为 no-op)。
func (h *Hub) restoreAntigravityAll() {
	for _, v := range []string{"ide", "standalone"} {
		variant := v
		_ = h.mutateAntigravityState(variant, func() error {
			return h.platform.AntigravityRestoreAccountFor(variant)
		})
	}
}

// reinjectAntigravityInjected 把当前号重注入到所有已处于本地接管态的 app(切当前号时同步)。
// 每个变体走「先停 → 再写 → 后起」:IDE/独立版仅在启动时读一次 state.vscdb,不重启则
// 正在跑的窗口一直抱旧号,且边跑边写会被退出回写冲掉 —— 用户视角「切了没生效」。
func (h *Hub) reinjectAntigravityInjected() {
	st := h.loadAntigravityLocal()
	if !st.anyInjected() {
		return
	}
	tok, err := h.pickAntigravityToken()
	if err != nil {
		return
	}
	for _, v := range []string{"ide", "standalone"} {
		if !st.get(v) {
			continue
		}
		variant := v
		_ = h.mutateAntigravityState(variant, func() error {
			return h.platform.AntigravityInjectAccountTo(variant, tok)
		})
	}
}
