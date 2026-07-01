package main

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// 两个 Antigravity app 变体解析到各自独立的 globalStorage 目录(仅数据目录名不同)。
func TestAntigravityGlobalStorageDir_BothVariants(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Setenv("APPDATA", t.TempDir())
	} else {
		t.Setenv("HOME", t.TempDir())
	}

	ide := antigravityGlobalStorageDir(agIDE)
	standalone := antigravityGlobalStorageDir(agStandalone)

	if ide == standalone {
		t.Fatalf("两个变体不能解析到同一目录: %s", ide)
	}
	// IDE 目录段含 "Antigravity IDE";独立版含裸 "Antigravity" 段但不含 " IDE"。
	if !strings.Contains(ide, "Antigravity IDE") {
		t.Fatalf("IDE 目录应含 'Antigravity IDE',得到 %s", ide)
	}
	if strings.Contains(standalone, "Antigravity IDE") {
		t.Fatalf("独立版目录不应含 'Antigravity IDE',得到 %s", standalone)
	}
	if filepath.Base(filepath.Dir(filepath.Dir(standalone))) != "Antigravity" {
		t.Fatalf("独立版数据目录名应为 'Antigravity',得到 %s", standalone)
	}
	// 两者都以 User/globalStorage 结尾。
	for _, p := range []string{ide, standalone} {
		if filepath.Base(p) != "globalStorage" || filepath.Base(filepath.Dir(p)) != "User" {
			t.Fatalf("路径应以 User/globalStorage 结尾: %s", p)
		}
	}
}

// spec 兜底:未知变体回退到 IDE。
func TestAntigravitySpec_FallbackToIDE(t *testing.T) {
	if got := antigravitySpec(antigravityAppKind(999)); got.Kind != agIDE {
		t.Fatalf("未知变体应回退 IDE,得到 %+v", got)
	}
	if antigravitySpec(agStandalone).MacAppBundle != "Antigravity.app" {
		t.Fatalf("独立版 bundle 应为 Antigravity.app")
	}
}
