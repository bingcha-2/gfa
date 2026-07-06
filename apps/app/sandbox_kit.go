package main

import (
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

// kitYAML 渲染 sbx kit 清单。startup 里的 {{KIT}} 由 sbx 在运行时替换为 kit 根路径。
// settings.json 用 startup 命令写(不用静态 files):claude agent 会在静态文件之后覆写
// ~/.claude/settings.json,只有 startup 能压过它(官方文档)。
func kitYAML(o KitOptions) string {
	return fmt.Sprintf(`environment:
  variables:
    LANG: %s
    TZ: %s
    ANTHROPIC_BASE_URL: http://host.docker.internal:%d
    ANTHROPIC_AUTH_TOKEN: %s
network:
  allowedDomains: [ "localhost:%d" ]
commands:
  startup:
    - command: ["sh","-c","mkdir -p /home/agent/.claude && cp {{KIT}}/settings.json /home/agent/.claude/settings.json"]
`, o.Lang, o.Timezone, o.GatewayPort, o.SentinelToken, o.GatewayPort)
}

// sandboxSettingsJSON 生成沙箱内 ~/.claude/settings.json:把 Claude Code 指向
// host.docker.internal 上的宿主网关 + 哨兵 token。与宿主接管的 claude_inject.go 同构,
// 区别只在 host 用 host.docker.internal(sbx 代理会重写为宿主 localhost)。
func sandboxSettingsJSON(gatewayPort int) string {
	return fmt.Sprintf(`{
  "env": {
    "ANTHROPIC_BASE_URL": "http://host.docker.internal:%d",
    "ANTHROPIC_AUTH_TOKEN": "%s"
  }
}
`, gatewayPort, sandboxSentinelToken)
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

const sandboxNamePrefix = "gfa-claude-"

var unsafeSandboxNameChar = regexp.MustCompile(`[^A-Za-z0-9._-]`)

// sandboxName 由首个挂载目录名派生一个稳定的托管沙箱名(gfa-claude-<项目名>)。
// 无挂载 → gfa-claude-default。同一项目复用同名沙箱。
func sandboxName(mounts []SandboxMount) string {
	base := "default"
	if len(mounts) > 0 {
		if b := filepath.Base(strings.TrimRight(mounts[0].Path, `/\`)); b != "" && b != "." && b != string(filepath.Separator) {
			base = b
		}
	}
	base = unsafeSandboxNameChar.ReplaceAllString(base, "-")
	if base == "" {
		base = "default"
	}
	return sandboxNamePrefix + base
}

// isGfaManagedSandbox 安全线:只有 gfa-claude- 前缀的才是冰茶托管、可被冰茶停止/移除的。
func isGfaManagedSandbox(name string) bool {
	return strings.HasPrefix(name, sandboxNamePrefix)
}

// runCommandArgs 拼 `sbx` 之后的参数:run --name <name> --kit <kit> claude <挂载...>。
func runCommandArgs(name, kitPath string, mounts []SandboxMount) []string {
	args := []string{"run", "--name", name, "--kit", kitPath, "claude"}
	return append(args, mountArgs(mounts)...)
}

// runCommandString 给用户复制的完整命令。
func runCommandString(name, kitPath string, mounts []SandboxMount) string {
	return "sbx " + strings.Join(runCommandArgs(name, kitPath, mounts), " ")
}
