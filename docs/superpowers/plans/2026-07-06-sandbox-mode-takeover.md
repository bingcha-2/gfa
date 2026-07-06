# 沙箱模式接管(Claude Code · sbx)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在冰茶接管中心新增「Claude Code · 沙箱模式」——冰茶帮用户检测/安装/配置 Docker `sbx`,生成 kit 让沙箱里的 Claude Code 请求经宿主冰茶网关出口。

**Architecture:** 复用接管中心注册表(`takeoverTargets`)加一个 `claude_sandbox` 目标做卡片/状态;sbx 特有编排放叶子模块 `sandbox_kit.go`(纯函数)+ `sandbox_takeover.go`(触机器 + target)+ `local_bindings_sandbox.go`(Wails 绑定)。网关代码零改动。

**Tech Stack:** Go(`bcai-wails` / package `main`,`apps/app/`)、Wails v2、React+TSX 前端、Docker `sbx` CLI。

**规约:**
- 纯函数(kit YAML / 命令拼装 / 挂载参数 / policy 语句 / 安装命令 / 危险挂载判断)先写 `*_test.go` 再实现。
- 触机器动作(`exec` sbx / 装 sbx / 开终端)一律 `if appActionsSuppressed() { return ... }` 短路(`appActionsSuppressed()=testing.Testing()`,见 `app_actions_guard.go:12`),不进 `go test`。
- 端口用 `effectiveProxyPort()`(`http_proxy.go:157`),不写死 48800。
- 频繁提交,每个 Task 末尾一次。

参考 spec:`docs/superpowers/specs/2026-07-06-sandbox-mode-takeover-design.md`

---

## Phase 0 · 真机验证(阻塞后续,人工执行,非代码任务)

在写任何 Phase 1 代码前,在真机手动敲通闭环,把三个「文档推断」变成「实测事实」。结果回填到 spec §9 与本计划相应 Task。

- [ ] **0.1 macOS 最小闭环**
  - `brew install docker/tap/sbx && sbx login`
  - 起冰茶(确保本地网关在 `127.0.0.1:<port>` 监听;`<port>` 取 `effectiveProxyPort()` 实际值,用 `lsof -iTCP -sTCP:LISTEN | grep <port>` 确认)
  - 手写最小 kit 目录 `~/gfa-kit/kit.yaml`(内容见 Task 2 的 `kitYAML` 输出)+ `~/gfa-kit/settings.json`(见 Task 3)
  - `sbx policy allow network localhost:<port>`
  - `cd ~/some-proj && sbx run --kit ~/gfa-kit claude`
  - 沙箱里发一条消息,**在冰茶网关日志确认这条请求从冰茶出去了**(看 `Log(...)` 出口/租号日志)
  - 记录:是否需要 `sbx login`、kit 是否被接受、settings.json startup 是否覆盖成功
- [ ] **0.2 时区格式**:抓一条真实 Claude Code 请求正文,确认注入提示词的时区**格式**(IANA `America/New_York` / UTC 偏移 / 仅本地日期)。回填 Phase 2 Task 12 的对齐目标。
- [ ] **0.3 Windows 盘符**:Windows 上 `sbx run <D:\proj>`,进沙箱后 `pwd` 看 `D:\proj` 映射成什么 Linux 路径。回填 Task 6 的 `mountArgs` Windows 分支。
- [ ] **0.4 en_US 语言包**:沙箱内 `locale -a | grep en_US`,确认基础镜像自带(近乎肯定)。

**Gate:** 0.1 跑通(请求确实经冰茶)才进 Phase 1。0.3 未过前,Windows 卡片标「实验」。

---

## Phase 1 · MVP

### 文件结构

