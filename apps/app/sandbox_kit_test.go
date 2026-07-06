package main

import (
	"encoding/json"
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
	got := runCommandArgs("gfa-claude-proj", "/kits/gfa", []SandboxMount{{Path: "/proj"}})
	want := []string{"run", "--name", "gfa-claude-proj", "--kit", "/kits/gfa", "claude", "/proj"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("got %v want %v", got, want)
	}
}

func TestRunCommandString(t *testing.T) {
	got := runCommandString("gfa-claude-proj", "/kits/gfa", []SandboxMount{{Path: "/proj"}})
	if got != "sbx run --name gfa-claude-proj --kit /kits/gfa claude /proj" {
		t.Errorf("got %q", got)
	}
}

func TestSandboxName(t *testing.T) {
	if got := sandboxName([]SandboxMount{{Path: "/Users/a/my-proj"}}); got != "gfa-claude-my-proj" {
		t.Errorf("got %q", got)
	}
	if got := sandboxName([]SandboxMount{{Path: "/Users/a/my proj!"}}); got != "gfa-claude-my-proj-" {
		t.Errorf("sanitize failed: %q", got)
	}
	if got := sandboxName(nil); got != "gfa-claude-default" {
		t.Errorf("empty mounts got %q", got)
	}
}

func TestIsGfaManagedSandbox(t *testing.T) {
	if !isGfaManagedSandbox("gfa-claude-x") {
		t.Error("gfa-claude-x should be managed")
	}
	// 用户自己 sbx run 起的默认名(claude-<workdir>)绝不能被判为托管 → 冰茶不会误杀。
	if isGfaManagedSandbox("claude-userproj") {
		t.Error("user's own sandbox must NOT be treated as managed")
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
