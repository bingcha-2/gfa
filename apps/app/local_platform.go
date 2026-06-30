package main

import (
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// localPlatform 实现 hub.Platform —— 把 package main 的接管注入 / app 检测 /
// 进程启停桥给 internal/local/hub。这是本地接管唯一需要留在 package main 的平台胶水。
type localPlatform struct{}

func (localPlatform) CodexInject(port int) error {
	if err := InjectCodexSettings(port); err != nil {
		return err
	}
	return InjectFakeCodexAuth()
}

func (localPlatform) CodexRestore() error {
	_ = RestoreCodexSettings()
	_ = RestoreFakeCodexAuth()
	return nil
}

func (localPlatform) CodexInjected() bool { return IsCodexInjected() }

func (localPlatform) AntigravityIDEInject(port int) error { return InjectIDESettings(port) }

func (localPlatform) AntigravityIDERestore() error {
	_ = RestoreIDESettings()
	return nil
}

func (localPlatform) DetectAppPath(provider string) string {
	switch provider {
	case "codex":
		return detectCodexGUIPath()
	case "antigravity":
		return detectAntigravityIDEPathCached()
	}
	return ""
}

func (localPlatform) LaunchApp(appPath, workingDir string, args []string) (int, error) {
	var cmd *exec.Cmd
	if runtime.GOOS == "darwin" && strings.HasSuffix(appPath, ".app") {
		cmd = exec.Command("open", append([]string{"-n", "-a", appPath, "--args"}, args...)...)
	} else {
		cmd = exec.Command(appPath, args...)
	}
	if workingDir != "" {
		cmd.Dir = workingDir
	}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	return cmd.Process.Pid, nil
}

func (localPlatform) StopProcess(pid int) error {
	if pid <= 0 {
		return nil
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Kill()
}
