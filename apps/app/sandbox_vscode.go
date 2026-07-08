package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// bypassEditorLoginGate 把认证 env 塞进 GUI 编辑器进程,否则从 Dock 启动的编辑器继承不到
// shell env,扩展面板会一直弹登录页(实测:settings.json 那套只对 CLI 有效,面板认进程 env)。
// macOS 用 launchctl setenv(对之后启动的 GUI app 生效,故需重启编辑器)。抑制态短路。
func bypassEditorLoginGate(proxyPort int) {
	if appActionsSuppressed() || runtime.GOOS != "darwin" {
		return // TODO: Linux/Windows 的 GUI 进程 env 注入
	}
	_ = exec.Command("launchctl", "setenv", "ANTHROPIC_AUTH_TOKEN", sandboxSentinelToken).Run()
	_ = exec.Command("launchctl", "setenv", "ANTHROPIC_BASE_URL", fmt.Sprintf("http://127.0.0.1:%d", proxyPort)).Run()
}

func clearEditorLoginGate() {
	if appActionsSuppressed() || runtime.GOOS != "darwin" {
		return
	}
	_ = exec.Command("launchctl", "unsetenv", "ANTHROPIC_AUTH_TOKEN").Run()
	_ = exec.Command("launchctl", "unsetenv", "ANTHROPIC_BASE_URL").Run()
}

// ─── 第 7 接管目标:VSCode 扩展沙箱模式(Phase 1,stdio-only)───────────────────
//
// 机制:官方设置 claudeCode.claudeProcessWrapper —— 扩展启动 claude 时调
//   <wrapper> [内置claude路径] <参数...>,把 wrapper 指向冰茶脚本即可透明重定向进沙箱。
// 无需 fork 扩展 / hack PATH / patch。
//
// Phase 1 只走 stdio(基础对话 + 读写文件);IDE MCP 富功能(native diff / @-mention)
// 属可选增强(官方文档:IDE 集成可选,连不上降级为纯 CLI),留 Phase 2 桥接。
//
// 【未真机验证,待 Phase 0】:①wrapper 收到的确切 argv + sbx run 的 stdio 是否干净透传;
//   ②claude 连不上宿主 IDE server 时是顺畅降级还是卡住;③沙箱内 claude 版本与扩展协议兼容性。

// vscodeWrapperPath wrapper 脚本落盘路径(~/.bcai/claude-in-sbx.sh)。
func vscodeWrapperPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".bcai", "claude-in-sbx.sh")
}

