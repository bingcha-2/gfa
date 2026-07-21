//go:build !windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
)

// scheduleRestartAfterExit 使用参数位置传递路径，避免把路径拼进 shell 脚本。
// macOS 优先通过 open 启动 app bundle，其余平台直接启动可执行文件。
func scheduleRestartAfterExit(exePath string) error {
	appBundlePath := findAppBundlePath(exePath)
	script := `while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
if [ -n "$2" ]; then
  exec open -a "$2"
fi
cd "$3" || exit 1
exec "$4"`
	cmd := exec.Command(
		"sh", "-c", script, "gfa-restart-helper",
		strconv.Itoa(os.Getpid()), appBundlePath, filepath.Dir(exePath), exePath,
	)
	return cmd.Start()
}
