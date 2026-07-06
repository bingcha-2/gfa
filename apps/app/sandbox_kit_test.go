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
	o := KitOptions{GatewayPort: 48800, Lang: "en_US.UTF-8", Timezone: "America/New_York", SentinelToken: "bcai-claude-proxy"}
	got := kitSpecYAML(o)
	for _, want := range []string{
		"schemaVersion: 1",
		"kind: mixin",
		"name: gfa-claude",
		"LANG: en_US.UTF-8",
		"TZ: America/New_York",
		"ANTHROPIC_BASE_URL: http://host.docker.internal:48800",
		"ANTHROPIC_AUTH_TOKEN: bcai-claude-proxy",
		`allow: [ "localhost:48800" ]`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("kitSpecYAML missing %q\n---\n%s", want, got)
		}
	}
}

func TestPolicyAllowArgs(t *testing.T) {
	got := policyAllowArgs(48800)
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

func TestRunCommandArgs(t *testing.T) {
	got := runCommandArgs("gfa-claude-proj", "/kits/gfa", []SandboxMount{{Path: "/proj"}}, false)
	want := []string{"run", "--name", "gfa-claude-proj", "--kit", "/kits/gfa", "claude", "/proj"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("got %v want %v", got, want)
	}
}

func TestRunCommandArgsSkipPerms(t *testing.T) {
	got := runCommandArgs("gfa-claude-proj", "/kits/gfa", []SandboxMount{{Path: "/proj"}}, true)
	want := []string{"run", "--name", "gfa-claude-proj", "--kit", "/kits/gfa", "claude", "/proj", "--", "--dangerously-skip-permissions"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("got %v want %v", got, want)
	}
}

func TestRunCommandString(t *testing.T) {
	got := runCommandString("gfa-claude-proj", "/kits/gfa", []SandboxMount{{Path: "/proj"}}, false)
	if got != "SBX_NO_TELEMETRY=1 sbx run --name gfa-claude-proj --kit /kits/gfa claude /proj" {
		t.Errorf("got %q", got)
	}
}

func TestRunCommandStringQuotesSpaces(t *testing.T) {
	// macOS「Application Support」带空格的 kit / 挂载路径必须加引号,否则命令被 shell 拆坏。
	got := runCommandString("gfa-claude-domio",
		"/Users/a/Library/Application Support/bcai/sandbox/gfa-claude",
		[]SandboxMount{{Path: "/Users/a/My Docs"}}, false)
	want := "SBX_NO_TELEMETRY=1 sbx run --name gfa-claude-domio --kit '/Users/a/Library/Application Support/bcai/sandbox/gfa-claude' claude '/Users/a/My Docs'"
	if got != want {
		t.Errorf("\n got %q\nwant %q", got, want)
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
