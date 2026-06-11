//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Windows 下接管 Claude 桌面端：
//   - Code/Cowork 的 Node 子进程：靠重启注入的 NODE_EXTRA_CA_CERTS 即信任 MITM 证书，
//     不依赖系统证书库；
//   - 但桌面端 Chromium UI(登录页/升级墙/claude.ai 订阅改写)只信【系统证书库】，
//     不读 NODE_EXTRA_CA_CERTS。要让 entitlement/付费墙改写够得着 Chromium 侧，必须把
//     根 CA 装进「受信任的根证书颁发机构」，否则 Chromium 对 MITM 叶证书报
//     NET::ERR_CERT_AUTHORITY_INVALID、聊天/升级墙整页打不开。
//
// 装进 CurrentUser\Root(`certutil -user`)而非 LocalMachine：免管理员/UAC，Chromium
// (Electron)同样信任当前用户根存储。首次安装 Windows 会弹一次「安全警告 / 是否安装此
// 证书」确认框(与 macOS 弹一次管理员授权对应)；已装则 mitmIsCAInstalled 跳过，不再弹。
//
// Windows 无 macOS 的 LaunchServices/TCC 限制，直接 exec 二进制带 env 即可，子进程默认
// 继承父进程环境（参考 reclaude cmd/launcher）。

// argv 构造与输出判定抽在 mitm_ca_certutil.go(纯逻辑,跨平台单测覆盖);此处只负责
// 执行 certutil(hideCmd 防黑框)并把结果接回去。

// mitmInstallCA 四级降级安装根 CA,返回安装结局(caInstallResult)供上层决定前端提示:
//
//	Level 1  certutil -addstore Root            直接写【本机】库(已以管理员运行时无弹窗)→ caInstalledMachine
//	Level 2  PowerShell -Verb RunAs certutil    UAC 提权写【本机】库(弹一次 UAC)        → caInstalledMachine
//	Level 3  certutil -user -addstore Root       静默写【当前用户】库(免管理员/免 UAC)    → caInstalledUser
//	Level 4  全部失败(多为安全软件主动防御拦截)                                          → caInstallFailed + err
//
// 设计要点:本机库永远首选(所有 Chromium 必信);仅在本机库直接 + 提权都失败时才降级用户库。
// 用户库在少数精简版/企业组策略机器上不被 Chromium 信任 → claude.ai 白屏,故返回 caInstalledUser
// 让上层提示用户「白屏请关安全软件 / 管理员运行后重新接管」。Level 4 仍不阻塞接管(Node 侧靠
// NODE_EXTRA_CA_CERTS 照走号池),只是订阅等级改写不到 Chromium。
func mitmInstallCA(certPath string) (caInstallResult, error) {
	if _, err := os.Stat(certPath); err != nil {
		return caInstallFailed, fmt.Errorf("CA cert not found: %s", certPath)
	}
	// Level 1: 直接装本机库(bcai 已以管理员运行时成功,无额外弹窗)。
	out, err := hideCmd("certutil", certutilAddRootArgs(certPath)...).CombinedOutput()
	if err == nil {
		return caInstalledMachine, nil
	}
	directMsg := strings.TrimSpace(string(out))

	// Level 2: 未提权 → 经 UAC 提权写【本机】根存储(LocalMachine\Root)。
	out2, err2 := mitmInstallCAElevated(certPath)
	if err2 == nil {
		return caInstalledMachine, nil
	}
	elevMsg := strings.TrimSpace(string(out2))
	Log("[mitm] 本机库安装根 CA 失败(直接=%v[%s]; 提权=%v[%s]),降级尝试当前用户库…",
		err, directMsg, err2, elevMsg)

	// Level 3: 静默写【当前用户】根存储(CurrentUser\Root),免管理员、免 UAC。
	out3, err3 := hideCmd("certutil", certutilAddUserRootArgs(certPath)...).CombinedOutput()
	if err3 == nil {
		Log("[mitm] 根 CA 已降级安装到当前用户根存储(免管理员;少数机器 Chromium 可能不信任 → 需提示)")
		return caInstalledUser, nil
	}

	// Level 4: 本机库 + 用户库均失败。
	return caInstallFailed, fmt.Errorf("certutil -addstore Root: 本机库直接=%v(%s); 本机库提权=%v(%s); 用户库=%v(%s)",
		err, directMsg, err2, elevMsg, err3, strings.TrimSpace(string(out3)))
}

