package main

import (
	"crypto/sha1"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func legacyDesktopDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".bcai", "mitm")
}
func legacyDesktopActive() bool {
	_, err := os.Stat(filepath.Join(legacyDesktopDir(), ".takeover_active"))
	return err == nil
}

// Cleanup only: no certificate generation, installation, interception or login
// emulation remains. A failed trust-store removal keeps ca.crt for a later retry.
func cleanupLegacyDesktopMarker() error {
	dir := legacyDesktopDir()
	var failures []error
	for _, name := range []string{".takeover_active", "ca.key"} {
		if err := os.Remove(filepath.Join(dir, name)); err != nil && !os.IsNotExist(err) {
			failures = append(failures, err)
		}
	}
	certPath := filepath.Join(dir, "ca.crt")
	data, err := os.ReadFile(certPath)
	if os.IsNotExist(err) {
		return errors.Join(failures...)
	}
	if err != nil {
		return err
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return fmt.Errorf("旧 CA 文件损坏: %s", certPath)
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return err
	}
	sum := sha1.Sum(cert.Raw)
	fingerprint := hex.EncodeToString(sum[:])
	switch runtime.GOOS {
	case "darwin":
		home, _ := os.UserHomeDir()
		for _, store := range []string{filepath.Join(home, "Library", "Keychains", "login.keychain-db"), "/Library/Keychains/System.keychain"} {
			out, e := hideCmd("security", "find-certificate", "-a", "-Z", store).CombinedOutput()
			if e != nil {
				failures = append(failures, fmt.Errorf("读取旧证书存储: %w", e))
				continue
			}
			if !strings.Contains(strings.ToLower(string(out)), fingerprint) {
				continue
			}
			if out, e = hideCmd("security", "delete-certificate", "-Z", fingerprint, store).CombinedOutput(); e != nil {
				failures = append(failures, fmt.Errorf("请在钥匙串移除旧 BingchaAI Local Root 证书 (%s): %s", fingerprint, strings.TrimSpace(string(out))))
			}
		}
	case "windows":
		for _, scope := range [][]string{{"-user"}, {}} {
			args := append(append([]string{}, scope...), "-store", "Root", fingerprint)
			if out, e := hideCmd("certutil", args...).CombinedOutput(); e != nil {
				message := strings.ToLower(string(out))
				if !strings.Contains(message, "0x80092004") && !strings.Contains(message, "0x80070002") {
					failures = append(failures, fmt.Errorf("无法检查旧证书存储: %w", e))
				}
				continue
			}
			args = append(append([]string{}, scope...), "-delstore", "Root", fingerprint)
			if _, e := hideCmd("certutil", args...).CombinedOutput(); e != nil {
				failures = append(failures, fmt.Errorf("请移除旧 BingchaAI Local Root 证书 (%s): %w", fingerprint, e))
			}
		}
	}
	if len(failures) == 0 {
		if err = os.Remove(certPath); err != nil && !os.IsNotExist(err) {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
