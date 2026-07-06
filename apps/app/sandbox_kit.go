package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
)

// ─── 沙箱模式接管 · 纯函数层 ──────────────────────────────────────────────────
//
// 本文件只放无副作用的纯函数(kit YAML / settings.json / policy 参数 / 挂载参数 /
// run 命令拼装 / 安装命令 / 危险挂载判断 / 时区表),便于单测。触机器的动作(exec sbx /
// 装 sbx / 开终端 / 落盘)在 sandbox_takeover.go,并过 appActionsSuppressed() 短路。

const sandboxSentinelToken = "bcai-claude-proxy"

// installSbxCommandString 按平台返回给用户复制到终端安装 sbx 的命令(展示用)。
// 不由冰茶静默 exec:GUI 进程 PATH 常不含 brew 目录、装 brew 又慢又无反馈,交给用户终端更可靠。
func installSbxCommandString(goos string) string {
	switch goos {
	case "darwin":
		// 必须先 brew trust docker/tap:Homebrew 现要求信任第三方 tap,否则 install 报
		// 「Refusing to load cask ... from untrusted tap」。视频原始步骤即含此步。
		return "brew trust docker/tap && brew install docker/tap/sbx"
	case "windows":
		return "winget install -h Docker.sbx"
	case "linux":
		return "curl -fsSL https://get.docker.com | sudo REPO_ONLY=1 sh && sudo apt-get install -y docker-sbx"
	default:
		return ""
	}
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

// usTimezones 供前端下拉。
func usTimezones() []string {
	return []string{
		"America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
	}
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

const sandboxNamePrefix = "gfa-claude-"  // claude 沙箱命名前缀
const managedSandboxPrefix = "gfa-"       // 冰茶托管的所有沙箱(claude/kimi/…)共同前缀 = 安全线

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
// 前缀 SBX_NO_TELEMETRY=1 关 sbx 遥测(仅此次运行,不污染用户 shell)。
func enterCommandString(name string, skipPerms bool) string {
	out := "SBX_NO_TELEMETRY=1 sbx run --name " + shellQuote(name)
	if skipPerms {
		out += " -- --dangerously-skip-permissions"
	}
	return out
}
