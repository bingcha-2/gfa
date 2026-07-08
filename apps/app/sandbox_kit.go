package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

// ─── 沙箱模式接管 · 纯函数层 ──────────────────────────────────────────────────
//
// 本文件只放无副作用的纯函数(kit YAML / settings.json / policy 参数 / 挂载参数 /
// run 命令拼装 / 安装命令 / 危险挂载判断 / 时区表),便于单测。触机器的动作(exec sbx /
// 装 sbx / 开终端 / 落盘)在 sandbox_takeover.go,并过 appActionsSuppressed() 短路。

const sandboxSentinelToken = "bcai-claude-proxy"

// sbxWindowsMsiURL 是 sbx 官方 Windows MSI 的稳定直链(GitHub latest/download 自动 302 到最新版)。
// 为什么不用 winget:目标 Windows 常没装 App Installer(精简版/LTSC/Server 默认都没有),winget 路子
// 会「窗口一闪就退、永远装不上」。官方文档明示可手动从 sbx-releases 直接下二进制,故改走 MSI 直下。
const sbxWindowsMsiURL = "https://github.com/docker/sbx-releases/releases/latest/download/DockerSandboxes.msi"

// installSbxCommandString 按平台返回给用户复制到终端安装 sbx 的命令(展示用 / 一键失败时的兜底)。
// 不由冰茶静默 exec:GUI 进程 PATH 常不含 brew 目录、装 brew 又慢又无反馈,交给用户终端更可靠。
// (Windows 例外:冰茶一键装走 Go 直下 MSI,见 installSbxWindowsMSI;这里的命令仅作复制兜底。)
func installSbxCommandString(goos string) string {
	switch goos {
	case "darwin":
		// 必须先 brew trust docker/tap:Homebrew 现要求信任第三方 tap,否则 install 报
		// 「Refusing to load cask ... from untrusted tap」。视频原始步骤即含此步。
		return "brew trust docker/tap && brew install docker/tap/sbx"
	case "windows":
		// 直下官方 MSI 再 msiexec 装(绕开 winget);-ArgumentList 数组式传参,避开嵌套引号。
		// 供用户复制到 PowerShell;msiexec 装 Program Files 会自行弹 UAC 提权。
		return `$m="$env:TEMP\DockerSandboxes.msi"; Invoke-WebRequest '` + sbxWindowsMsiURL +
			`' -OutFile $m; Start-Process msiexec -ArgumentList '/i',$m,'/qb' -Wait`
	case "linux":
		return "curl -fsSL https://get.docker.com | sudo REPO_ONLY=1 sh && sudo apt-get install -y docker-sbx"
	default:
		return ""
	}
}

// ── Windows 沙箱前置判定 · 纯函数(供 windowsPrereq / DetectSbx 单测)────────────────

// hypervisorStatus 由「WHP 功能状态」+「hypervisor 是否真在运行(Win32_ComputerSystem.HypervisorPresent)」
// 判三态,供卡片精确提示:
//
//	"ready"   功能已启用 且 hypervisor 已加载运行 → 可直接用
//	"pending" 已启用但未重启(EnablePending;或功能 Enabled 却尚未加载)→ 必须重启才生效
//	"off"     未启用(Disabled/未知)→ 需点一键启用
//
// 为何两信号合判:光看功能 State 分不清「刚点完启用待重启(EnablePending)」和「压根没启用(Disabled)」——
// 二者都不 ready 但给用户的提示天差地别;HypervisorPresent 直报 hypervisor 此刻跑没跑,是「能不能用」的真信号。
// 关键子串:"EnablePending" 小写去空格="enablepending",不含 "enabled"(enable 后是 p 非 d),故先判它。
func hypervisorStatus(featureState string, hypervisorPresent bool) string {
	s := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(featureState)), " ", "")
	switch {
	case hypervisorPresent && strings.Contains(s, "enabled"):
		return "ready"
	case strings.Contains(s, "enablepending"):
		return "pending" // 已启用,待重启
	case strings.Contains(s, "enabled"):
		return "pending" // 功能 Enabled 但 hypervisor 尚未加载 → 仍需重启(边界)
	default:
		return "off"
	}
}