// vscodeWrapperScript 生成 claudeProcessWrapper 脚本。sbxPath/kitDir 在生成时烧成绝对路径:
// VSCode(GUI 进程)的 PATH 常不含 brew 目录,裸 `sbx` 会找不到,故用绝对路径。
// per-workspace:按 cwd 哈希命名沙箱(gfa-vscode-<6位>),不同工作区各自独立、不撞车。
//
// 真机(v0.34.0)定案:扩展经 Claude Code SDK 以 **headless stream-json over stdio** 启动 claude,
// 不是交互 TUI。故必须用 `sbx exec -i`(docker-exec 语义,干净管道)透传 stdio;绝不能用 `sbx run`——
// 它分配 PTY 且把 "Creating/Starting agent" 状态打到 stdout,污染 SDK 读的 JSON 流 → agent exit 1。
// 实测 `sbx exec -i box claude --input-format stream-json --output-format stream-json` 吐纯净 stream-json。
//
// 权限:真机抓到 SDK 传 `--permission-prompt-tool stdio`(权限确认走 **stdio control 协议**,非宿主 MCP 端口),
// 这条链能穿过 sbx exec → 权限框正常在面板弹。故有它时**原样透传**,让 stdio 权限流照常工作。
// 仅当 argv 里没有 --permission-prompt-tool(理论边角)才注入 --dangerously-skip-permissions 兜底
// (沙箱本身即隔离边界,YOLO 相对安全);且二者互斥,有 prompt-tool 时绝不能加,否则 claude 报错。
func vscodeWrapperScript(sbxPath, kitDir string) string {
	return fmt.Sprintf(`#!/bin/sh
# 冰茶 VSCode 沙箱 wrapper —— 扩展经 SDK(headless stream-json over stdio)启动 claude,用 sbx exec 干净透传进沙箱。
BUNDLED="$1"
[ -f "$1" ] && shift            # 内置 claude 路径是宿主二进制,进不了 Linux 沙箱,丢弃
# auth/mcp/version 等轻量子命令直接在宿主跑内置 claude(靠 env token 认证),不进沙箱。
case "$1" in
  auth|mcp|setup-token|config|doctor|--version|-v|update|install) exec "$BUNDLED" "$@" ;;
esac
export SBX_NO_TELEMETRY=1
SBX=%q
KIT=%q
NAME="gfa-vscode-$(printf %%s "$PWD" | shasum | cut -c1-6)"   # 每工作区一个沙箱
# 惰性建 box:扩展会并发 spawn 多个 claude(会话+登录检查),裸并发 create 会 409
# "has a create in progress"。故抢建(失败/409 无害,吞掉),再轮询等 box 就绪(首次拉镜像慢,给足 ~10min)。
if ! "$SBX" ls -q 2>/dev/null | grep -qx "$NAME"; then
  "$SBX" create --name "$NAME" --kit "$KIT" claude "$PWD" >/dev/null 2>&1
  i=0; while [ $i -lt 600 ]; do "$SBX" ls -q 2>/dev/null | grep -qx "$NAME" && break; sleep 1; i=$((i+1)); done
fi
# exec -i 干净 stdio 进沙箱:claude 参数原样透传;sbx 启动 banner 走 stderr,不碰 SDK 读的 stdout。
# SDK 带 --permission-prompt-tool stdio(权限走 stdio control 协议,能穿 exec 在面板弹)→ 原样透传;
# 没有它(边角)才注入 --dangerously-skip-permissions 兜底(沙箱已隔离)。二者互斥,有它时绝不加。
case " $* " in
  *" --permission-prompt-tool "*) exec "$SBX" exec -i -w "$PWD" "$NAME" claude "$@" ;;
  *) exec "$SBX" exec -i -w "$PWD" "$NAME" claude "$@" --dangerously-skip-permissions ;;
esac
`, sbxPath, kitDir)
}

// VSCode 家族:VSCode 及其 fork(Cursor / Antigravity IDE / VSCodium / Windsurf / Insiders)
// 都能装 Claude Code 扩展。{显示名, Application Support 下的目录名}。
var vscodeFamilyDirs = []struct{ Name, Dir string }{
	{"VSCode", "Code"},
	{"VSCode Insiders", "Code - Insiders"},
	{"Cursor", "Cursor"},
	{"Antigravity IDE", "Antigravity IDE"},
	{"VSCodium", "VSCodium"},
	{"Windsurf", "Windsurf"},
}

// vscodeConfigBase 编辑器用户配置根目录(按平台)。
func vscodeConfigBase() string {
	switch runtime.GOOS {
	case "darwin":
		home, _ := os.UserHomeDir()
		return filepath.Join(home, "Library", "Application Support")
	case "windows":
		return os.Getenv("APPDATA")
	default: // linux
		home, _ := os.UserHomeDir()
		return filepath.Join(home, ".config")
	}
}

type vscodeEditor struct {
	Name         string
	SettingsPath string
}

// vscodeFamilyEditors 全家族的 settings.json 路径(不管装没装)。
func vscodeFamilyEditors() []vscodeEditor {
	base := vscodeConfigBase()
	out := make([]vscodeEditor, 0, len(vscodeFamilyDirs))
	for _, e := range vscodeFamilyDirs {
		out = append(out, vscodeEditor{Name: e.Name, SettingsPath: filepath.Join(base, e.Dir, "User", "settings.json")})
	}
	return out
}

// detectedVscodeEditors 只返回装了的(User 配置目录存在)。
func detectedVscodeEditors() []vscodeEditor {
	var out []vscodeEditor
	for _, e := range vscodeFamilyEditors() {
		if _, err := os.Stat(filepath.Dir(e.SettingsPath)); err == nil {
			out = append(out, e)
		}
	}
	return out
}

const vscodeWrapperSettingKey = "claudeCode.claudeProcessWrapper"

// setVscodeWrapperSetting 把 claudeProcessWrapper 写进 settings.json(合并,保留其它设置)。
// 注:VSCode settings.json 允许注释(JSONC),含注释时标准 JSON 解析会失败 → 返回错误让用户知晓
//（Phase 0 待处理 JSONC 场景)。
func setVscodeWrapperSetting(path, wrapper string) error {
	m := map[string]json.RawMessage{}
	if b, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(b))) > 0 {
		if err := json.Unmarshal(b, &m); err != nil {
			return fmt.Errorf("settings.json 解析失败(可能含注释/JSONC,暂需手动加该设置): %w", err)
		}
	}
	v, _ := json.Marshal(wrapper)
	m[vscodeWrapperSettingKey] = v
	out, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, out, 0o644)
}

