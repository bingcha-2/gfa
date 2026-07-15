//go:build !windows

package main

import (
	"os"
	"syscall"
)

// pathOwnerUID 返回 path 的属主 uid。POSIX 平台直接读 stat 的 Uid。
func pathOwnerUID(path string) (int, bool) {
	st, err := os.Stat(path)
	if err != nil {
		return 0, false
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return int(sys.Uid), true
}