// osSupportsSbx 判 Windows 是否满足 sbx 硬前提:Win11(build ≥ 22000)且非 Server SKU。
// Win10 / Windows Server 装了 sbx 也起不了 microVM(官方只支持 Win11),故在装之前就拦下。
func osSupportsSbx(caption string, build int) bool {
	if strings.Contains(strings.ToLower(caption), "server") {
		return false
	}
	return build >= 22000
}

// parseOSInfo 解析 "Caption|BuildNumber"(windowsSupportsSbx 用一条 PowerShell 同时取两者)。
// 查不到 → 返回空串 + 0,交调用方 fail-open(别因一次查询失败假装不支持、误弹硬墙)。
func parseOSInfo(raw string) (caption string, build int) {
	parts := strings.SplitN(strings.TrimSpace(raw), "|", 2)
	caption = strings.TrimSpace(parts[0])
	if len(parts) == 2 {
		build, _ = strconv.Atoi(strings.TrimSpace(parts[1]))
	}
	return caption, build
}

// KitOptions 生成 kit 的入参。默认指向冰茶网关;自定义模型时覆盖 BaseURL/AuthToken/Model/NetworkAllow。
type KitOptions struct {
	Lang         string
	Timezone     string
	BaseURL      string // ANTHROPIC_BASE_URL
	AuthToken    string // ANTHROPIC_AUTH_TOKEN
	Model        string // ANTHROPIC_MODEL(空则不写这行,用 claude 默认)
	NetworkAllow string // caps.network.allow 条目(localhost:端口 / 自定义域名)
}

// defaultKitOptions 冰茶托管默认:英语 + 美东,指向宿主网关(host.docker.internal:端口)。
func defaultKitOptions(gatewayPort int) KitOptions {
	return KitOptions{
		Lang:         "en_US.UTF-8",
		Timezone:     "America/New_York",
		BaseURL:      fmt.Sprintf("http://host.docker.internal:%d", gatewayPort),
		AuthToken:    sandboxSentinelToken,
		NetworkAllow: fmt.Sprintf("localhost:%d", gatewayPort),
	}
}

// hostFromURL 从 base URL 取 host[:port](供自定义模型的网络放行)。
func hostFromURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return ""
	}
	return u.Host
}

// kitSpecYAML 渲染 sbx kit 清单(spec.yaml,经 sbx kit validate 实测确认的 schema)。
// kind: mixin = 叠加到 claude agent 上;ANTHROPIC_* 设成沙箱环境变量,Claude Code 从 env 直接读。
// 网络放行用 caps.network.allow(kit-spec v2)。
func kitSpecYAML(o KitOptions) string {
	var b strings.Builder
	b.WriteString("schemaVersion: 1\nkind: mixin\nname: gfa-claude\nenvironment:\n  variables:\n")
	fmt.Fprintf(&b, "    LANG: %s\n", o.Lang)
	fmt.Fprintf(&b, "    TZ: %s\n", o.Timezone)
	fmt.Fprintf(&b, "    ANTHROPIC_BASE_URL: %s\n", o.BaseURL)
	fmt.Fprintf(&b, "    ANTHROPIC_AUTH_TOKEN: %s\n", o.AuthToken)
	if strings.TrimSpace(o.Model) != "" {
		fmt.Fprintf(&b, "    ANTHROPIC_MODEL: %s\n", o.Model)
	}
	fmt.Fprintf(&b, "caps:\n  network:\n    allow: [ %q ]\n", o.NetworkAllow)
	// 创建时:①装 locales + 生成目标 LANG(镜像默认只有 C/C.utf8,否则一设 LANG 就报 locale 警告);
	// ②TZ 三重钉死 —— sbx 会把宿主时区(如 CST-8)进程级注入 agent、盖过 kit 的 TZ env。唯一能压过它的
	// 是官方 env 通道 /etc/sandbox-persistent.sh(agent 用 sbx run 启动时 source,后于注入生效,实测有效);
	// 再加 /etc/localtime 兜底读 localtime 的程序。等 apt 锁空闲再装,失败不阻塞(|| true)。
	// 实测:balanced 放行 apt 源,agent 有免密 sudo。
	startup := // TZ 必须最先写(几毫秒),赶在 agent 启动 source sandbox-persistent.sh 之前;apt 装 locale 慢,放后面:
		`grep -q '^export TZ=' /etc/sandbox-persistent.sh 2>/dev/null || echo 'export TZ=` + o.Timezone + `' | sudo tee -a /etc/sandbox-persistent.sh >/dev/null; ` +
			`sudo ln -sf /usr/share/zoneinfo/` + o.Timezone + ` /etc/localtime 2>/dev/null; ` +
			`for i in $(seq 1 60); do sudo fuser /var/lib/apt/lists/lock >/dev/null 2>&1 || break; sleep 2; done; ` +
			`sudo apt-get install -y locales >/dev/null 2>&1 && sudo locale-gen ` + o.Lang + ` >/dev/null 2>&1; true`
	b.WriteString("commands:\n  startup:\n")
	b.WriteString(`    - command: ["sh","-c","` + startup + `"]` + "\n")
	return b.String()
}

