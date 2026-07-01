package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"bcai-wails/internal/local/antigravityinject"
	"bcai-wails/internal/local/codexinject"
	"bcai-wails/internal/local/hub"
)

// localPlatform 实现 hub.Platform —— 把 package main 的接管注入 / app 检测 /
// 进程启停桥给 internal/local/hub。这是本地接管唯一需要留在 package main 的平台胶水。
type localPlatform struct{}

// CodexInjectAccount 把一份自有号写进 ~/.codex/auth.json,真 codex CLI 直连 OpenAI(注入式接管)。
// 这与反代(cliproxy 网关)无关——反代是单独功能,由反代 tab 独立开关。
//
// 红线:注入自有号前先 RestoreCodexSettings 撤掉任何「远程接管」往 config.toml 写的
// 自定义 provider 重定向 —— 否则 config.toml 还指着远程租号代理,自有号凭证会经远程
// 代理出口(违反「远程/本地两条数据面互斥、自有号不经远程」)。两种接管互斥,这里强制。
func (localPlatform) CodexInjectAccount(tok hub.CodexToken) error {
	_ = RestoreCodexSettings()
	return codexinject.InjectToHome(codexHomeDir(), codexinject.Token{
		AuthKind:     tok.AuthKind,
		IDToken:      tok.IDToken,
		AccessToken:  tok.AccessToken,
		RefreshToken: tok.RefreshToken,
		AccountID:    tok.AccountID,
		APIKey:       tok.APIKey,
	})
}

// CodexRestoreAccount 还原 codex 注入前的 auth.json。
func (localPlatform) CodexRestoreAccount() error {
	return codexinject.RestoreHome(codexHomeDir())
}

// AntigravityInjectAccount 把一份自有号 token 注入 Antigravity IDE 的 state.vscdb(默认变体)。
func (localPlatform) AntigravityInjectAccount(tok hub.AntigravityToken) error {
	return localPlatform{}.AntigravityInjectAccountTo("ide", tok)
}

// AntigravityInjectAccountTo 把自有号 token 注入指定 Antigravity app 变体的 state.vscdb
// (对齐 cockpit,让该 app 以此号官方登录态运行——不经任何网关)。variant="ide"/"standalone"。
func (localPlatform) AntigravityInjectAccountTo(variant string, tok hub.AntigravityToken) error {
	dbPath, err := antigravityStateDBPathForKind(antigravityKindFromVariant(variant))
	if err != nil {
		return err
	}
	return antigravityinject.InjectToPath(dbPath, antigravityinject.Token{
		AccessToken:  tok.AccessToken,
		RefreshToken: tok.RefreshToken,
		IDToken:      tok.IDToken,
		Email:        tok.Email,
		ProjectID:    tok.ProjectID,
		Expiry:       tok.Expiry,   // 登录时从 SDK Metadata 捕获的真实过期时刻(0=未知)
		IsGCPTos:     tok.IsGCPTos, // gmail 在注入侧恒置 false
	})
}

// AntigravityRestoreAccount 移除 IDE(默认变体)的注入登录态。
func (localPlatform) AntigravityRestoreAccount() error {
	return localPlatform{}.AntigravityRestoreAccountFor("ide")
}

// AntigravityRestoreAccountFor 移除指定变体 app 的注入登录态;未安装则视为无操作。
func (localPlatform) AntigravityRestoreAccountFor(variant string) error {
	dbPath, err := antigravityStateDBPathForKind(antigravityKindFromVariant(variant))
	if err != nil {
		return nil // 未安装或库不存在时,还原视为无操作
	}
	return antigravityinject.RestorePath(dbPath)
}

// CodexAuthJSONPath 返回本机 ~/.codex/auth.json 路径(本地导入用)。
func (localPlatform) CodexAuthJSONPath() string {
	return filepath.Join(codexHomeDir(), "auth.json")
}

// AntigravityReadIDEToken 读 IDE(默认变体)里注入/登录的自有号登录态。
func (localPlatform) AntigravityReadIDEToken() (hub.AntigravityToken, error) {
	return localPlatform{}.AntigravityReadTokenFrom("ide")
}

