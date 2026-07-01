package main

import (
	"fmt"
	"os/exec"
	goruntime "runtime"

	"bcai-wails/internal/local/codexsettings"

	runtime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// 「Codex 设置」面板 Wails 绑定 —— 薄薄委托给 hub(codexsettings 持久化 + config.toml 快捷配置)
// 与平台胶水(app 路径探测 / 选择 / 打开 config.toml)。前端 localApi 直接调这些。

func (a *App) LocalGetCodexSettings() codexsettings.Settings {
	if err := ensureLocal(); err != nil {
		return codexsettings.Settings{}
	}
	return localHub.GetCodexSettings()
}

func (a *App) LocalSaveCodexSettings(s codexsettings.Settings) (codexsettings.Settings, error) {
	if err := ensureLocal(); err != nil {
		return codexsettings.Settings{}, err
	}
	return localHub.SaveCodexSettings(s)
}

func (a *App) LocalGetCodexQuickConfig() (codexsettings.QuickConfig, error) {
	if err := ensureLocal(); err != nil {
		return codexsettings.QuickConfig{}, err
	}
	return localHub.GetCodexQuickConfig()
}

// LocalSaveCodexQuickConfig 写 ~/.codex/config.toml 的 model_context_window / model_auto_compact_token_limit。
// nil = 删该键(回到官方默认),非 nil = 写入该值。
func (a *App) LocalSaveCodexQuickConfig(modelContextWindow, autoCompactTokenLimit *int64) (codexsettings.QuickConfig, error) {
	if err := ensureLocal(); err != nil {
		return codexsettings.QuickConfig{}, err
	}
	return localHub.SaveCodexQuickConfig(modelContextWindow, autoCompactTokenLimit)
}

// LocalDetectCodexAppPath 自动探测本机 Codex 启动路径(为空表示未检测到)。
func (a *App) LocalDetectCodexAppPath() string {
	return detectCodexGUIPath()
}

// LocalBrowseForPath 弹原生文件选择框,返回所选路径(取消则空串)。
func (a *App) LocalBrowseForPath(title string) (string, error) {
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{Title: title})
}

// LocalOpenCodexConfigToml 用系统默认程序打开 ~/.codex/config.toml。
func (a *App) LocalOpenCodexConfigToml() error {
	if appActionsSuppressed() {
		return nil // go test 下绝不用本机默认程序打开文件
	}
	path := codexConfigPath()
	var cmd *exec.Cmd
	switch goruntime.GOOS {
	case "darwin":
		cmd = exec.Command("open", path)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("打开 config.toml 失败: %w", err)
	}
	return nil
}