// mitmInstallCAElevated 经 PowerShell Start-Process -Verb RunAs 提权运行 certutil,把根 CA
// 写进【本机】根存储。弹一次 UAC;用户拒绝/失败则返回错误(上层闸门据此降级、不带 --proxy-server)。
func mitmInstallCAElevated(certPath string) ([]byte, error) {
	q := strings.ReplaceAll(certPath, "'", "''") // 路径放进 PS 单引号串,内部单引号按 PS 规则双写
	ps := fmt.Sprintf(
		`$ErrorActionPreference='Stop'; $p = Start-Process -FilePath 'certutil.exe' -ArgumentList @('-f','-addstore','Root','%s') -Verb RunAs -PassThru -Wait -WindowStyle Hidden; exit $p.ExitCode`,
		q,
	)
	return hideCmd("powershell", "-NoProfile", "-Command", ps).CombinedOutput()
}

func mitmUninstallCA() error {
	out, err := hideCmd("certutil", certutilDelRootArgs(mitmCACommonName)...).CombinedOutput()
	if err != nil && !certutilDeleteErrBenign(out) {
		return fmt.Errorf("certutil -delstore Root: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func mitmIsCAInstalled() bool {
	// 按【当前 ca.crt 的指纹】核对,而非仅按 CN —— 否则同名孤儿根会误判已装、回归白屏
	// (见 mitm_ca_fingerprint.go)。读不到当前 ca.crt 时当作未装(随后会生成 + 安装)。
	tp, err := mitmCASHA1FromFile(mitmCACertPath())
	if err != nil || tp == "" {
		return false
	}
	// ① 先查【本机】库(首选安装位置)。按 CN 列出同名根,核对是否含当前指纹(孤儿指纹不同 → 不命中)。
	out, runErr := hideCmd("certutil", certutilQueryRootArgs(mitmCACommonName)...).CombinedOutput()
	if certutilQueryShowsThumbprint(out, runErr, tp) {
		return true
	}
	// ② 本机库没有 → 再查【当前用户】库,覆盖 mitmInstallCA 的 Level 3 降级安装。
	out2, runErr2 := hideCmd("certutil", certutilQueryUserRootArgs(mitmCACommonName)...).CombinedOutput()
	return certutilQueryShowsThumbprint(out2, runErr2, tp)
}

// mitmCAInUserStore 判断【当前 ca.crt】是否就装在【当前用户】根存储里(按指纹核对)。
// 用于在清理遗留用户库孤儿根之前做保护:若当前 CA 正是 mitmInstallCA 的 Level 3 降级装进用户库的,
// 则绝不能再按 CN 删用户库(会把我们刚装的一并删掉 → 用户库瞬间无证书 → 白屏/无 Max)。
func mitmCAInUserStore() bool {
	tp, err := mitmCASHA1FromFile(mitmCACertPath())
	if err != nil || tp == "" {
		return false
	}
	out, runErr := hideCmd("certutil", certutilQueryUserRootArgs(mitmCACommonName)...).CombinedOutput()
	return certutilQueryShowsThumbprint(out, runErr, tp)
}

// mitmCleanupLegacyUserCA 删除 9.2.2 及更早遗留在【当前用户】根存储的 CA(现已迁本机库)。
// 找不到=本就没有=幂等成功;其它错误返回(调用方仅记日志,不阻塞接管)。无需管理员。
// ⚠ 调用方须先用 mitmCAInUserStore() 守护:当前 CA 若降级装在用户库,删除会误伤,绝不能调本函数。
func mitmCleanupLegacyUserCA() error {
	out, err := hideCmd("certutil", certutilDelUserRootArgs(mitmCACommonName)...).CombinedOutput()
	if err == nil || certutilDeleteErrBenign(out) {
		return nil
	}
	return fmt.Errorf("certutil -user -delstore Root: %v: %s", err, strings.TrimSpace(string(out)))
}

// detectClaudeDesktopPathAuto 自动检测 Claude Desktop 安装路径。
// 按优先级:文件系统(Squirrel 根 shim + app-* 子目录、MS Store、传统路径)→ 注册表
// (HKCU/HKLM 自定义安装位置)→ 运行进程嗅探(兜底)。
//
// 重要:前两类(文件系统 + 注册表)都「与运行状态无关」—— Claude 关着也能检测到。
// 进程嗅探仅作最后兜底;若只能靠它,就会出现「Claude 开着才显示接管、关掉就消失」的
// 死循环,所以前面的策略必须尽量把已安装(含版本化子目录)的情况覆盖全。
func detectClaudeDesktopPathAuto() string {
	la := os.Getenv("LOCALAPPDATA")
	pf := os.Getenv("ProgramFiles")

	// ── 策略 1/3/4: 纯文件系统定位(跨平台可单测,见 claude_desktop_detect.go) ──
	if p := claudeDesktopFromDirs(la, pf); p != "" {
		return p
	}

	// ── 策略 2: 注册表 InstallLocation(自定义路径/企业分发);HKCU 优先,HKLM 兜底
	// (per-machine 安装写在 HKLM,含 WOW6432Node 32 位视图)。 ──
	for _, key := range []string{
		`HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\AnthropicClaude`,
		`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\AnthropicClaude`,
		`HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\AnthropicClaude`,
	} {
		loc := registryReadValue(key, "InstallLocation")
		if loc == "" {
			continue
		}
		// InstallLocation 指向安装根目录;同样支持根 exe 与 app-* 版本子目录。
		for _, name := range []string{"claude.exe", "Claude.exe"} {
			if exe := filepath.Join(loc, name); statIsFile(exe) {
				return exe
			}
		}
		for _, name := range []string{"claude.exe", "Claude.exe"} {
			if m, _ := filepath.Glob(filepath.Join(loc, "app-*", name)); len(m) > 0 {
				return m[len(m)-1]
			}
		}
	}

	// ── 策略 5: 运行进程嗅探(最后兜底,仅 Claude 正在运行时有效) ──
	if out, err := hideCmd("wmic", "process", "where",
		"name='claude.exe'", "get", "ExecutablePath", "/value").Output(); err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "ExecutablePath=") {
				if p := strings.TrimSpace(strings.TrimPrefix(line, "ExecutablePath=")); p != "" {
					return p
				}
			}
		}
	}

	return ""
}

