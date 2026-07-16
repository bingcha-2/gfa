package main

import (
	"fmt"
	"os/exec"
	goruntime "runtime"
	"time"
)

// 「Codex 皮肤调试通道」Wails 绑定 —— 冰茶只管通道(开关/重启/发现文件),
// 皮肤设计与注入由用户自己的 Agent 按 skill 完成,见 codex_skin_channel.go 顶部说明。

// CodexSkinChannelStatus 是设置卡的完整状态视图。
//   - Enabled:开关(持久化在 Codex 设置)。
//   - Live:Codex 当前是否带调试端口在跑(探测 /json/version)。
//     四象限对应 UI:开+活=生效;开+死=等重启;关+活=重启后关闭;关+死=未开启。
type CodexSkinChannelStatus struct {
	Enabled  bool   `json:"enabled"`
	Live     bool   `json:"live"`
	Port     int    `json:"port"`
	SkillDir string `json:"skillDir"`
}

func codexSkinChannelStatus() CodexSkinChannelStatus {
	return CodexSkinChannelStatus{
		Enabled:  codexSkinChannelEnabled(),
		Live:     probeCodexSkinChannel(),
		Port:     codexSkinChannelPort,
		SkillDir: codexSkinSkillDir(),
	}
}

// LocalGetCodexSkinChannel 返回通道状态;顺带保证 skill 目录已落盘
// (skill 路径常驻可见,与通道状态无关)。
func (a *App) LocalGetCodexSkinChannel() CodexSkinChannelStatus {
	ensureCodexSkinSkillMaterialized()
	return codexSkinChannelStatus()
}

// LocalSetCodexSkinChannel 落盘开关 + 刷新 state.json + 强制重落 skill 文件。
// 只改「下次启动」的行为:开/关都不动正在运行的 Codex,重启由用户显式触发。
func (a *App) LocalSetCodexSkinChannel(enabled bool) (CodexSkinChannelStatus, error) {
	if err := ensureLocal(); err != nil {
		return CodexSkinChannelStatus{}, err
	}
	s := localHub.GetCodexSettings()
	s.SkinChannelEnabled = enabled
	if _, err := localHub.SaveCodexSettings(s); err != nil {
		return CodexSkinChannelStatus{}, err
	}
	if err := writeCodexSkinState(enabled); err != nil {
		return CodexSkinChannelStatus{}, fmt.Errorf("写 state.json 失败: %w", err)
	}
	if err := materializeCodexSkinSkill(); err != nil {
		Log("[codex-skin] skill 落盘失败(不致命): %v", err)
	}
	return codexSkinChannelStatus(), nil
}

// LocalRestartCodexForSkinChannel 重启 Codex 使通道参数生效(开→带端口;关→去端口)。
// 同步阻塞直到探测结果与开关一致或超时(前端按钮转圈);超时不算错,返回实际状态由 UI 呈现。
func (a *App) LocalRestartCodexForSkinChannel() CodexSkinChannelStatus {
	if appActionsSuppressed() {
		return codexSkinChannelStatus() // go test 下绝不重启本机 Codex
	}
	QuitCodexApp()
	LaunchCodexApp()
	want := codexSkinChannelEnabled()
	// Codex 冷启动到 CDP 端口就绪可能超过 15s;超时也不算错(前端会继续轮询翻转状态)。
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if probeCodexSkinChannel() == want {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	return codexSkinChannelStatus()
}

// LocalOpenCodexSkinSkillFolder 在系统文件管理器中打开 skill 目录。
func (a *App) LocalOpenCodexSkinSkillFolder() error {
	ensureCodexSkinSkillMaterialized()
	if appActionsSuppressed() {
		return nil // go test 下绝不打开本机文件管理器
	}
	dir := codexSkinSkillDir()
	var cmd *exec.Cmd
	switch goruntime.GOOS {
	case "darwin":
		cmd = exec.Command("open", dir)
	case "windows":
		cmd = exec.Command("explorer", dir)
	default:
		cmd = exec.Command("xdg-open", dir)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("打开 skill 目录失败: %w", err)
	}
	return nil
}
