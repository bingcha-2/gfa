package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	selfAccountDPAPIPrefix = "BSAD1"
	selfAccountAESPrefix   = "BSAA1"
	selfAccountKeyService  = "BingchaAI Self Accounts"
	selfAccountKeyName     = "vault-v1"
)

func protectSelfAccountVault(plain []byte) ([]byte, error) {
	if runtime.GOOS == "windows" {
		protected, err := selfAccountDPAPI("protect", plain)
		if err != nil {
			return nil, err
		}
		return append([]byte(selfAccountDPAPIPrefix), protected...), nil
	}
	key, err := selfAccountVaultKey(true)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	sealed := gcm.Seal(nil, nonce, plain, []byte(selfAccountAESPrefix))
	out := append([]byte(selfAccountAESPrefix), nonce...)
	return append(out, sealed...), nil
}

func unprotectSelfAccountVault(protected []byte) ([]byte, error) {
	switch {
	case bytes.HasPrefix(protected, []byte(selfAccountDPAPIPrefix)):
		if runtime.GOOS != "windows" {
			return nil, fmt.Errorf("此账号库由 Windows 当前用户加密，无法在本机解密")
		}
		return selfAccountDPAPI("unprotect", protected[len(selfAccountDPAPIPrefix):])
	case bytes.HasPrefix(protected, []byte(selfAccountAESPrefix)):
		key, err := selfAccountVaultKey(false)
		if err != nil {
			return nil, err
		}
		block, err := aes.NewCipher(key)
		if err != nil {
			return nil, err
		}
		gcm, err := cipher.NewGCM(block)
		if err != nil {
			return nil, err
		}
		payload := protected[len(selfAccountAESPrefix):]
		if len(payload) < gcm.NonceSize() {
			return nil, fmt.Errorf("本地账号库已损坏")
		}
		return gcm.Open(nil, payload[:gcm.NonceSize()], payload[gcm.NonceSize():], []byte(selfAccountAESPrefix))
	default:
		return nil, fmt.Errorf("无法识别本地账号库格式")
	}
}

func selfAccountDPAPI(operation string, data []byte) ([]byte, error) {
	script := `$ErrorActionPreference='Stop'
$null=Add-Type -AssemblyName System.Security
$raw=[Convert]::FromBase64String([Console]::In.ReadToEnd())
$entropy=[Text.Encoding]::UTF8.GetBytes('BingchaAI.self-accounts.v1')
if ($env:BCAI_DPAPI_OPERATION -eq 'protect') {
  $result=[System.Security.Cryptography.ProtectedData]::Protect($raw,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
} else {
  $result=[System.Security.Cryptography.ProtectedData]::Unprotect($raw,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
}
[Console]::Out.Write([Convert]::ToBase64String($result))`
	cmd := hideCmd("powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.Env = append(os.Environ(), "BCAI_DPAPI_OPERATION="+operation)
	cmd.Stdin = strings.NewReader(base64.StdEncoding.EncodeToString(data))
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("无法使用 Windows 当前用户加密本地账号: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(out)))
	if err != nil {
		return nil, fmt.Errorf("Windows 本地账号加密结果无效")
	}
	return decoded, nil
}

func selfAccountVaultKey(create bool) ([]byte, error) {
	if runtime.GOOS == "darwin" && !appActionsSuppressed() {
		out, err := exec.Command("security", "find-generic-password", "-s", selfAccountKeyService, "-a", selfAccountKeyName, "-w").CombinedOutput()
		if err == nil {
			key, decodeErr := base64.StdEncoding.DecodeString(strings.TrimSpace(string(out)))
			if decodeErr == nil && len(key) == 32 {
				return key, nil
			}
			return nil, fmt.Errorf("自有账号 Keychain 密钥格式无效")
		}
		if !create {
			return nil, fmt.Errorf("无法从 macOS Keychain 读取自有账号密钥")
		}
		key := make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			return nil, err
		}
		encoded := base64.StdEncoding.EncodeToString(key)
		if out, err = exec.Command("security", "add-generic-password", "-U", "-s", selfAccountKeyService, "-a", selfAccountKeyName, "-w", encoded).CombinedOutput(); err != nil {
			return nil, fmt.Errorf("无法写入 macOS Keychain: %s", strings.TrimSpace(string(out)))
		}
		return key, nil
	}

	// Linux 以及 Go 测试使用权限受限的随机密钥文件。Windows 正常运行走 DPAPI。
	path := filepath.Join(getAppDataDir(), "self-accounts.key")
	if runtime.GOOS != "windows" {
		info, err := os.Lstat(path)
		if err == nil {
			if info.Mode()&os.ModeSymlink != 0 {
				return nil, fmt.Errorf("本地账号密钥不能使用符号链接")
			}
			if !info.Mode().IsRegular() {
				return nil, fmt.Errorf("本地账号密钥不是普通文件")
			}
			if info.Mode().Perm() != 0o600 {
				if err := os.Chmod(path, 0o600); err != nil {
					return nil, fmt.Errorf("无法收紧本地账号密钥权限: %w", err)
				}
			}
		} else if !os.IsNotExist(err) {
			return nil, err
		}
	}
	if data, err := os.ReadFile(path); err == nil {
		decoded, decodeErr := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
		if decodeErr == nil && len(decoded) == 32 {
			return decoded, nil
		}
		return nil, fmt.Errorf("本地账号密钥格式无效")
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	if !create {
		return nil, fmt.Errorf("本地账号密钥不存在")
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if err := writeFileAtomic(path, []byte(base64.StdEncoding.EncodeToString(key)), 0o600); err != nil {
		return nil, err
	}
	return key, nil
}
