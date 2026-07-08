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

// ─── 沙箱模式接管 · 触机器 + target 层 ─────────────────────────────────────────
//
// 纯函数在 sandbox_kit.go。这里放落盘(GenerateKit)、触机器动作(DetectSbx /
// ApplyPolicy / InstallSbx,均过 appActionsSuppressed() 短路)、以及接管中心注册表
// 的 claudeSandboxTarget。冰茶只准备,交互式 sbx run 由用户在自己终端跑。

// SbxStatus sbx 安装状态,供卡片展示。
type SbxStatus struct {
	Installed   bool   `json:"installed"`
	Version     string `json:"version"`
	KvmOK       bool   `json:"kvmOK"`       // 仅 Linux 有意义
	Unsupported bool   `json:"unsupported"` // 平台/硬件硬性不支持(如 Intel Mac),Note 说明原因
	Note        string `json:"note"`
}

// sandboxKitDir 返回 kit 的固定落盘路径(<用户配置目录>/bcai/sandbox/gfa-claude)。
func sandboxKitDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "bcai", "sandbox", "gfa-claude"), nil
}

// generateKitInto 把 spec.yaml 写进 dir(sbx kit 要求文件名 spec.yaml)。纯 IO,便于 temp 目录测试。
func generateKitInto(dir string, o KitOptions) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "spec.yaml"), []byte(kitSpecYAML(o)), 0o644)
}

// GenerateKit 用默认落盘路径生成 kit,返回 kit 目录。
func GenerateKit(o KitOptions) (string, error) {
	dir, err := sandboxKitDir()
	if err != nil {
		return "", err
	}
	if err := generateKitInto(dir, o); err != nil {
		return "", fmt.Errorf("生成 kit 失败: %w", err)
	}
	return dir, nil
}

// resolveSbxPath 找 sbx 可执行文件的绝对路径(空=没装)。
// 关键:macOS/Linux 的 GUI 进程 PATH 常只有 /usr/bin:/bin,不含 brew 目录
// (/opt/homebrew/bin、/usr/local/bin),LookPath 会漏判「已装却找不到」。故 LookPath 失败后
// 再探常见安装位置。之后所有 exec sbx 都走这个绝对路径,而非裸 "sbx" 依赖 PATH。
func resolveSbxPath() string {
	if p, err := exec.LookPath("sbx"); err == nil {
		return p
	}
	for _, p := range []string{"/opt/homebrew/bin/sbx", "/usr/local/bin/sbx", "/usr/bin/sbx"} {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}
	// Windows:MSI 装后往 PATH 加了 sbx,但运行中的冰茶进程 env 是旧的,LookPath 会漏判「已装却找不到」。
	// 探常见安装目录兜底;仍找不到时可靠路子是重启冰茶让 PATH 刷新。确切安装目录待真机核对。
	if runtime.GOOS == "windows" {
		for _, base := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA")} {
			if base == "" {
				continue
			}
			for _, sub := range []string{`Docker\sbx\sbx.exe`, `Docker Sandboxes\sbx.exe`, `sbx\sbx.exe`} {
				p := filepath.Join(base, sub)
				if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
					return p
				}
			}
		}
	}
	return ""
}

// currentInstallCommandString 当前平台的 sbx 安装命令(展示给用户复制,作 InstallSbx 的兜底)。
func currentInstallCommandString() string { return installSbxCommandString(runtime.GOOS) }

// macIsAppleSilicon 判断是否 Apple 芯片(sbx 只支持 M 系列;Intel Mac 不支持)。
// 用 sysctl hw.optional.arm64:即使本进程在 Rosetta 下(GOARCH=amd64),它仍如实报硬件。
func macIsAppleSilicon() bool {
	out, err := exec.Command("sysctl", "-n", "hw.optional.arm64").Output()
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(out)) == "1"
}

// InstallSbx 一键装 sbx。抑制态短路。
// macOS/Linux:开系统终端跑 brew/apt(常要 sudo / 先装 Xcode CLT,需交互,且登录 shell 有完整 PATH)。
// Windows:走 Go 直下 MSI(installSbxWindowsMSI),不依赖 winget(目标机常没有)。
// 返回 error → 前端回退到「复制命令自己装」。
func InstallSbx() error {
	if appActionsSuppressed() {
		return nil
	}
	if runtime.GOOS == "windows" {
		return installSbxWindowsMSI()
	}
	cmd := installSbxCommandString(runtime.GOOS)
	if cmd == "" {
		return fmt.Errorf("当前平台不支持一键安装 sbx")
	}
	return openTerminalRunning(cmd)
}