// AntigravityReadTokenFrom 读指定变体 app 的 state.vscdb 里注入/登录的自有号登录态
// (从已装 app 同步号用);解码 antigravityUnifiedStateSync.oauthToken 等。
func (localPlatform) AntigravityReadTokenFrom(variant string) (hub.AntigravityToken, error) {
	dbPath, err := antigravityStateDBPathForKind(antigravityKindFromVariant(variant))
	if err != nil {
		return hub.AntigravityToken{}, err
	}
	tok, err := antigravityinject.ExtractToken(dbPath)
	if err != nil {
		return hub.AntigravityToken{}, err
	}
	return hub.AntigravityToken{
		AccessToken:  tok.AccessToken,
		RefreshToken: tok.RefreshToken,
		IDToken:      tok.IDToken,
		Email:        tok.Email,
		ProjectID:    tok.ProjectID,
		Expiry:       tok.Expiry,
		IsGCPTos:     tok.IsGCPTos,
	}, nil
}

// antigravityStateDBPath 返回 Antigravity IDE globalStorage 下的 state.vscdb 路径。
// 目前默认 IDE 变体;独立版走 antigravityStateDBPathForKind(见 antigravity_apps.go)。
func antigravityStateDBPath() (string, error) {
	return antigravityStateDBPathForKind(agIDE)
}

// antigravityStateDBPathForKind 返回某 Antigravity app 变体的 state.vscdb 路径(不存在则报错)。
func antigravityStateDBPathForKind(kind antigravityAppKind) (string, error) {
	path := filepath.Join(antigravityGlobalStorageDir(kind), "state.vscdb")
	if _, err := os.Stat(path); err != nil {
		return "", fmt.Errorf("%s 数据库不存在: %s", antigravitySpec(kind).DisplayName, path)
	}
	return path, nil
}

func (localPlatform) DetectAppPath(provider string) string {
	switch provider {
	case "codex":
		return detectCodexGUIPath()
	case "antigravity":
		return detectAntigravityIDEPathCached()
	}
	return ""
}

func (localPlatform) LaunchApp(appPath, workingDir string, args []string) (int, error) {
	var cmd *exec.Cmd
	if runtime.GOOS == "darwin" && strings.HasSuffix(appPath, ".app") {
		cmd = exec.Command("open", append([]string{"-n", "-a", appPath, "--args"}, args...)...)
	} else {
		cmd = exec.Command(appPath, args...)
	}
	if workingDir != "" {
		cmd.Dir = workingDir
	}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	return cmd.Process.Pid, nil
}