// policyAllowArgs 返回放行某网络目标(localhost:端口 / 域名)的 sbx policy 参数。
func policyAllowArgs(allow string) []string {
	return []string{"policy", "allow", "network", allow}
}

// SandboxMount 一个挂载项。ReadOnly=true → sbx run 位置参数追加 :ro。
type SandboxMount struct {
	Path     string `json:"path"`
	ReadOnly bool   `json:"readOnly"`
}

// isDangerousMount 判断挂载目录是否越界(家目录本身 / 根 / 常见系统盘),供 UI 告警。
func isDangerousMount(path, home string) bool {
	clean := filepath.Clean(path)
	if clean == "/" || clean == filepath.Clean(home) {
		return true
	}
	for _, sys := range []string{"/System", "/Library", "/etc", "/usr", "/bin", "C:\\Windows", "C:\\Program Files"} {
		if clean == sys {
			return true
		}
	}
	return false
}

// mountArgs 把挂载项转成 sbx run 位置参数;只读追加 :ro。
func mountArgs(mounts []SandboxMount) []string {
	args := make([]string, 0, len(mounts))
	for _, m := range mounts {
		if m.ReadOnly {
			args = append(args, m.Path+":ro")
		} else {
			args = append(args, m.Path)
		}
	}
	return args
}

// ── 沙箱命名 + 生命周期安全线 ──────────────────────────────────────────────
//
// 冰茶托管的沙箱统一 gfa-claude- 前缀:①开沙箱带固定 --name,冰茶据此复用/停止;
// ②isGfaManagedSandbox 是安全线,冰茶【只】动自己前缀的沙箱,绝不碰用户自己 sbx run 起的。

const sandboxNamePrefix = "gfa-claude-" // claude 沙箱命名前缀
const managedSandboxPrefix = "gfa-"     // 冰茶托管的所有沙箱(claude/kimi/…)共同前缀 = 安全线

var unsafeSandboxNameChar = regexp.MustCompile(`[^A-Za-z0-9._-]`)

