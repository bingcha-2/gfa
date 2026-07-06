package main

import (
	"encoding/json"
	"strings"
	"testing"
)

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
		if strings.Join(args, "\x00") != strings.Join(want.args, "\x00") {
			t.Errorf("%s: args=%v want %v", goos, args, want.args)
		}
	}
	if _, _, err := installSbxCommand("plan9"); err == nil {
		t.Errorf("expected error for unsupported goos")
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
