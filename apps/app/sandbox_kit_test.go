package main

import (
	"strings"
	"testing"
)

func TestInstallSbxCommandString(t *testing.T) {
	cases := map[string]string{
		"darwin":  "brew trust docker/tap && brew install docker/tap/sbx",
		"windows": "winget install -h Docker.sbx",
	}
	for goos, want := range cases {
		if got := installSbxCommandString(goos); got != want {
			t.Errorf("%s: %q want %q", goos, got, want)
		}
	}
	if got := installSbxCommandString("linux"); !strings.Contains(got, "docker-sbx") {
		t.Errorf("linux missing docker-sbx: %q", got)
	}
	if got := installSbxCommandString("plan9"); got != "" {
		t.Errorf("unsupported goos should be empty: %q", got)
	}
}

func TestKitSpecYAML(t *testing.T) {
	// schema 经真机 sbx kit validate 确认:spec.yaml + schemaVersion + kind:mixin + caps.network.allow。
	got := kitSpecYAML(defaultKitOptions(48800))
	for _, want := range []string{
		"schemaVersion: 1", "kind: mixin", "name: gfa-claude",
		"LANG: en_US.UTF-8", "TZ: America/New_York",
		"ANTHROPIC_BASE_URL: http://host.docker.internal:48800",
		"ANTHROPIC_AUTH_TOKEN: bcai-claude-proxy",
		`allow: [ "localhost:48800" ]`,
		"commands:", "locale-gen en_US.UTF-8", // 创建时自动生成 locale,消除 LANG 警告
	} {
		if !strings.Contains(got, want) {
			t.Errorf("kitSpecYAML missing %q\n---\n%s", want, got)
		}
	}
	if strings.Contains(got, "ANTHROPIC_MODEL") {
		t.Error("default kit should not set ANTHROPIC_MODEL")
	}
}

func TestKitSpecYAMLCustomModel(t *testing.T) {
	o := KitOptions{
		Lang: "en_US.UTF-8", Timezone: "America/New_York",
		BaseURL: "https://ark.cn-beijing.volces.com/api/plan", AuthToken: "ark-x",
		Model: "kimi-k2.6", NetworkAllow: "ark.cn-beijing.volces.com",
	}
	got := kitSpecYAML(o)
	for _, want := range []string{
		"ANTHROPIC_BASE_URL: https://ark.cn-beijing.volces.com/api/plan",
		"ANTHROPIC_AUTH_TOKEN: ark-x",
		"ANTHROPIC_MODEL: kimi-k2.6",
		`allow: [ "ark.cn-beijing.volces.com" ]`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("custom kitSpecYAML missing %q\n---\n%s", want, got)
		}
	}
}

func TestHostFromURL(t *testing.T) {
	cases := map[string]string{
		"https://ark.cn-beijing.volces.com/api/plan": "ark.cn-beijing.volces.com",
		"http://host.docker.internal:48800":          "host.docker.internal:48800",
		"not a url":                                  "",
	}
	for in, want := range cases {
		if got := hostFromURL(in); got != want {
			t.Errorf("hostFromURL(%q)=%q want %q", in, got, want)
		}
	}
}

func TestPolicyAllowArgs(t *testing.T) {
	got := policyAllowArgs("localhost:48800")
	want := []string{"policy", "allow", "network", "localhost:48800"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("got %v want %v", got, want)
	}
}

func TestIsDangerousMount(t *testing.T) {
	home := "/Users/alice"
	cases := []struct {
		path string
		want bool
	}{
		{"/Users/alice", true},
		{"/", true},
		{"/System", true},
		{"/Users/alice/proj", false},
		{"/tmp/work", false},
	}
	for _, c := range cases {
		if got := isDangerousMount(c.path, home); got != c.want {
			t.Errorf("isDangerousMount(%q)=%v want %v", c.path, got, c.want)
		}
	}
}

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

func TestCreateCommandArgs(t *testing.T) {
	// create --name --kit claude <挂载...>:后台建 box 用,不带 --(skipPerms 属进入时)。
	got := createCommandArgs("gfa-claude-proj", "/kits/gfa", []SandboxMount{{Path: "/proj"}, {Path: "/refs", ReadOnly: true}})
	want := []string{"create", "--name", "gfa-claude-proj", "--kit", "/kits/gfa", "claude", "/proj", "/refs:ro"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("got %v want %v", got, want)
	}
}

