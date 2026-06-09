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

func mitmInstallCA(certPath string) error {
	if _, err := os.Stat(certPath); err != nil {
		return fmt.Errorf("CA cert not found: %s", certPath)
	}
	// 先直接装本机库(bcai 已以管理员运行时成功,无额外弹窗)。
	out, err := hideCmd("certutil", certutilAddRootArgs(certPath)...).CombinedOutput()
	if err == nil {
		return nil
	}
	directMsg := strings.TrimSpace(string(out))
	// 未提权 → 通过 UAC 提权单独执行 certutil 写【本机】根存储(LocalMachine\Root)。
	if out2, err2 := mitmInstallCAElevated(certPath); err2 != nil {
		return fmt.Errorf("certutil -addstore Root(本机库): 直接=%v(%s); 提权=%v(%s)",
			err, directMsg, err2, strings.TrimSpace(string(out2)))
	}
	return nil
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
	out, err := hideCmd("certutil", certutilQueryRootArgs(mitmCACommonName)...).CombinedOutput()
	return certutilQueryShowsCA(out, err, mitmCACommonName)
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