- Create `apps/app/sandbox_kit.go` —— 纯函数:kit YAML、settings.json、policy 参数、挂载参数、run 命令、安装命令、危险挂载判断、US 时区表。
- Create `apps/app/sandbox_kit_test.go` —— 上述纯函数的单测。
- Create `apps/app/sandbox_takeover.go` —— `claudeSandboxTarget`(实现 `TakeoverTarget`)、`SbxStatus`、`DetectSbx`、`GenerateKit`(文件 IO)、`ApplyPolicy`/`InstallSbx`/`OpenInTerminal`(触机器,guard)。
- Create `apps/app/sandbox_takeover_test.go` —— target 注册/GenerateKit(temp 目录)测试。
- Create `apps/app/local_bindings_sandbox.go` —— Wails 绑定 App 方法。
- Modify `apps/app/takeover.go:69-75` —— `takeoverTargets` 注册 `claudeSandboxTarget{}`。
- Modify `apps/app/takeover.go:89-100` —— `targetRequiredProduct` 加 `"claude_sandbox": "anthropic"`。
- Frontend:Modify `apps/app/frontend/src/features/takeover/TakeoverCenterPage.tsx` —— 加沙箱卡片 + 挂载子面板。

---

### Task 1: sbx 安装命令(纯函数)

**Files:**
- Create: `apps/app/sandbox_kit.go`
- Test: `apps/app/sandbox_kit_test.go`

- [ ] **Step 1: 写失败测试**

```go
package main

import "testing"

func TestInstallSbxCommand(t *testing.T) {
	cases := map[string]struct {
		goos string
		name string
		args []string
	}{
		"darwin":  {"darwin", "brew", []string{"install", "docker/tap/sbx"}},
		"windows": {"windows", "winget", []string{"install", "-h", "Docker.sbx"}},
		"linux":   {"linux", "sh", []string{"-c", "curl -fsSL https://get.docker.com | sudo REPO_ONLY=1 sh && sudo apt-get install -y docker-sbx"}},
	}
	for goos, want := range cases {
		name, args, err := installSbxCommand(want.goos)
		if err != nil {
			t.Fatalf("%s: unexpected err %v", goos, err)
		}
		if name != want.name {
			t.Errorf("%s: name=%q want %q", goos, name, want.name)
		}
		if len(args) != len(want.args) {
			t.Fatalf("%s: args=%v want %v", goos, args, want.args)
		}
		for i := range args {
			if args[i] != want.args[i] {
				t.Errorf("%s: args[%d]=%q want %q", goos, i, args[i], want.args[i])
			}
		}
	}
	if _, _, err := installSbxCommand("plan9"); err == nil {
		t.Errorf("expected error for unsupported goos")
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/app && go test ./ -run TestInstallSbxCommand -v`
Expected: FAIL(`undefined: installSbxCommand`)

- [ ] **Step 3: 最小实现**

```go
package main

import "fmt"

// installSbxCommand 按平台返回安装 sbx 的命令(name + args)。
func installSbxCommand(goos string) (string, []string, error) {
	switch goos {
	case "darwin":
		return "brew", []string{"install", "docker/tap/sbx"}, nil
	case "windows":
		return "winget", []string{"install", "-h", "Docker.sbx"}, nil
	case "linux":
		return "sh", []string{"-c", "curl -fsSL https://get.docker.com | sudo REPO_ONLY=1 sh && sudo apt-get install -y docker-sbx"}, nil
	default:
		return "", nil, fmt.Errorf("unsupported platform: %s", goos)
	}
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/app && go test ./ -run TestInstallSbxCommand -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/app/sandbox_kit.go apps/app/sandbox_kit_test.go
git commit -m "feat(sandbox): sbx 安装命令按平台分支(纯函数)"
```

---

### Task 2: kit YAML 生成(纯函数)

**Files:**
- Modify: `apps/app/sandbox_kit.go`
- Test: `apps/app/sandbox_kit_test.go`

- [ ] **Step 1: 写失败测试**

```go
func TestKitYAML(t *testing.T) {
	o := KitOptions{GatewayPort: 48800, Lang: "en_US.UTF-8", Timezone: "America/New_York", SentinelToken: "bcai-claude-proxy"}
	got := kitYAML(o)
	for _, want := range []string{
		"LANG: en_US.UTF-8",
		"TZ: America/New_York",
		"ANTHROPIC_BASE_URL: http://host.docker.internal:48800",
		"ANTHROPIC_AUTH_TOKEN: bcai-claude-proxy",
		`allowedDomains: [ "localhost:48800" ]`,
		"mkdir -p /home/agent/.claude",
		"cp {{KIT}}/settings.json /home/agent/.claude/settings.json",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("kitYAML missing %q\n---\n%s", want, got)
		}
	}
}
```

