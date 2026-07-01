package hub

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/aghistory"
)

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

// Antigravity「默认实例」运行时控制 + 切号历史的薄委托。
//
// 运行时控制(start/stop/restart/focus/status)是平台专有动作(拉起/聚焦/停已装 IDE
// 进程),经 Platform 接口注入,实现在 package main(复用既有探测/启停)。
// 切号历史是 aghistory 自包含包(camelCase JSON 原子持久化、去重降序截断 200)。
//
// 红线:运行时只控制本机 IDE 进程,切号历史只读写本地 JSON,均与远程租号 / 网关出口无关。

// ── 默认实例运行时(对齐 cockpit runtime.*Default) ──

// AntigravityStartDefault 拉起 Antigravity 默认实例(已装 IDE)。
func (h *Hub) AntigravityStartDefault() error { return h.platform.AntigravityStartDefault() }

// AntigravityStopDefault 停掉 Antigravity 默认实例进程。
func (h *Hub) AntigravityStopDefault() error { return h.platform.AntigravityStopDefault() }

// AntigravityRestartDefault 先停后起(对齐 cockpit:stop 失败也继续 start)。
func (h *Hub) AntigravityRestartDefault() error {
	_ = h.platform.AntigravityStopDefault()
	return h.platform.AntigravityStartDefault()
}

// AntigravityFocusDefault 把 Antigravity 默认实例窗口带到前台。
func (h *Hub) AntigravityFocusDefault() error { return h.platform.AntigravityFocusDefault() }

// AntigravityRuntimeStatus 返回默认实例是否在运行。
func (h *Hub) AntigravityRuntimeStatus() bool { return h.platform.AntigravityRuntimeRunning() }

// ── 变体化运行时:IDE 与独立版 Antigravity 各自可检测/启停/聚焦(variant="ide"/"standalone") ──

// AntigravityAppView 是某 Antigravity app 变体的运行时视图(前端渲染两张卡用)。
type AntigravityAppView struct {
	Variant  string `json:"variant"`  // "ide" | "standalone"
	Name     string `json:"name"`     // 展示名
	Detected bool   `json:"detected"` // 是否检测到安装
	Running  bool   `json:"running"`  // 是否在运行
}

// AntigravityApps 返回两个变体的运行时视图(供前端同时展示 IDE + 独立版)。
func (h *Hub) AntigravityApps() []AntigravityAppView {
	return []AntigravityAppView{
		{Variant: "ide", Name: "Antigravity IDE",
			Detected: h.platform.AntigravityAppDetected("ide"), Running: h.platform.AntigravityAppRunning("ide")},
		{Variant: "standalone", Name: "Antigravity",
			Detected: h.platform.AntigravityAppDetected("standalone"), Running: h.platform.AntigravityAppRunning("standalone")},
	}
}

// AntigravityAppStart/Stop/Restart/Focus 按变体控制对应 app。
func (h *Hub) AntigravityAppStart(variant string) error {
	return h.platform.AntigravityAppStart(variant)
}
func (h *Hub) AntigravityAppStop(variant string) error { return h.platform.AntigravityAppStop(variant) }
func (h *Hub) AntigravityAppRestart(variant string) error {
	_ = h.platform.AntigravityAppStop(variant)
	return h.platform.AntigravityAppStart(variant)
}
func (h *Hub) AntigravityAppFocus(variant string) error {
	return h.platform.AntigravityAppFocus(variant)
}

// ── 切号历史(对齐 cockpit antigravity_switch_history) ──

// AntigravitySwitchHistory 返回切号历史(降序;缺省/损坏返回空切片)。
func (h *Hub) AntigravitySwitchHistory() ([]aghistory.SwitchHistoryItem, error) {
	return h.agHistory.Load()
}

// AddAntigravitySwitchHistory 追加一条切号历史(按 id 去重、按 timestamp 降序、截断 200)。
func (h *Hub) AddAntigravitySwitchHistory(item aghistory.SwitchHistoryItem) error {
	return h.agHistory.Add(item)
}

// ClearAntigravitySwitchHistory 清空切号历史。
func (h *Hub) ClearAntigravitySwitchHistory() error { return h.agHistory.Clear() }
