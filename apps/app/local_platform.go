package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"bcai-wails/internal/local/antigravityinject"
	"bcai-wails/internal/local/codexinject"
	"bcai-wails/internal/local/hub"
)

// localPlatform 实现 hub.Platform —— 把 package main 的接管注入 / app 检测 /
// 进程启停桥给 internal/local/hub。这是本地接管唯一需要留在 package main 的平台胶水。
type localPlatform struct{}

// CodexInjectAccount 把一份自有号写进 ~/.codex/auth.json,真 codex CLI 直连 OpenAI(注入式接管)。
// 这与反代(cliproxy 网关)无关——反代是单独功能,由反代 tab 独立开关。
func (localPlatform) CodexInjectAccount(tok hub.CodexToken) error {
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

// AntigravityInjectAccount 把一份自有号 token 直接写进 Antigravity IDE 的
// state.vscdb(对齐 cockpit),让 IDE 以该号官方登录态运行——不经任何网关。
func (localPlatform) AntigravityInjectAccount(tok hub.AntigravityToken) error {
	dbPath, err := antigravityStateDBPath()
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

// AntigravityRestoreAccount 移除 IDE 的注入登录态(state.vscdb)。
func (localPlatform) AntigravityRestoreAccount() error {
	dbPath, err := antigravityStateDBPath()
	if err != nil {
		// IDE 未安装或库不存在时,还原视为无操作。
		return nil
	}
	return antigravityinject.RestorePath(dbPath)
}

// CodexAuthJSONPath 返回本机 ~/.codex/auth.json 路径(本地导入用)。
func (localPlatform) CodexAuthJSONPath() string {
	return filepath.Join(codexHomeDir(), "auth.json")
}

// AntigravityReadIDEToken 读当前 Antigravity IDE(state.vscdb)里注入/登录的自有号
// 登录态(从已装 IDE 同步号用);解码 antigravityUnifiedStateSync.oauthToken 等。
func (localPlatform) AntigravityReadIDEToken() (hub.AntigravityToken, error) {
	dbPath, err := antigravityStateDBPath()
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
func antigravityStateDBPath() (string, error) {
	var base string
	switch runtime.GOOS {
	case "darwin":
		base = filepath.Join(os.Getenv("HOME"), "Library", "Application Support", "Antigravity IDE", "User", "globalStorage")
	case "windows":
		appdata := os.Getenv("APPDATA")
		if appdata == "" {
			appdata = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Roaming")
		}
		base = filepath.Join(appdata, "Antigravity IDE", "User", "globalStorage")
	default:
		base = filepath.Join(os.Getenv("HOME"), ".config", "Antigravity IDE", "User", "globalStorage")
	}
	path := filepath.Join(base, "state.vscdb")
	if _, err := os.Stat(path); err != nil {
		return "", fmt.Errorf("Antigravity IDE 数据库不存在: %s", path)
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