// sbxInstallPS1Bytes 生成沙箱安装脚本的字节流。开头必写 UTF-8 BOM(\ufeff→EF BB BF):
// Windows PowerShell 5.1 读 -File 脚本时,无 BOM 就按系统 ANSI 代码页(中文机=GBK/936)解码,
// 会把下面 Write-Host 里的中文乱码化,且错位的多字节还会吞掉收尾单引号 → 报「字符串缺少终止符: '」
// 直接解析失败(点安装秒报错)。加 BOM 让它认出 UTF-8。抽成纯函数便于测试锁死 BOM。
func sbxInstallPS1Bytes() []byte {
	script := "$ErrorActionPreference='Stop'\r\n" +
		"$m = \"$env:TEMP\\DockerSandboxes.msi\"\r\n" +
		"Write-Host '[冰茶] 正在下载 sbx 安装包...'\r\n" +
		"Invoke-WebRequest '" + sbxWindowsMsiURL + "' -OutFile $m\r\n" +
		"Write-Host '[冰茶] 正在安装 sbx...'\r\n" +
		"Start-Process msiexec -ArgumentList '/i',$m,'/qb' -Wait\r\n" +
		"Write-Host '[冰茶] sbx 安装完成。请重启冰茶客户端以识别 sbx,然后点「打开终端登录」。'\r\n"
	return []byte("\ufeff" + script)
}

// installSbxWindowsMSI 提权运行一段 PowerShell:下载官方 MSI + msiexec 静默安装(不依赖 winget)。
// 为什么落 .ps1 文件再跑,而非直接 exec msiexec 或 cmd/start 拼命令:
//
//	① MSI 装 Program Files 需管理员 → -Verb RunAs 弹一次 UAC 提权;
//	② 下载 URL + 变量 + 引号若经 `cmd /c start powershell -Command "…"` 传递,会被 start/cmd 二次解析
//	   拆坏 →「窗口一闪就没」正是这个引号地狱;把脚本落文件、-File 跑,彻底规避。
//
// 装完 sbx 的 PATH 更新不会回灌到运行中的冰茶进程,故提示用户重启冰茶再识别(见前端文案)。
func installSbxWindowsMSI() error {
	path := filepath.Join(os.TempDir(), "bcai-install-sbx.ps1")
	if err := os.WriteFile(path, sbxInstallPS1Bytes(), 0o644); err != nil {
		return fmt.Errorf("写安装脚本失败: %w", err)
	}
	// 提权开 PowerShell 跑脚本(-NoExit 留窗口看结果);脚本内 msiexec 因父进程已提权,不再二次弹 UAC。
	// hideCmd:藏掉这个「发起提权」的 launcher 自身的黑框(本进程是 GUI Wails app);真正干活的
	// 是它 Start-Process 起的那个提权 PowerShell,自带可见窗口,不受影响。
	inner := fmt.Sprintf("Start-Process powershell -Verb RunAs -ArgumentList '-NoExit','-ExecutionPolicy','Bypass','-File','%s'", path)
	return hideCmd("powershell", "-NoProfile", "-Command", inner).Start()
}

// openTerminalRunning 打开系统终端并在其中运行 shellCmd(可见、可交互)。
func openTerminalRunning(shellCmd string) error {
	switch runtime.GOOS {
	case "darwin":
		script := fmt.Sprintf("tell application \"Terminal\"\n\tactivate\n\tdo script %q\nend tell", shellCmd)
		return exec.Command("osascript", "-e", script).Start()
	case "windows":
		// 新开 PowerShell 窗口跑命令;-NoExit 保留窗口看结果。这里【不能】用 hideCmd:
		// 本函数在 Windows 上只被 SbxLogin 用(sbx login 走浏览器/设备码交互授权),窗口必须可见;
		// 且 `start` 是 cmd 内建,另开的新控制台会继承 cmd 的 SW_HIDE,一 hide 连登录窗一起藏掉。
		// 代价只是 cmd launcher 一闪(瞬时即退),可接受。
		return exec.Command("cmd", "/c", "start", "powershell", "-NoExit", "-Command", shellCmd).Start()
	case "linux":
		for _, term := range []string{"x-terminal-emulator", "gnome-terminal", "konsole", "xterm"} {
			if p, err := exec.LookPath(term); err == nil {
				return exec.Command(p, "-e", "bash", "-lc", shellCmd+"; exec bash").Start()
			}
		}
		return fmt.Errorf("未找到终端模拟器")
	default:
		return fmt.Errorf("unsupported platform")
	}
}