func mitmKillClaudeWindows() {
	// hideCmd：taskkill 否则会闪一个控制台黑框(本进程是 GUI Wails app)。
	_ = hideCmd("taskkill", "/IM", "Claude.exe", "/F").Run()
	time.Sleep(2 * time.Second)
}

func mitmRelaunchClaudeWithProxy(proxyAddr, caCertPath string, chromiumProxy bool) error {
	bin := detectClaudeDesktopPath()
	if bin == "" {
		return fmt.Errorf("未找到 Claude Desktop (Claude.exe)")
	}
	// 防御:store 版无法带代理重启(AppX 沙箱拒 env/argv,CreateProcess 撞 Access denied)。
	// 在【杀进程之前】返回,绝不白杀用户正在运行的 Claude。正常路径上 takeover.go 已提前拦下 store 版,
	// 这里是双保险,防止其它调用点漏判。
	if isMicrosoftStoreClaude(bin) {
		return fmt.Errorf("store 版 Claude Desktop 无法注入代理环境重启(AppX 沙箱)")
	}
	mitmKillClaudeWindows()
	// 启动 Claude.exe 用裸 exec.Command：它是 GUI 进程，不能用 hideCmd(HideWindow 会把
	// 主窗口一起隐藏)。Squirrel 根 stub 会把参数转发给真 Electron 进程,故直接用检测到的 bin。
	// ① cmd.Env 给 Node 子进程(推理),永远设;② --proxy-server 给 Chromium,仅 CA 可信时加
	// (chromiumProxy)—— 否则 claude.ai 被 MITM 却信不过证书会白屏。
	argv := claudeMitmRelaunchArgv(bin, proxyAddr, chromiumProxy)
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = mitmProxyEnv(os.Environ(), proxyAddr, caCertPath)
	return cmd.Start()
}

func mitmRelaunchClaudePlain() error {
	bin := detectClaudeDesktopPath()
	if bin == "" {
		return fmt.Errorf("未找到 Claude Desktop (Claude.exe)")
	}
	mitmKillClaudeWindows()
	return exec.Command(bin).Start()
}

// mitmOpenCACertForTrust 打开证书的「证书信息」对话框(含"安装证书…"向导入口),供用户手动安装/信任。
// 仅作自动安装失败后的兜底;Windows 正常走 certutil 静默装当前用户库,通常用不到。
func mitmOpenCACertForTrust() error {
	cert := mitmCACertPath()
	if _, err := os.Stat(cert); err != nil {
		return fmt.Errorf("CA cert not found: %s", cert)
	}
	return exec.Command("rundll32.exe", "cryptext.dll,CryptExtAddCER", cert).Run()
}
