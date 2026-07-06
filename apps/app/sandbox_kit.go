package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
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

// KitOptions 生成 gfa-claude kit 的入参。
type KitOptions struct {
	GatewayPort   int
	Lang          string
	Timezone      string
	SentinelToken string
}

// defaultKitOptions Phase 1 固定默认:英语 + 美东。Phase 2 可覆盖 Timezone。
func defaultKitOptions(gatewayPort int) KitOptions {
	return KitOptions{
		GatewayPort:   gatewayPort,
		Lang:          "en_US.UTF-8",
		Timezone:      "America/New_York",
		SentinelToken: sandboxSentinelToken,
	}
}

// usTimezones 供前端下拉。
func usTimezones() []string {
	return []string{
		"America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
	}
}

// kitSpecYAML 渲染 sbx kit 清单(spec.yaml,经 sbx kit validate 实测确认的 schema)。
// kind: mixin = 叠加到 claude agent 上;ANTHROPIC_BASE_URL/AUTH_TOKEN 直接设成沙箱环境变量,
// Claude Code 从 env 即读到,无需再写 ~/.claude/settings.json。网络放行用 caps.network.allow
// (kit-spec v2;旧 network.allowedDomains 已弃用)。
func kitSpecYAML(o KitOptions) string {
	return fmt.Sprintf(`schemaVersion: 1
kind: mixin
name: gfa-claude
environment:
  variables:
    LANG: %s
    TZ: %s
    ANTHROPIC_BASE_URL: http://host.docker.internal:%d
    ANTHROPIC_AUTH_TOKEN: %s
caps:
  network:
    allow: [ "localhost:%d" ]
`, o.Lang, o.Timezone, o.GatewayPort, o.SentinelToken, o.GatewayPort)
}

// policyAllowArgs 返回放行宿主网关端口的 sbx policy 参数。
func policyAllowArgs(gatewayPort int) []string {
	return []string{"policy", "allow", "network", fmt.Sprintf("localhost:%d", gatewayPort)}
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

// runCommandArgs 拼 `sbx` 之后的参数:run --name <name> --kit <kit> claude <挂载...> [-- --dangerously-skip-permissions]。
// skipPerms=true 时把 --dangerously-skip-permissions 透传给沙箱里的 claude(沙箱已隔离,跳权限确认相对安全)。
// 语法:sbx run [flags] claude [PATH...] [-- AGENT_ARGS...],故挂载在前、-- 之后才是 claude 的参数。
func runCommandArgs(name, kitPath string, mounts []SandboxMount, skipPerms bool) []string {
	args := []string{"run", "--name", name, "--kit", kitPath, "claude"}
	args = append(args, mountArgs(mounts)...)
	if skipPerms {
		args = append(args, "--", "--dangerously-skip-permissions")
	}
	return args
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

// runCommandString 给用户复制的完整命令。前缀 SBX_NO_TELEMETRY=1 关 sbx 遥测(仅此次运行,
// 不污染用户 shell 配置);含空格的路径正确加引号。
func runCommandString(name, kitPath string, mounts []SandboxMount, skipPerms bool) string {
	out := "SBX_NO_TELEMETRY=1 sbx"
	for _, a := range runCommandArgs(name, kitPath, mounts, skipPerms) {
		out += " " + shellQuote(a)
	}
	return out
}
