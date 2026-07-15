//go:build windows

package main

// pathOwnerUID 在 Windows 上无意义(ACL 模型,没有 POSIX uid)。返回 false 让
// takeoverPermissionHint 放弃诊断、回落到原始错误 —— 这与 Windows 上的既有行为一致。
func pathOwnerUID(string) (int, bool) { return 0, false }
