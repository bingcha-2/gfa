package hub

import "bcai-wails/internal/local/codexsettings"

// 「Codex 设置」面板的薄委托:本地设置落盘 + ~/.codex/config.toml 快捷配置读写。
// 红线:只读写本地 Codex 设置与 config.toml,与远程租号 / proxy.go / 网关出口无关。

// ── 设置面板持久化 ──

// GetCodexSettings 返回「Codex 设置」面板的全部持久化项(缺省回退默认)。
func (h *Hub) GetCodexSettings() codexsettings.Settings { return h.codexSettings.Load() }

// SaveCodexSettings 原子落盘设置,返回落盘后的值。
func (h *Hub) SaveCodexSettings(s codexsettings.Settings) (codexsettings.Settings, error) {
	if err := h.codexSettings.Save(s); err != nil {
		return codexsettings.Settings{}, err
	}
	return h.codexSettings.Load(), nil
}

// ── config.toml 快捷配置(model_context_window / model_auto_compact_token_limit) ──

// GetCodexQuickConfig 读 CodexHomeDir()/config.toml 的快捷配置。
func (h *Hub) GetCodexQuickConfig() (codexsettings.QuickConfig, error) {
	return codexsettings.LoadCurrentQuickConfig()
}

// SaveCodexQuickConfig 结构保留地改写 config.toml 两个顶层整数键(nil=删键),回读返回。
func (h *Hub) SaveCodexQuickConfig(modelContextWindow, autoCompactTokenLimit *int64) (codexsettings.QuickConfig, error) {
	return codexsettings.SaveCurrentQuickConfig(modelContextWindow, autoCompactTokenLimit)
}