func (localPlatform) StopProcess(pid int) error {
	if pid <= 0 {
		return nil
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Kill()
}

// ── Antigravity 默认实例运行时(复用 ide_inject.go 既有的探测/启停/进程检测) ──

// AntigravityStartDefault 拉起已装 Antigravity IDE(不杀进程,仅打开)。
func (localPlatform) AntigravityStartDefault() error { return LaunchIDE() }

// AntigravityStopDefault 停掉 Antigravity IDE 进程(SIGTERM,必要时 SIGKILL)。
func (localPlatform) AntigravityStopDefault() error {
	switch runtime.GOOS {
	case "darwin":
		// 锚定到 .app/Contents/MacOS 主进程,避免误杀任何 argv 里含「Antigravity IDE」的无关进程。
		killProcessesByPattern("Antigravity IDE.app/Contents/MacOS", "-TERM")
		if !waitForProcessExit(IsIDERunning, 5*time.Second) {
			killProcessesByPattern("Antigravity IDE.app/Contents/MacOS", "-9")
		}
	case "windows":
		_ = hideCmd("taskkill", "/IM", "Antigravity IDE.exe", "/T").Run()
		if !waitForProcessExit(IsIDERunning, 5*time.Second) {
			_ = hideCmd("taskkill", "/IM", "Antigravity IDE.exe", "/T", "/F").Run()
		}
	case "linux":
		_ = hideCmd("pkill", "-TERM", "-f", "antigravity-ide").Run()
		waitForProcessExit(IsIDERunning, 3*time.Second)
	}
	return nil
}

// AntigravityFocusDefault 把 Antigravity IDE 带到前台(未运行则拉起)。
func (localPlatform) AntigravityFocusDefault() error {
	idePath := detectAntigravityIDEPathCached()
	if idePath == "" {
		return fmt.Errorf("未检测到 Antigravity IDE 安装路径")
	}
	switch runtime.GOOS {
	case "darwin":
		// open -a 会聚焦已运行实例,未运行则拉起。
		return exec.Command("open", "-a", idePath).Start()
	default:
		// 其它平台:未运行则拉起(已运行时多数 IDE 会聚焦既有窗口)。
		if IsIDERunning() {
			return nil
		}
		return LaunchIDE()
	}
}

// AntigravityRuntimeRunning 返回 Antigravity IDE 是否在运行。
func (localPlatform) AntigravityRuntimeRunning() bool { return IsIDERunning() }

// ── 变体化运行时:同时支持 Antigravity IDE 与独立版 Antigravity(variant="ide"/"standalone") ──

// antigravityKindFromVariant 把 hub/前端的字符串变体映射到 app kind(未知回退 IDE)。
func antigravityKindFromVariant(variant string) antigravityAppKind {
	if variant == "standalone" || variant == "antigravity" {
		return agStandalone
	}
	return agIDE
}

func (localPlatform) AntigravityAppRunning(variant string) bool {
	return isAntigravityAppRunning(antigravityKindFromVariant(variant))
}
func (localPlatform) AntigravityAppDetected(variant string) bool {
	return detectAntigravityAppPath(antigravityKindFromVariant(variant)) != ""
}
func (localPlatform) AntigravityAppStart(variant string) error {
	return launchAntigravityApp(antigravityKindFromVariant(variant))
}
func (localPlatform) AntigravityAppStop(variant string) error {
	return stopAntigravityApp(antigravityKindFromVariant(variant))
}
func (localPlatform) AntigravityAppFocus(variant string) error {
	return focusAntigravityApp(antigravityKindFromVariant(variant))
}

// CodexRestartApp 重启常驻 Codex GUI app,让它重读 ~/.codex/auth.json(切号后生效)。
// codex CLI 每次运行自读 auth.json,无需重启;此方法仅针对常驻 GUI。未装则 no-op。
func (localPlatform) CodexRestartApp() error {
	appPath := detectCodexGUIPath()
	if appPath == "" {
		return nil
	}
	switch runtime.GOOS {
	case "darwin":
		killProcessesByPattern(codexGUIProcessPattern, "-TERM") // 锚定主进程,避免误杀
	case "windows":
		_ = hideCmd("taskkill", "/IM", "Codex.exe", "/T").Run()
	}
	_, err := localPlatform{}.LaunchApp(appPath, "", nil)
	return err
}

// RestartSpecifiedApp 杀掉并重启用户在「Codex 设置」里指定的联动应用(切号后调用)。
// appPath 形如 .app 包(darwin)或可执行文件;空 path 由调用方过滤,这里再兜一层。
// kill 锚定到从 appPath 推出的主进程,避免误杀;随后用 LaunchApp 重新拉起。
func (localPlatform) RestartSpecifiedApp(appPath string) error {
	appPath = strings.TrimSpace(appPath)
	if appPath == "" {
		return nil
	}
	switch runtime.GOOS {
	case "darwin":
		if name := strings.TrimSuffix(filepath.Base(appPath), ".app"); name != "" {
			killProcessesByPattern(name+".app/Contents/MacOS", "-TERM")
		}
	case "windows":
		if exe := filepath.Base(appPath); exe != "" {
			_ = hideCmd("taskkill", "/IM", exe, "/T").Run()
		}
	case "linux":
		if name := filepath.Base(appPath); name != "" {
			_ = hideCmd("pkill", "-TERM", "-f", name).Run()
		}
	}
	_, err := localPlatform{}.LaunchApp(appPath, "", nil)
	return err
}
