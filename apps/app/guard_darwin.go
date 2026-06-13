//go:build darwin

package main

import (
	"os"
	"syscall"
	"unsafe"
)

func detectDebugger() bool {
	// 方法1: sysctl kern.proc.pid 检查 P_TRACED 标志
	var info struct {
		_    [4]byte  // kp_proc.p_forw (unused)
		_    [4]byte  // kp_proc.p_back (unused)
		_    [648]byte // padding to p_flag
		Flag int32
		_    [256]byte
	}
	mib := [4]int32{1, 14, 1, int32(os.Getpid())} // CTL_KERN, KERN_PROC, KERN_PROC_PID
	size := uintptr(unsafe.Sizeof(info))
	_, _, errno := syscall.Syscall6(
		syscall.SYS___SYSCTL,
		uintptr(unsafe.Pointer(&mib[0])),
		4,
		uintptr(unsafe.Pointer(&info)),
		uintptr(unsafe.Pointer(&size)),
		0, 0,
	)
	if errno == 0 && info.Flag&0x800 != 0 { // P_TRACED
		return true
	}

	// 方法2: ptrace(PT_DENY_ATTACH)
	_, _, errno = syscall.Syscall(
		syscall.SYS_PTRACE,
		31, // PT_DENY_ATTACH
		0, 0,
	)
	return errno != 0
}