// DetectSbx 检测 sbx 是否可用。抑制态(go test)直接返回未装,不 exec。
func DetectSbx() SbxStatus {
	if appActionsSuppressed() {
		return SbxStatus{}
	}
	// Intel Mac 硬性不支持:sbx 只跑在 Apple 芯片上。早退,卡片直接显示不可用。
	if runtime.GOOS == "darwin" && !macIsAppleSilicon() {
		return SbxStatus{Unsupported: true, Note: "sbx 需要 Apple 芯片(M 系列),此 Intel Mac 不支持沙箱模式"}
	}
	// Windows 硬前提:sbx 官方只支持 Win11(非 Server)。Win10 / Windows Server 装了也起不了 microVM,
	// 故在「安装」之前就当硬性不支持拦下,别让用户装完 sbx、到 sbx run 那步才炸。fail-open:查不到不拦。
	if runtime.GOOS == "windows" {
		if ok, osName := windowsSupportsSbx(); !ok {
			return SbxStatus{Unsupported: true, Note: "沙箱需要 Windows 11(当前:" + osName + ");sbx 不支持 Windows 10 / Windows Server,请换 Win11 机器"}
		}
	}
	path := resolveSbxPath()
	if path == "" {
		return SbxStatus{Installed: false, Note: "未检测到 sbx"}
	}
	out, _ := hideCmd(path, "version").Output()
	st := SbxStatus{Installed: true, Version: string(out)}
	if runtime.GOOS == "linux" {
		if _, err := os.Stat("/dev/kvm"); err == nil {
			st.KvmOK = true
		} else {
			st.Note = "缺少 /dev/kvm:Linux 需裸机 + KVM(虚拟机内不可用)"
		}
	}
	return st
}

