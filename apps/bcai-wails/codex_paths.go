package main

import (
	"os"
	"path/filepath"
	"runtime"
)

func detectCodexAppPath() string {
	cfg := LoadConfig()
	if cfg.CodexAppPath != "" {
		if _, err := os.Stat(cfg.CodexAppPath); err == nil {
			return cfg.CodexAppPath
		}
	}

	switch runtime.GOOS {
	case "darwin":
		if p := spotlightFindApp("Codex.app"); p != "" {
			return p
		}
		if _, err := os.Stat("/Applications/Codex.app"); err == nil {
			return "/Applications/Codex.app"
		}
	case "windows":
		if loc := registryFindInstallPath("Codex"); loc != "" {
			if info, err := os.Stat(loc); err == nil {
				if info.IsDir() {
					exe := filepath.Join(loc, "Codex.exe")
					if exeInfo, exeErr := os.Stat(exe); exeErr == nil && !exeInfo.IsDir() {
						return exe
					}
				} else {
					return loc
				}
			}
		}
		localAppData := os.Getenv("LOCALAPPDATA")
		programFiles := os.Getenv("ProgramFiles")
		for _, p := range []string{
			filepath.Join(localAppData, "Programs", "Codex", "Codex.exe"),
			filepath.Join(programFiles, "Codex", "Codex.exe"),
		} {
			if p == "" {
				continue
			}
			if info, err := os.Stat(p); err == nil && !info.IsDir() {
				return p
			}
		}
	case "linux":
		if p := desktopFindApp("Codex"); p != "" {
			return p
		}
		for _, p := range []string{
			"/opt/Codex/codex",
			"/usr/share/codex/codex",
		} {
			if info, err := os.Stat(p); err == nil && !info.IsDir() {
				return p
			}
		}
	}
	return ""
}
