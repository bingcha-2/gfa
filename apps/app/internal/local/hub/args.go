package hub

import (
	"strings"

	"bcai-wails/internal/local/instance"
)

// BuildInstanceLaunchArgs 构造启动参数(--user-data-dir 隔离 + 额外参数)。
// macOS open vs 直接 exec 的差异由 Platform.LaunchApp(package main)处理。
func BuildInstanceLaunchArgs(p *instance.Profile) []string {
	args := []string{"--user-data-dir=" + p.UserDataDir}
	args = append(args, strings.Fields(p.ExtraArgs)...)
	return args
}