func TestEnterCommandString(t *testing.T) {
	// box 已建好,进入只需 sbx run --name;工作区/kit 都从 spec 读,不再重复传。
	if got := enterCommandString("gfa-claude-proj", false); got != "SBX_NO_TELEMETRY=1 sbx run --name gfa-claude-proj" {
		t.Errorf("got %q", got)
	}
	if got := enterCommandString("gfa-claude-proj", true); got != "SBX_NO_TELEMETRY=1 sbx run --name gfa-claude-proj -- --dangerously-skip-permissions" {
		t.Errorf("skipPerms got %q", got)
	}
	// 名字含特殊字符要引用(防 shell 拆坏);gfa-claude- 前缀名本身安全,故构造一个越界名验引用。
	if got := enterCommandString("gfa claude", false); got != "SBX_NO_TELEMETRY=1 sbx run --name 'gfa claude'" {
		t.Errorf("quote got %q", got)
	}
}

func TestSandboxSource(t *testing.T) {
	cases := map[string]string{
		"gfa-claude-proj-abc123": "cli",
		"gfa-vscode-domio-def456": "vscode",
		"gfa-kimi-x":              "other",
	}
	for name, want := range cases {
		if got := sandboxSource(name); got != want {
			t.Errorf("sandboxSource(%q)=%q want %q", name, got, want)
		}
	}
}

func TestSandboxLabel(t *testing.T) {
	// 有工作区 → 用目录名(最可读)
	if got := sandboxLabel("gfa-claude-timer-java-fda3f9", "/Users/a/huohua/timer-java"); got != "timer-java" {
		t.Errorf("with workspace got %q", got)
	}
	// 无工作区 → 去前缀留主体
	if got := sandboxLabel("gfa-vscode-domio-b20f97", ""); got != "domio-b20f97" {
		t.Errorf("no workspace got %q", got)
	}
}

func TestSandboxName(t *testing.T) {
	a := sandboxName([]SandboxMount{{Path: "/Users/a/my-proj"}})
	if !strings.HasPrefix(a, "gfa-claude-my-proj-") {
		t.Errorf("bad name %q", a)
	}
	// 同一路径 → 名字稳定(复用同沙箱)
	if a != sandboxName([]SandboxMount{{Path: "/Users/a/my-proj"}}) {
		t.Error("same path must be stable")
	}
	// 不同路径、同 basename → 哈希后缀不同 → 不撞
	if a == sandboxName([]SandboxMount{{Path: "/other/my-proj"}}) {
		t.Error("different paths with same basename must not collide")
	}
	if got := sandboxName(nil); !strings.HasPrefix(got, "gfa-claude-default-") {
		t.Errorf("empty mounts got %q", got)
	}
}

func TestIsGfaManagedSandbox(t *testing.T) {
	for _, ok := range []string{"gfa-claude-x", "gfa-kimi-domio", "gfa-anything"} {
		if !isGfaManagedSandbox(ok) {
			t.Errorf("%q should be managed", ok)
		}
	}
	// 用户自己 sbx run 起的(claude-<workdir> 等非 gfa- 前缀)绝不能被判为托管 → 冰茶不误杀。
	for _, no := range []string{"claude-userproj", "my-sandbox", "gfaclaude"} {
		if isGfaManagedSandbox(no) {
			t.Errorf("%q must NOT be treated as managed", no)
		}
	}
}

func TestDefaultKitOptions(t *testing.T) {
	o := defaultKitOptions(48800)
	if o.Lang != "en_US.UTF-8" || o.Timezone != "America/New_York" ||
		o.AuthToken != "bcai-claude-proxy" || o.BaseURL != "http://host.docker.internal:48800" ||
		o.NetworkAllow != "localhost:48800" || o.Model != "" {
		t.Errorf("bad defaults: %+v", o)
	}
}

func TestUSTimezonesNonEmpty(t *testing.T) {
	tz := usTimezones()
	if len(tz) == 0 || tz[0] != "America/New_York" {
		t.Errorf("usTimezones bad: %v", tz)
	}
}