// clearVscodeWrapperSetting 从 settings.json 删掉 claudeProcessWrapper。文件不存在/无该键 → no-op。
func clearVscodeWrapperSetting(path string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	m := map[string]json.RawMessage{}
	if err := json.Unmarshal(b, &m); err != nil {
		return nil // 解析不了就不动它,避免破坏用户文件
	}
	if _, ok := m[vscodeWrapperSettingKey]; !ok {
		return nil
	}
	delete(m, vscodeWrapperSettingKey)
	out, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, out, 0o644)
}

// settingHasOurWrapper 单个 settings.json 里的 claudeProcessWrapper 是否 = 我们的脚本。
func settingHasOurWrapper(path string) bool {
	b, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	m := map[string]json.RawMessage{}
	if json.Unmarshal(b, &m) != nil {
		return false
	}
	raw, ok := m[vscodeWrapperSettingKey]
	if !ok {
		return false
	}
	var v string
	_ = json.Unmarshal(raw, &v)
	return v == vscodeWrapperPath()
}

// isVscodeSandboxInjected 任一装了的编辑器已注入我们的 wrapper 即视为已接管。
func isVscodeSandboxInjected() bool {
	for _, e := range detectedVscodeEditors() {
		if settingHasOurWrapper(e.SettingsPath) {
			return true
		}
	}
	return false
}

// vscodeSandboxSupportedOS 报某 OS 是否支持 VSCode 沙箱接管。抽 goos 形参便于测试。
// Windows 不支持:接管靠往 claudeProcessWrapper 写一个 #!/bin/sh 脚本(vscodeWrapperScript),
// 官方扩展启动 claude(含点「登录」时)会 spawn 这个脚本 —— 但 Windows 无法执行 .sh(非 PE 格式),
// 当场报 `spawn ...claude-in-sbx.sh EFTYPE`;且脚本内全是 POSIX 命令(shasum/case/exec…)。
// 要在 Windows 真正跑通需换 Windows 可 spawn 的 wrapper + 真机验证 sbx/Docker,属未做的 Phase。
// 在此之前 Windows 一律禁用接管、绝不注入 wrapper,避免把用户的 Claude 面板搞崩。
func vscodeSandboxSupportedOS(goos string) bool { return goos != "windows" }

// ── 接管中心注册表目标 ──────────────────────────────────────────────────────

type claudeVscodeSandboxTarget struct{}

func (claudeVscodeSandboxTarget) Key() string           { return "claude_vscode_sandbox" }
func (claudeVscodeSandboxTarget) ProductID() string     { return "claude_vscode_sandbox" }
func (claudeVscodeSandboxTarget) Name() string          { return "Claude Code · VSCode 沙箱模式" }
func (claudeVscodeSandboxTarget) InjectionType() string { return "vscode_sandbox" }

// DetectPath:任一 VSCode 家族编辑器装了即返回其配置目录。
func (claudeVscodeSandboxTarget) DetectPath() string {
	if eds := detectedVscodeEditors(); len(eds) > 0 {
		return filepath.Dir(eds[0].SettingsPath)
	}
	return ""
}

func (claudeVscodeSandboxTarget) IsInjected(_ int) bool { return isVscodeSandboxInjected() }

// VscodeSandboxStatus 供卡片展示。
type VscodeSandboxStatus struct {
	Editors      []string `json:"editors"`      // 检测到的 VSCode 家族编辑器名(VSCode/Cursor/Antigravity IDE…)
	SbxInstalled bool     `json:"sbxInstalled"` // sbx 已装(沙箱前置)
	Enabled      bool     `json:"enabled"`      // 任一编辑器已注入 wrapper
	Supported    bool     `json:"supported"`    // 当前 OS 是否支持接管(Windows=false,见 vscodeSandboxSupportedOS)
}

func vscodeSandboxStatus() VscodeSandboxStatus {
	if appActionsSuppressed() {
		return VscodeSandboxStatus{}
	}
	var names []string
	for _, e := range detectedVscodeEditors() {
		names = append(names, e.Name)
	}
	return VscodeSandboxStatus{
		Editors:      names,
		SbxInstalled: resolveSbxPath() != "",
		Enabled:      isVscodeSandboxInjected(),
		Supported:    vscodeSandboxSupportedOS(runtime.GOOS),
	}
}

