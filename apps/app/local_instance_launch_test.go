package main

import (
	"testing"

	"bcai-wails/internal/local/instance"
)

func TestBuildInstanceLaunchArgs(t *testing.T) {
	args := buildInstanceLaunchArgs(&instance.Profile{UserDataDir: "/tmp/p", ExtraArgs: "--foo --bar=1"})
	if len(args) != 3 || args[0] != "--user-data-dir=/tmp/p" || args[1] != "--foo" || args[2] != "--bar=1" {
		t.Fatalf("args wrong: %v", args)
	}
}

func TestBuildInstanceLaunchArgs_NoExtra(t *testing.T) {
	args := buildInstanceLaunchArgs(&instance.Profile{UserDataDir: "/d"})
	if len(args) != 1 || args[0] != "--user-data-dir=/d" {
		t.Fatalf("args wrong: %v", args)
	}
}

func TestInstanceAppPath_UnknownProvider(t *testing.T) {
	if instanceAppPath("nope") != "" {
		t.Fatal("unknown provider should yield empty path")
	}
}

func TestLaunchInstance_NoAppDetected(t *testing.T) {
	// 未知 provider → 无检测路径 → 明确报错(不静默)
	if _, err := launchInstance(&instance.Profile{Provider: "nope", UserDataDir: "/tmp"}); err == nil {
		t.Fatal("expected error when app not detected")
	}
}