// sandboxName 由首个挂载目录派生一个稳定的托管沙箱名:gfa-claude-<项目名>-<完整路径短哈希>。
// 哈希后缀是防撞:同一目录 → 名字稳定 → sbx run 复用同一沙箱;不同目录哪怕同名(如两个 app)
// → 哈希不同 → 各自独立,不会重连到别人的沙箱、挂错项目。无挂载 → gfa-claude-default-<空哈希>。
func sandboxName(mounts []SandboxMount) string {
	base, full := "default", ""
	if len(mounts) > 0 {
		full = filepath.Clean(mounts[0].Path)
		if b := filepath.Base(strings.TrimRight(mounts[0].Path, `/\`)); b != "" && b != "." && b != string(filepath.Separator) {
			base = b
		}
	}
	if base = unsafeSandboxNameChar.ReplaceAllString(base, "-"); base == "" {
		base = "default"
	}
	sum := sha256.Sum256([]byte(full))
	return sandboxNamePrefix + base + "-" + hex.EncodeToString(sum[:])[:6]
}

// isGfaManagedSandbox 安全线:只有 gfa- 前缀的才是冰茶托管(claude/kimi/…)、可被冰茶
// 列出/停止/移除的;绝不碰用户自己 sbx run 起的沙箱。
func isGfaManagedSandbox(name string) bool {
	return strings.HasPrefix(name, managedSandboxPrefix)
}

// sandboxSource 由沙箱名前缀判来源:CLI(冰茶新建项目沙箱)还是 VSCode(扩展 wrapper 惰性建)。
// 供统一列表打「来源」标签。非 gfa- 前缀不该走到这(已被安全线滤掉),兜底 other。
func sandboxSource(name string) string {
	switch {
	case strings.HasPrefix(name, "gfa-vscode-"):
		return "vscode"
	case strings.HasPrefix(name, sandboxNamePrefix): // gfa-claude-
		return "cli"
	default:
		return "other"
	}
}

// sandboxLabel 列表里给人看的可读名:优先用工作区目录名(最直观),无工作区才去前缀留名字主体。
func sandboxLabel(name, workspace string) string {
	if workspace != "" {
		if b := filepath.Base(strings.TrimRight(workspace, `/\`)); b != "" && b != "." && b != string(filepath.Separator) {
			return b
		}
	}
	for _, p := range []string{sandboxNamePrefix, "gfa-vscode-", managedSandboxPrefix} {
		if strings.HasPrefix(name, p) {
			return strings.TrimPrefix(name, p)
		}
	}
	return name
}

// createCommandArgs 拼 `sbx` 之后的参数:create --name <name> --kit <kit> claude <挂载...>。
// 冰茶后台跑它直接把 box 建出来(无 TTY 需求);create 只建不进入,box 建完是 stopped。
// 语法:sbx create [flags] AGENT PATH...,挂载即工作区,烧进 box 的 spec,进入时无需再传。
func createCommandArgs(name, kitPath string, mounts []SandboxMount) []string {
	args := []string{"create", "--name", name, "--kit", kitPath, "claude"}
	return append(args, mountArgs(mounts)...)
}

// shellQuote 给含空格/特殊字符的参数加单引号(供用户复制到 shell)。macOS「Application Support」
// 这类带空格的路径不加引号会被 shell 拆成多个参数,命令直接坏掉。
// 注:单引号是 bash/zsh 口径;Windows(cmd/powershell)引用规则不同,待 Windows 真机验证时另处理。
func shellQuote(s string) string {
	if s == "" {
		return "''"
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' ||
			r == '/' || r == '.' || r == '_' || r == '-' || r == ':') {
			// 含需要引用的字符 → 单引号包裹,内部单引号转义为 '\''
			return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
		}
	}
	return s
}

// enterCommandString 给用户复制到终端的「进入」命令。box 已由 create 建好(kit/工作区/挂载都烧进 spec),
// 故进入极短 —— 只需 sbx run --name;claude 从 spec 读、跑在已挂载的工作区。skipPerms 时透传
// --dangerously-skip-permissions(它是 claude 的参数,故走 -- 之后,属进入时而非建时)。
// SBX_NO_TELEMETRY=1 关 sbx 遥测。按当前系统选 shell 口径(见 enterCommandStringForOS)。
func enterCommandString(name string, skipPerms bool) string {
	return enterCommandStringForOS(runtime.GOOS, name, skipPerms)
}

// enterCommandStringForOS 按目标 shell 口径拼「进入」命令。抽 goos 形参便于测试两条分支。
// Windows(sbx 只支持 Win11 → 粘贴目标恒为 PowerShell):PowerShell【不支持】bash 的 `VAR=1 cmd`
// 内联前缀,会把 `SBX_NO_TELEMETRY=1` 当命令名去找 → CommandNotFoundException(用户实测报错)。
// 改用 `$env:VAR=1; cmd`;引用走 PowerShell 单引号(内部 ' → ”)。代价:该 env 对整个会话生效
// 而非仅此命令,但只是关遥测、无害,且是用户为跑 sbx 新开的终端。
// 其余(macOS/Linux):保持 bash/zsh 的 `VAR=1 cmd` 前缀 + POSIX 单引号。
func enterCommandStringForOS(goos, name string, skipPerms bool) string {
	var out string
	if goos == "windows" {
		out = "$env:SBX_NO_TELEMETRY=1; sbx run --name " + psQuote(name)
	} else {
		out = "SBX_NO_TELEMETRY=1 sbx run --name " + shellQuote(name)
	}
	if skipPerms {
		out += " -- --dangerously-skip-permissions"
	}
	return out
}

// psQuote 给参数加 PowerShell 单引号(内部 ' → ”)。PowerShell 单引号内不做变量/转义展开,最安全。
func psQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}