// Inject:①确保 gfa-claude kit 存在 ②写 wrapper 脚本(可执行)③往【每个装了的】VSCode 家族
// 编辑器写 claudeProcessWrapper 设置。沙箱由 wrapper 在扩展下次启动 claude 时按工作区惰性建。
func (claudeVscodeSandboxTarget) Inject(proxyPort int) (string, error) {
	if appActionsSuppressed() {
		return "", nil
	}
	// Windows 直接拒绝、绝不注入 .sh wrapper:否则扩展点「登录」时 spawn 该脚本必 EFTYPE,把面板搞崩。
	if !vscodeSandboxSupportedOS(runtime.GOOS) {
		return "", fmt.Errorf("Windows 暂不支持 VSCode 沙箱接管:官方扩展无法执行冰茶的 /bin/sh wrapper(点登录会 spawn EFTYPE)。请改用「Claude Code · 沙箱模式」在终端里跑,或在 WSL 内使用")
	}
	sbx := resolveSbxPath()
	if sbx == "" {
		return "", fmt.Errorf("未找到 sbx,请先在「Claude Code · 沙箱模式」里安装")
	}
	eds := detectedVscodeEditors()
	if len(eds) == 0 {
		return "", fmt.Errorf("未检测到 VSCode 家族编辑器(VSCode/Cursor/Antigravity IDE/VSCodium/Windsurf)")
	}
	// 复用用户在「沙箱模式」卡里配好的 kit(kimi/网关/时区/挂载都在里面),不覆盖。
	// 没配过才生成默认(网关)。这样 VSCode 直接沿用客户端的模型配置。
	kitDir, err := sandboxKitDir()
	if err != nil {
		return "", err
	}
	if _, statErr := os.Stat(filepath.Join(kitDir, "spec.yaml")); statErr != nil {
		if kitDir, err = GenerateKit(defaultKitOptions(proxyPort)); err != nil {
			return "", err
		}
	}
	wp := vscodeWrapperPath()
	if err := os.MkdirAll(filepath.Dir(wp), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(wp, []byte(vscodeWrapperScript(sbx, kitDir)), 0o755); err != nil {
		return "", err
	}
	var done, failed []string
	for _, e := range eds {
		if err := setVscodeWrapperSetting(e.SettingsPath, wp); err != nil {
			failed = append(failed, e.Name)
			Log("[vscode-sandbox] 写 %s 设置失败: %v", e.Name, err)
		} else {
			done = append(done, e.Name)
		}
	}
	if len(done) == 0 {
		return "", fmt.Errorf("写入编辑器设置全部失败(可能含 JSONC 注释,需手动加): %s", strings.Join(failed, ", "))
	}
	// 关键:把认证 env 塞进 GUI 编辑器进程,绕过扩展面板登录门(实测面板认进程 env 而非 settings.json)。
	bypassEditorLoginGate(proxyPort)
	// 宿主 ~/.claude 也注入(供集成终端里的 CLI claude / auth status 走宿主 passthrough 时认证)。
	if err := InjectClaudeSettings(proxyPort); err != nil {
		Log("[vscode-sandbox] 宿主 ~/.claude 注入失败: %v", err)
	}
	msg := "VSCode 沙箱: ✓ 已接管 " + strings.Join(done, "、") + ",重开对应编辑器的 Claude 面板生效(首次会拉沙箱镜像)"
	if len(failed) > 0 {
		msg += ";失败:" + strings.Join(failed, "、") + "(可能含注释,需手动加)"
	}
	return msg, nil
}

func (claudeVscodeSandboxTarget) Restore() (string, error) {
	if appActionsSuppressed() {
		return "", nil
	}
	for _, e := range detectedVscodeEditors() {
		_ = clearVscodeWrapperSetting(e.SettingsPath)
	}
	_ = os.Remove(vscodeWrapperPath())
	clearEditorLoginGate()      // 撤销 launchctl 注入的认证 env
	_ = RestoreClaudeSettings() // 还原宿主 ~/.claude 注入
	return "VSCode 沙箱: ✓ 已恢复(重开 Claude 面板回到宿主直跑);沙箱可在「已托管沙箱」里停止", nil
}
