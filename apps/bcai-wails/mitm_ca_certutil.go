package main

import "strings"

// ─── Windows certutil 子命令构造 + 输出判定(纯逻辑,跨平台可单测)─────────────
//
// 真实 certutil 仅 Windows 有、且会真改用户证书库,故把"命令长什么样""输出怎么解读"
// 从 mitm_os_windows.go 抽出来,在 host/CI 上锁住行为(尤其 -user 这个"免管理员"关键 flag)。
// 全部走 CurrentUser 根存储(-user):免 UAC,Chromium(Electron)同样信任。

// certutilAddRootArgs: 把根 CA 装进当前用户「受信任的根证书颁发机构」。-f 已存在则覆盖。
func certutilAddRootArgs(certPath string) []string {
	return []string{"-user", "-f", "-addstore", "Root", certPath}
}

// certutilDelRootArgs: 按 CN 从当前用户根存储删除证书。
func certutilDelRootArgs(commonName string) []string {
	return []string{"-user", "-delstore", "Root", commonName}
}

// certutilQueryRootArgs: 查当前用户根存储里是否有该 CN 的证书。
func certutilQueryRootArgs(commonName string) []string {
	return []string{"-user", "-store", "Root", commonName}
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
