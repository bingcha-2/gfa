package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"

	"bcai-wails/internal/local/instance"
)

// 本地实例启动/停止。复用 GFA 既有的 app 路径检测(detectCodexGUIPath /
// detectAntigravityIDEPathCached)与启动模式(macOS open -n -a,其余直接 exec)。
//
// 真机生效:需已安装目标 app。命令构造与「未检测到 app」路径可单测;真实拉起
// 需在装有目标 app 的机器上验证。macOS 经 `open` 拉起时记录的是 open 进程 pid,
// 精确停止需 pgrep 应用进程,作后续细化。

// instanceAppPath 返回某 provider 的应用可执行/bundle 路径(未检测到返回 "")。
func instanceAppPath(provider string) string {
	switch provider {
	case "codex":
		return detectCodexGUIPath()
	case "antigravity":
		return detectAntigravityIDEPathCached()
	}
	return ""
}

// buildInstanceLaunchArgs 构造启动参数(--user-data-dir 隔离 + 额外参数)。
func buildInstanceLaunchArgs(p *instance.Profile) []string {
	args := []string{"--user-data-dir=" + p.UserDataDir}
	args = append(args, strings.Fields(p.ExtraArgs)...)
	return args
}

func launchInstance(p *instance.Profile) (int, error) {
	appPath := instanceAppPath(p.Provider)
	if appPath == "" {
		return 0, fmt.Errorf("未检测到 %s 的应用,请先安装", p.Provider)
	}
	args := buildInstanceLaunchArgs(p)

	var cmd *exec.Cmd
	if runtime.GOOS == "darwin" && strings.HasSuffix(appPath, ".app") {
		// -n 强制新实例,--args 后透传给 app(隔离 user-data-dir)
		cmd = exec.Command("open", append([]string{"-n", "-a", appPath, "--args"}, args...)...)
	} else {
		cmd = exec.Command(appPath, args...)
	}
	if p.WorkingDir != "" {
		cmd.Dir = p.WorkingDir
	}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	return cmd.Process.Pid, nil
}

func stopInstance(pid int) error {
	if pid <= 0 {
		return nil
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Kill()
}
