package main

import "strings"

// ─── Windows certutil 子命令构造 + 输出判定(纯逻辑,跨平台可单测)─────────────
//
// 真实 certutil 仅 Windows 有、且会真改证书库,故把"命令长什么样""输出怎么解读"
// 从 mitm_os_windows.go 抽出来,在 host/CI 上锁住行为。
//
// ⚠ 走 LocalMachine 本机根存储(不带 -user):实测部分 Windows 机器上 Claude 的 Chromium
// 不信任 CurrentUser 根存储 → claude.ai 被 MITM 后整页 ERR_CERT_AUTHORITY_INVALID → 桌面端
// 白屏。本机库对所有用户/所有进程上下文一律信任,是 Chromium 必认的根。代价是写本机库需要
// 管理员(由 mitmInstallCA 走 UAC 提权完成);装失败时上层闸门会降级、绝不带 --proxy-server。

// certutilAddRootArgs: 把根 CA 装进【本机】「受信任的根证书颁发机构」。-f 已存在则覆盖。
func certutilAddRootArgs(certPath string) []string {
	return []string{"-f", "-addstore", "Root", certPath}
}

// certutilDelRootArgs: 按 CN 从【本机】根存储删除证书。
func certutilDelRootArgs(commonName string) []string {
	return []string{"-delstore", "Root", commonName}
}

// certutilQueryRootArgs: 查【本机】根存储里是否有该 CN 的证书(读本机库无需管理员)。
func certutilQueryRootArgs(commonName string) []string {
	return []string{"-store", "Root", commonName}
}

// certutilQueryShowsCA: -store 结果判定——退出码 0(runErr==nil)且输出含目标 CN 才算已装。
func certutilQueryShowsCA(out []byte, runErr error, commonName string) bool {
	return runErr == nil && strings.Contains(string(out), commonName)
}

// certutilDeleteErrBenign: delstore 失败是否为"本就没装"(CRYPT_E_NOT_FOUND / 0x80092004)。
// 是则卸载视作成功(幂等);其它失败(如拒绝访问)应照常报错。
func certutilDeleteErrBenign(out []byte) bool {
	s := strings.ToLower(string(out))
	return strings.Contains(s, "0x80092004") || strings.Contains(s, "cannot find")
}