(在测试文件 import 里加 `"strings"`。)

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/app && go test ./ -run TestKitYAML -v`
Expected: FAIL(`undefined: KitOptions` / `kitYAML`)

- [ ] **Step 3: 最小实现**(追加到 `sandbox_kit.go`)

```go
import "fmt" // 已在文件顶部

// KitOptions 生成 gfa-claude kit 的入参。
type KitOptions struct {
	GatewayPort   int
	Lang          string
	Timezone      string
	SentinelToken string
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/app && go test ./ -run TestKitYAML -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/app/sandbox_kit.go apps/app/sandbox_kit_test.go
git commit -m "feat(sandbox): 生成 gfa-claude kit YAML(纯函数)"
```

---

### Task 3: 沙箱 settings.json(纯函数)

**Files:**
- Modify: `apps/app/sandbox_kit.go`
- Test: `apps/app/sandbox_kit_test.go`

- [ ] **Step 1: 写失败测试**

```go
func TestSandboxSettingsJSON(t *testing.T) {
	got := sandboxSettingsJSON(48800)
	var m map[string]any
	if err := json.Unmarshal([]byte(got), &m); err != nil {
		t.Fatalf("not valid json: %v", err)
	}
	env, _ := m["env"].(map[string]any)
	if env["ANTHROPIC_BASE_URL"] != "http://host.docker.internal:48800" {
		t.Errorf("base url wrong: %v", env["ANTHROPIC_BASE_URL"])
	}
	if env["ANTHROPIC_AUTH_TOKEN"] != "bcai-claude-proxy" {
		t.Errorf("auth token wrong: %v", env["ANTHROPIC_AUTH_TOKEN"])
	}
}
```

(测试文件 import 加 `"encoding/json"`。)

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/app && go test ./ -run TestSandboxSettingsJSON -v`
Expected: FAIL(`undefined: sandboxSettingsJSON`)

- [ ] **Step 3: 最小实现**

```go
// sandboxSettingsJSON 生成沙箱内 ~/.claude/settings.json:把 Claude Code 指向 host.docker.internal
// 上的宿主网关 + 哨兵 token。与宿主接管的 claude_inject.go 同构,但 host 用 host.docker.internal。
func sandboxSettingsJSON(gatewayPort int) string {
	return fmt.Sprintf(`{
  "env": {
    "ANTHROPIC_BASE_URL": "http://host.docker.internal:%d",
    "ANTHROPIC_AUTH_TOKEN": "bcai-claude-proxy"
  }
}
`, gatewayPort)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/app && go test ./ -run TestSandboxSettingsJSON -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/app/sandbox_kit.go apps/app/sandbox_kit_test.go
git commit -m "feat(sandbox): 沙箱内 settings.json(纯函数)"
```

---

### Task 4: policy allow 参数(纯函数)

**Files:**
- Modify: `apps/app/sandbox_kit.go`
- Test: `apps/app/sandbox_kit_test.go`

- [ ] **Step 1: 写失败测试**

```go
func TestPolicyAllowArgs(t *testing.T) {
	got := policyAllowArgs(48800)
	want := []string{"policy", "allow", "network", "localhost:48800"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("got %v want %v", got, want)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/app && go test ./ -run TestPolicyAllowArgs -v`
Expected: FAIL

- [ ] **Step 3: 最小实现**

```go
// policyAllowArgs 返回放行宿主网关端口的 sbx policy 参数。
func policyAllowArgs(gatewayPort int) []string {
	return []string{"policy", "allow", "network", fmt.Sprintf("localhost:%d", gatewayPort)}
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/app && go test ./ -run TestPolicyAllowArgs -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/app/sandbox_kit.go apps/app/sandbox_kit_test.go
git commit -m "feat(sandbox): policy allow 参数(纯函数)"
```

---

### Task 5: 挂载数据结构 + 危险挂载判断(纯函数)

**Files:**
- Modify: `apps/app/sandbox_kit.go`
- Test: `apps/app/sandbox_kit_test.go`

- [ ] **Step 1: 写失败测试**

```go
func TestIsDangerousMount(t *testing.T) {
	home := "/Users/alice"
	cases := []struct {
		path string
		want bool
	}{
		{"/Users/alice", true},        // 家目录本身
		{"/", true},                   // 根
		{"/System", true},             // 系统盘
		{"/Users/alice/proj", false},  // 家目录下的项目 OK
		{"/tmp/work", false},
	}
	for _, c := range cases {
		if got := isDangerousMount(c.path, home); got != c.want {
			t.Errorf("isDangerousMount(%q)=%v want %v", c.path, got, c.want)
		}
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/app && go test ./ -run TestIsDangerousMount -v`
Expected: FAIL

- [ ] **Step 3: 最小实现**

```go
import "path/filepath" // 加到文件顶部 import

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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/app && go test ./ -run TestIsDangerousMount -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/app/sandbox_kit.go apps/app/sandbox_kit_test.go
git commit -m "feat(sandbox): 挂载结构 + 危险挂载判断(纯函数)"
```

---

### Task 6: 挂载参数 + run 命令拼装(纯函数)

**Files:**
- Modify: `apps/app/sandbox_kit.go`
- Test: `apps/app/sandbox_kit_test.go`

- [ ] **Step 1: 写失败测试**

```go
func TestMountArgs(t *testing.T) {
	got := mountArgs([]SandboxMount{
		{Path: "/proj", ReadOnly: false},
		{Path: "/refs", ReadOnly: true},
	})
	want := []string{"/proj", "/refs:ro"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("got %v want %v", got, want)
	}
}

func TestRunCommandArgs(t *testing.T) {
	got := runCommandArgs("/kits/gfa", []SandboxMount{{Path: "/proj"}})
	want := []string{"run", "--kit", "/kits/gfa", "claude", "/proj"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("got %v want %v", got, want)
	}
}

func TestRunCommandString(t *testing.T) {
	got := runCommandString("/kits/gfa", []SandboxMount{{Path: "/proj"}})
	if got != "sbx run --kit /kits/gfa claude /proj" {
		t.Errorf("got %q", got)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/app && go test ./ -run 'TestMountArgs|TestRunCommand' -v`
Expected: FAIL

- [ ] **Step 3: 最小实现**

```go
import "strings" // 加到 import

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

// runCommandArgs 拼 `sbx` 之后的参数:run --kit <kit> claude <挂载...>。
func runCommandArgs(kitPath string, mounts []SandboxMount) []string {
	args := []string{"run", "--kit", kitPath, "claude"}
	return append(args, mountArgs(mounts)...)
}

// runCommandString 给用户复制的完整命令。
func runCommandString(kitPath string, mounts []SandboxMount) string {
	return "sbx " + strings.Join(runCommandArgs(kitPath, mounts), " ")
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/app && go test ./ -run 'TestMountArgs|TestRunCommand' -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/app/sandbox_kit.go apps/app/sandbox_kit_test.go
git commit -m "feat(sandbox): 挂载参数 + run 命令拼装(纯函数)"
```

> 备注:Phase 0.3 若发现 Windows 盘符需转换(如 `D:\proj` → `/mnt/d/proj`),在 `mountArgs` 加一个 `runtime.GOOS=="windows"` 分支做路径转换,并补对应测试。

---

### Task 7: US 时区表 + 默认 KitOptions(纯函数)

**Files:**
- Modify: `apps/app/sandbox_kit.go`
- Test: `apps/app/sandbox_kit_test.go`

- [ ] **Step 1: 写失败测试**

```go
func TestDefaultKitOptions(t *testing.T) {
	o := defaultKitOptions(48800)
	if o.Lang != "en_US.UTF-8" || o.Timezone != "America/New_York" || o.SentinelToken != "bcai-claude-proxy" || o.GatewayPort != 48800 {
		t.Errorf("bad defaults: %+v", o)
	}
}

func TestUSTimezonesNonEmpty(t *testing.T) {
	tz := usTimezones()
	if len(tz) == 0 || tz[0] != "America/New_York" {
		t.Errorf("usTimezones bad: %v", tz)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/app && go test ./ -run 'TestDefaultKitOptions|TestUSTimezones' -v`
Expected: FAIL

- [ ] **Step 3: 最小实现**

```go
const sandboxSentinelToken = "bcai-claude-proxy"

// defaultKitOptions Phase 1 固定默认:英语 + 美东。Phase 2 覆盖 Timezone。
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/app && go test ./ -run 'TestDefaultKitOptions|TestUSTimezones' -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/app/sandbox_kit.go apps/app/sandbox_kit_test.go
git commit -m "feat(sandbox): US 时区表 + 默认 KitOptions(纯函数)"
```

---

### Task 8: GenerateKit 落盘(文件 IO,temp 目录可测)

**Files:**
- Create: `apps/app/sandbox_takeover.go`
- Test: `apps/app/sandbox_takeover_test.go`

- [ ] **Step 1: 写失败测试**

```go
package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGenerateKitWritesFiles(t *testing.T) {
	dir := t.TempDir()
	o := defaultKitOptions(48800)
	if err := generateKitInto(dir, o); err != nil {
		t.Fatalf("generateKitInto: %v", err)
	}
	kit, err := os.ReadFile(filepath.Join(dir, "kit.yaml"))
	if err != nil {
		t.Fatalf("read kit.yaml: %v", err)
	}
	if !strings.Contains(string(kit), "ANTHROPIC_BASE_URL: http://host.docker.internal:48800") {
		t.Errorf("kit.yaml wrong:\n%s", kit)
	}
	settings, err := os.ReadFile(filepath.Join(dir, "settings.json"))
	if err != nil {
		t.Fatalf("read settings.json: %v", err)
	}
	if !strings.Contains(string(settings), "host.docker.internal:48800") {
		t.Errorf("settings.json wrong:\n%s", settings)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/app && go test ./ -run TestGenerateKitWritesFiles -v`
Expected: FAIL(`undefined: generateKitInto`)

- [ ] **Step 3: 最小实现**(`sandbox_takeover.go`)

```go
package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// sandboxKitDir 返回 kit 的固定落盘路径(<用户配置目录>/bcai/sandbox/gfa-claude)。
func sandboxKitDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "bcai", "sandbox", "gfa-claude"), nil
}

// generateKitInto 把 kit.yaml + settings.json 写进 dir。纯 IO,便于用 temp 目录测试。
func generateKitInto(dir string, o KitOptions) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "kit.yaml"), []byte(kitYAML(o)), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(sandboxSettingsJSON(o.GatewayPort)), 0o644); err != nil {
		return err
	}
	return nil
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/app && go test ./ -run TestGenerateKitWritesFiles -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/app/sandbox_takeover.go apps/app/sandbox_takeover_test.go
git commit -m "feat(sandbox): GenerateKit 落盘(kit.yaml + settings.json)"
```

---

### Task 9: DetectSbx + 触机器动作(guard,不进 go test 主逻辑)

**Files:**
- Modify: `apps/app/sandbox_takeover.go`
- Test: `apps/app/sandbox_takeover_test.go`

- [ ] **Step 1: 写失败测试**(只测「抑制时安全短路」,不真跑 sbx)

```go
func TestApplyPolicySuppressed(t *testing.T) {
	// go test 里 appActionsSuppressed()==true,ApplyPolicy 必须短路返回 nil,不 exec 真 sbx。
	if err := ApplyPolicy(48800); err != nil {
		t.Errorf("ApplyPolicy under test should no-op, got %v", err)
	}
}

func TestInstallSbxSuppressed(t *testing.T) {
	if err := InstallSbx(); err != nil {
		t.Errorf("InstallSbx under test should no-op, got %v", err)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/app && go test ./ -run 'TestApplyPolicySuppressed|TestInstallSbxSuppressed' -v`
Expected: FAIL(`undefined: ApplyPolicy` / `InstallSbx`)

- [ ] **Step 3: 最小实现**(追加到 `sandbox_takeover.go`)

```go
import (
	"os/exec"
	"runtime"
)

// SbxStatus sbx 安装状态,供卡片展示。
type SbxStatus struct {
	Installed bool   `json:"installed"`
	Version   string `json:"version"`
	KvmOK     bool   `json:"kvmOK"`   // 仅 Linux 有意义
	Note      string `json:"note"`
}

// DetectSbx 检测 sbx 是否可用。抑制态(go test)直接返回未装,不 exec。
func DetectSbx() SbxStatus {
	if appActionsSuppressed() {
		return SbxStatus{}
	}
	path, err := exec.LookPath("sbx")
	if err != nil {
		return SbxStatus{Installed: false, Note: "未检测到 sbx"}
	}
	out, _ := exec.Command(path, "version").Output()
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

// ApplyPolicy 放行宿主网关端口。抑制态短路。
func ApplyPolicy(gatewayPort int) error {
	if appActionsSuppressed() {
		return nil
	}
	return exec.Command("sbx", policyAllowArgs(gatewayPort)...).Run()
}

// InstallSbx 按平台装 sbx。抑制态短路。
func InstallSbx() error {
	if appActionsSuppressed() {
		return nil
	}
	name, args, err := installSbxCommand(runtime.GOOS)
	if err != nil {
		return err
	}
	return exec.Command(name, args...).Run()
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/app && go test ./ -run 'TestApplyPolicySuppressed|TestInstallSbxSuppressed' -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/app/sandbox_takeover.go apps/app/sandbox_takeover_test.go
git commit -m "feat(sandbox): DetectSbx + ApplyPolicy/InstallSbx(触机器,抑制态短路)"
```

---

### Task 10: 注册 claude_sandbox target

**Files:**
- Modify: `apps/app/sandbox_takeover.go`
- Modify: `apps/app/takeover.go:69-75`(`takeoverTargets`)
- Modify: `apps/app/takeover.go:89-100`(`targetRequiredProduct`)
- Test: `apps/app/sandbox_takeover_test.go`

- [ ] **Step 1: 写失败测试**

```go
func TestClaudeSandboxTargetRegistered(t *testing.T) {
	tgt := findTakeoverTarget("claude_sandbox")
	if tgt == nil {
		t.Fatal("claude_sandbox target not registered")
	}
	if tgt.Name() == "" || tgt.InjectionType() != "sandbox" {
		t.Errorf("bad target meta: name=%q type=%q", tgt.Name(), tgt.InjectionType())
	}
	if got := targetRequiredProduct("claude_sandbox"); got != "anthropic" {
		t.Errorf("required product=%q want anthropic", got)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/app && go test ./ -run TestClaudeSandboxTargetRegistered -v`
Expected: FAIL

- [ ] **Step 3: 实现**

追加到 `sandbox_takeover.go`:

```go
// claudeSandboxTarget 沙箱模式接管目标。Inject=生成默认 kit + 放行 policy;
// Restore=撤 policy + 删 kit。带挂载/时区的富流程走 local_bindings_sandbox.go。
type claudeSandboxTarget struct{}

func (claudeSandboxTarget) Key() string           { return "claude_sandbox" }
func (claudeSandboxTarget) ProductID() string     { return "claude_sandbox" }
func (claudeSandboxTarget) Name() string          { return "Claude Code · 沙箱模式" }
func (claudeSandboxTarget) InjectionType() string { return "sandbox" }
func (claudeSandboxTarget) DetectPath() string {
	if p, err := exec.LookPath("sbx"); err == nil {
		return p
	}
	return ""
}

func (claudeSandboxTarget) IsInjected(_ int) bool {
	dir, err := sandboxKitDir()
	if err != nil {
		return false
	}
	_, err = os.Stat(filepath.Join(dir, "kit.yaml"))
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
	if err := revokeSandbox(proxyPortForRestore()); err != nil {
		return "", err
	}
	return "沙箱模式: ✓ 已移除 kit", nil
}

// proxyPortForRestore 还原时也要拿实际端口撤 policy。
func proxyPortForRestore() int { return effectiveProxyPort() }

// revokeSandbox 删 kit 目录 + 撤 policy(抑制态只删目录不 exec)。
func revokeSandbox(gatewayPort int) error {
	if dir, err := sandboxKitDir(); err == nil {
		_ = os.RemoveAll(dir)
	}
	if appActionsSuppressed() {
		return nil
	}
	return exec.Command("sbx", "policy", "deny", "network", fmt.Sprintf("localhost:%d", gatewayPort)).Run()
}
```

Modify `takeover.go:69`:

```go
var takeoverTargets = []TakeoverTarget{
	antigravityIDETarget{},
	antigravityHubTarget{},
	codexTarget{},
	claudeCodeTarget{},
	claudeDesktopTarget{},
	claudeSandboxTarget{},
}
```

Modify `takeover.go` 的 `targetRequiredProduct` switch,在 `case "claude_code", "claude_desktop":` 里加 `"claude_sandbox"`:

```go
	case "claude_code", "claude_desktop", "claude_sandbox":
		return "anthropic"
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/app && go test ./ -run TestClaudeSandboxTargetRegistered -v`
Expected: PASS

- [ ] **Step 5: 全量测试 + 提交**

```bash
cd apps/app && go test ./ -run 'Sandbox|Takeover|Kit' && cd -
git add apps/app/sandbox_takeover.go apps/app/takeover.go
git commit -m "feat(sandbox): 注册 claude_sandbox 接管目标"
```

---

### Task 11: Wails 绑定 + 前端卡片

**Files:**
- Create: `apps/app/local_bindings_sandbox.go`
- Modify: `apps/app/frontend/src/features/takeover/TakeoverCenterPage.tsx`

- [ ] **Step 1: 后端绑定**(`local_bindings_sandbox.go`)

```go
package main

// 沙箱模式接管 Wails 绑定。冰茶只准备(装/配/递命令),交互由用户在自己终端 sbx run。

// SandboxGetStatus 卡片状态。
func (a *App) SandboxGetStatus() SbxStatus { return DetectSbx() }

// SandboxInstall 代装 sbx(平台分支)。
func (a *App) SandboxInstall() error { return InstallSbx() }

// SandboxPrepare 生成带挂载/时区的 kit + 放行 policy,返回给用户复制的命令。
func (a *App) SandboxPrepare(mounts []SandboxMount, timezone string) (string, error) {
	if err := validateTakeoverPrereqs(LoadConfig()); err != nil {
		return "", err
	}
	port := effectiveProxyPort()
	o := defaultKitOptions(port)
	if timezone != "" {
		o.Timezone = timezone
	}
	kitDir, err := GenerateKit(o)
	if err != nil {
		return "", err
	}
	if err := ApplyPolicy(port); err != nil {
		return "", err
	}
	return runCommandString(kitDir, mounts), nil
}

// SandboxUSTimezones 供前端下拉。
func (a *App) SandboxUSTimezones() []string { return usTimezones() }

// SandboxRestore 移除沙箱配置。
func (a *App) SandboxRestore() (string, error) {
	return claudeSandboxTarget{}.Restore()
}
```

- [ ] **Step 2: 编译确认绑定生成**

Run: `cd apps/app && go build ./...`
Expected: 编译通过(Wails 会据 App 方法生成前端 TS 绑定)

- [ ] **Step 3: 前端卡片**

先 `Read apps/app/frontend/src/features/takeover/TakeoverCenterPage.tsx`,照现有接管卡片(如 codex/claude_code 卡)的结构加一张「Claude Code · 沙箱模式」卡:
- 调 `SandboxGetStatus()` 显示安装状态;未装显示「安装」按钮 → `SandboxInstall()`
- 挂载列表:目录选择 + 每项 读/写 开关;越界目录(前端调用后端不便,直接前端简单判断家目录/根)给黄色告警
- 时区下拉:`SandboxUSTimezones()`,默认 `America/New_York`
- 「开启沙箱接管」按钮 → `SandboxPrepare(mounts, tz)` → 把返回的命令展示在带「复制」按钮的代码框里
- 「移除」按钮 → `SandboxRestore()`

- [ ] **Step 4: 前端构建**

Run: `cd apps/app/frontend && npm run build`(或项目实际构建命令)
Expected: 构建通过

- [ ] **Step 5: 提交**

```bash
git add apps/app/local_bindings_sandbox.go apps/app/frontend/src/features/takeover/TakeoverCenterPage.tsx
git commit -m "feat(sandbox): Wails 绑定 + 接管中心沙箱卡片"
```

---

### Task 12: Phase 1 真机冒烟

- [ ] 起冰茶 → 接管中心点沙箱卡「开启沙箱接管」→ 复制命令 → 终端 `sbx run` → 沙箱内 `claude` 发消息 → 冰茶日志确认请求经网关。
- [ ] `sbx run` 沙箱内验证:`env | grep -E 'ANTHROPIC_BASE_URL|TZ|LANG'` 三个值正确;`date` 显示美东;`cat ~/.claude/settings.json` 正确。
- [ ] 越界挂载告警、移除按钮撤 kit/policy 均生效。

---

## Phase 2 · 时区跟出口 IP + 同地区换号

> 依赖 Phase 0.2 的时区格式结论。以下按「IANA 名」假设;若实测是 UTC 偏移,Task 12 的对齐改成偏移映射。

### Task 13: 出口 IP → 时区(纯函数 + 一次探测)

**Files:**
- Create: `apps/app/sandbox_geo.go`
- Test: `apps/app/sandbox_geo_test.go`

- [ ] **Step 1: 写失败测试**(纯映射函数)

```go
func TestTimezoneFromGeo(t *testing.T) {
	// 输入 ip 地理查询返回的 timezone 字段,原样校验/兜底。
	if got := normalizeTimezone("America/Los_Angeles"); got != "America/Los_Angeles" {
		t.Errorf("got %q", got)
	}
	if got := normalizeTimezone(""); got != "America/New_York" {
		t.Errorf("empty should fallback to default, got %q", got)
	}
}
```

- [ ] **Step 2–4:** 实现 `normalizeTimezone(tz string) string`(空/非法 → 默认 `America/New_York`);再加 `probeExitTimezone(proxyURL string) (string, error)`:经 `proxyURL` 请求一个 IP 地理服务(如 `http://ip-api.com/json`,读 `timezone` 字段),抑制态短路返回默认。`probeExitTimezone` 触网络,不进单测主逻辑(抑制态短路 + 只测 `normalizeTimezone`)。

- [ ] **Step 5:** 提交 `feat(sandbox): 出口 IP → 时区探测(Phase 2)`

### Task 14: SandboxPrepare 接入探测

- [ ] `SandboxPrepare` 里,读当前粘性租约的出口代理(`GetLeaser()` 的 cachedToken → `AccountProxyUrl`,只读,不新建锁定机制),`probeExitTimezone` 得到时区覆盖 `o.Timezone`;探测失败回退固定默认。补测试(注入假 lease + 抑制态)。
- [ ] 提交 `feat(sandbox): 开场按出口 IP 定沙箱时区`

### Task 15: 换号挑同区偏好

- [ ] 在 leaser 额度用尽换号(`excludeAccountIds`)处,加「优先同地区」偏好(需服务端支持地区筛选或客户端拿到候选号地区);若服务端暂不支持,记为 follow-up,Phase 2 先只做 Task 13–14。
- [ ] 提交或记 follow-up。

---

## 自查

- Spec 覆盖:§3 UI→Task 11;§4 结构→Task 8/9/10/11;§5 kit→Task 2/3/8;§6 时区→Task 7(P1)/13-15(P2);§7 挂载→Task 5/6/11;§8 平台→Task 1/9;§9 验证→Phase 0;§10 错误→Task 9/10/11;§11 测试→贯穿。全覆盖。
- 类型一致:`KitOptions`/`SandboxMount`/`SbxStatus` 全程同名;`generateKitInto`/`GenerateKit`/`sandboxKitDir` 签名一致;`policyAllowArgs`/`mountArgs`/`runCommandArgs` 一致。
- 无占位:各步含真实代码与命令。