// ApplyPolicy 放行宿主网关端口。抑制态短路;sbx 找不到则报错(前端会提示先装)。
func ApplyPolicy(gatewayPort int) error {
	if appActionsSuppressed() {
		return nil
	}
	sbx := resolveSbxPath()
	if sbx == "" {
		return fmt.Errorf("未找到 sbx,请先安装 Docker sbx")
	}
	// 全局网络策略需先初始化,否则 allow 报「status 412: global network policy has not been
	// initialized」。balanced = 默认拒绝 + 放行常见开发站点(兼顾隔离与 Claude Code 用 git/npm)。
	// 已初始化则此步报错,忽略——由下面的 allow 决定成败。
	_ = hideCmd(sbx, "policy", "init", "balanced").Run()
	// 捕获 sbx 真实输出:policy 失败(exit 1)时把它的报错透出来,而不是笼统「失败」。
	out, err := hideCmd(sbx, policyAllowArgs(fmt.Sprintf("localhost:%d", gatewayPort))...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("sbx policy 失败: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// ── 托管沙箱名单(真查 sbx ls --json,支持多项目)──────────────────────────────
// 直接问 sbx 真实存在哪些沙箱(sbx ls --json:含 name/status/workspaces),只认 gfa- 前缀 =
// 冰茶托管的。列表 = 真实状态,而非「冰茶以为你配过啥」;绝不列/管用户自己 sbx run 起的沙箱。

// SandboxInfo 统一列表一行:CLI 与 VSCode 沙箱合到一处,靠 Source 标签区分。
type SandboxInfo struct {
	Name      string `json:"name"`      // 原始 gfa-... 名(停止/进入用)
	Label     string `json:"label"`     // 可读名(优先工作区目录名)
	Source    string `json:"source"`    // "cli" | "vscode" | "other"
	Status    string `json:"status"`    // running | stopped | ""(查不到)
	Workspace string `json:"workspace"` // 首个挂载工作区完整路径(空=无)
}

// listManagedSandboxes 返回真实存在的、冰茶托管(gfa- 前缀)的沙箱(含状态/工作区)。
// 抑制态(go test)/ 未装 sbx / 查询失败 → 空。
func listManagedSandboxes() []SandboxInfo {
	if appActionsSuppressed() {
		return nil
	}
	sbx := resolveSbxPath()
	if sbx == "" {
		return nil
	}
	out, err := hideCmd(sbx, "ls", "--json").Output()
	if err != nil {
		return nil
	}
	var payload struct {
		Sandboxes []struct {
			Name       string   `json:"name"`
			Status     string   `json:"status"`
			Workspaces []string `json:"workspaces"`
		} `json:"sandboxes"`
	}
	if json.Unmarshal(out, &payload) != nil {
		return nil
	}
	var infos []SandboxInfo
	for _, s := range payload.Sandboxes {
		if !isGfaManagedSandbox(s.Name) {
			continue
		}
		ws := ""
		if len(s.Workspaces) > 0 {
			ws = s.Workspaces[0]
		}
		infos = append(infos, SandboxInfo{
			Name: s.Name, Label: sandboxLabel(s.Name, ws),
			Source: sandboxSource(s.Name), Status: s.Status, Workspace: ws,
		})
	}
	return infos
}

// listManagedNames 只取托管沙箱名(Restore 全停时用)。
func listManagedNames() []string {
	infos := listManagedSandboxes()
	names := make([]string, 0, len(infos))
	for _, i := range infos {
		names = append(names, i.Name)
	}
	return names
}

// createSandbox 后台建 box(sbx create,不进入)。box 建完是 stopped,进入靠 enterCommandString 的
// sbx run --name。首次会拉 kit 镜像(慢),故此调用可能阻塞;交互式进入才需 TTY,建 box 不需要。
// 抑制态短路;sbx 找不到则报错。
func createSandbox(name, kitDir string, mounts []SandboxMount) error {
	if appActionsSuppressed() {
		return nil
	}
	sbx := resolveSbxPath()
	if sbx == "" {
		return fmt.Errorf("未找到 sbx,请先安装 Docker sbx")
	}
	out, err := hideCmd(sbx, createCommandArgs(name, kitDir, mounts)...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("sbx create 失败: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// stopSandbox 停止并移除一个沙箱。安全线:只动 gfa-claude- 前缀(冰茶托管)的,
// 绝不碰用户自己 sbx run 起的沙箱。抑制态短路。
// 注:sbx rm 的确切 flag(是否需先 stop / -f)待 Phase 0 真机确认后微调。
func stopSandbox(name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil
	}
	if !isGfaManagedSandbox(name) {
		return fmt.Errorf("拒绝停止非冰茶托管的沙箱: %s", name)
	}
	if appActionsSuppressed() {
		return nil
	}
	sbx := resolveSbxPath()
	if sbx == "" {
		return nil // sbx 都没了,自然也没托管沙箱可停
	}
	// --force:跳过确认(非交互,无 stdin 会报 "stdin is not a terminal")。sbx rm 会先停后删,
	// 一条搞定,无需另跑 sbx stop。捕获输出:区分「没这个沙箱(无害)」还是别的原因。
	out, err := hideCmd(sbx, "rm", "--force", name).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// revokeSandbox 删 kit 目录 + 撤 policy(抑制态只删目录不 exec)。
func revokeSandbox(gatewayPort int) error {
	if dir, err := sandboxKitDir(); err == nil {
		_ = os.RemoveAll(dir)
	}
	if appActionsSuppressed() {
		return nil
	}
	// 撤 policy 尽力而为:sbx 未装 / policy 本就不存在都不该让「移除」报错(kit 已删才是关键)。
	sbx := resolveSbxPath()
	if sbx == "" {
		return nil
	}
	if err := hideCmd(sbx, "policy", "deny", "network", fmt.Sprintf("localhost:%d", gatewayPort)).Run(); err != nil {
		Log("[sandbox] 撤销 policy 失败(不阻塞移除): %v", err)
	}
	return nil
}

// ── 接管中心注册表目标 ──────────────────────────────────────────────────────
//
// claudeSandboxTarget 沙箱模式接管目标。Inject=生成默认 kit + 放行 policy;
// Restore=撤 policy + 删 kit。带挂载/时区的富流程走 local_bindings_sandbox.go。

type claudeSandboxTarget struct{}

func (claudeSandboxTarget) Key() string           { return "claude_sandbox" }
func (claudeSandboxTarget) ProductID() string     { return "claude_sandbox" }
func (claudeSandboxTarget) Name() string          { return "Claude Code · 沙箱模式" }
func (claudeSandboxTarget) InjectionType() string { return "sandbox" }

func (claudeSandboxTarget) DetectPath() string {
	return resolveSbxPath()
}

func (claudeSandboxTarget) IsInjected(_ int) bool {
	dir, err := sandboxKitDir()
	if err != nil {
		return false
	}
	_, err = os.Stat(filepath.Join(dir, "spec.yaml"))
	return err == nil
}

func (claudeSandboxTarget) Inject(proxyPort int) (string, error) {
	if _, err := GenerateKit(defaultKitOptions(proxyPort)); err != nil {
		return "", err
	}
	if err := ApplyPolicy(proxyPort); err != nil {
		return "", fmt.Errorf("放行网关端口失败: %w", err)
	}
	return "沙箱模式: ✓ 已配置,复制命令到终端运行 sbx run", nil
}

func (claudeSandboxTarget) Restore() (string, error) {
	// 全局关闭:停掉所有冰茶托管的沙箱(会终止用户正在跑的会话),再撤 policy + 删 kit
	// (删 kit 目录连带清空 .sandboxes 名单)。
	names := listManagedNames()
	for _, n := range names {
		if err := stopSandbox(n); err != nil {
			Log("[sandbox] 停止沙箱 %s 失败(不阻塞移除): %v", n, err)
		}
	}
	if err := revokeSandbox(effectiveProxyPort()); err != nil {
		return "", err
	}
	msg := "沙箱模式: ✓ 已撤销放行、移除 kit"
	if len(names) > 0 {
		msg += fmt.Sprintf(",并停止 %d 个沙箱", len(names))
	}
	return msg, nil
}
