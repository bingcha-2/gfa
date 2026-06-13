//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

var (
	kernel32              = syscall.NewLazyDLL("kernel32.dll")
	ntdll                 = syscall.NewLazyDLL("ntdll.dll")
	pIsDebuggerPresent    = kernel32.NewProc("IsDebuggerPresent")
	pCheckRemoteDebugger  = kernel32.NewProc("CheckRemoteDebuggerPresent")
	pNtQueryInfoProcess   = ntdll.NewProc("NtQueryInformationProcess")
)

func detectDebugger() bool {
	// 方法1: IsDebuggerPresent (用户态调试器)
	ret, _, _ := pIsDebuggerPresent.Call()
	if ret != 0 {
		return true
	}

	// 方法2: CheckRemoteDebuggerPresent (远程/内核态调试器)
	var present int32
	handle, _ := syscall.GetCurrentProcess()
	pCheckRemoteDebugger.Call(uintptr(handle), uintptr(unsafe.Pointer(&present)))
	if present != 0 {
		return true
	}

	// 方法3: NtQueryInformationProcess — DebugPort (ProcessInformationClass=7)
	var debugPort uintptr
	pNtQueryInfoProcess.Call(
		uintptr(handle),
		7,
		uintptr(unsafe.Pointer(&debugPort)),
		unsafe.Sizeof(debugPort),
		0,
	)
	return debugPort != 0
}
