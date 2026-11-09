package main

import (
	"bytes"
	"os"
	"strings"
	"testing"
)

func TestCodexTakeoverModeRoundTripPreservesOriginalLogin(t *testing.T) {
	isolateCodexHome(t)
	original := []byte(`{"auth_mode":"chatgpt","tokens":{"id_token":"id","access_token":"access","refresh_token":"refresh","account_id":"personal"},"custom":"keep"}`)
	if err := os.WriteFile(codexAuthPath(), original, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(codexConfigPath(), []byte(sampleConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"account", "api", "api", "account", "api"} {
		// The production orchestration restores any previous projection before
		// deciding how to authenticate. Repeat API mode must not back up itself.
		if err := RestoreFakeCodexAuth(); err != nil {
			t.Fatal(err)
		}
		preserve, _, err := codexOAuthBridgeForMode(mode)
		if err != nil {
			t.Fatal(err)
		}
		if preserve != (mode == "account") {
			t.Fatalf("mode %s: preserve=%v", mode, preserve)
		}
		if !preserve {
			if err := InjectCodexAPIKeyAuth(); err != nil {
				t.Fatal(err)
			}
		}
		if err := InjectCodexSettings(48800, preserve); err != nil {
			t.Fatal(err)
		}
		auth, err := os.ReadFile(codexAuthPath())
		if err != nil {
			t.Fatal(err)
		}
		config, err := os.ReadFile(codexConfigPath())
		if err != nil {
			t.Fatal(err)
		}
		if mode == "api" {
			if !isCodexManagedAPIKeyAuth(auth) {
				t.Fatal("API mode must use managed API credentials")
			}
			if !strings.Contains(string(config), "requires_openai_auth = false") || !strings.Contains(string(config), `cli_auth_credentials_store = "file"`) {
				t.Fatal("API mode still depends on OAuth")
			}
			if backup := readCodexCredsBackup(); backup == nil || !bytes.Equal(backup.Prev, original) {
				t.Fatal("original login backup lost")
			}
		} else {
			if !bytes.Equal(auth, original) {
				t.Fatal("account mode did not restore original login")
			}
			if !strings.Contains(string(config), "requires_openai_auth = true") {
				t.Fatal("account mode did not restore OAuth provider")
			}
		}
	}
	if err := RestoreCodexSettings(); err != nil {
		t.Fatal(err)
	}
	if err := RestoreFakeCodexAuth(); err != nil {
		t.Fatal(err)
	}
	auth, err := os.ReadFile(codexAuthPath())
	if err != nil || !bytes.Equal(auth, original) {
		t.Fatal("stop did not restore original login")
	}
	config, err := os.ReadFile(codexConfigPath())
	if err != nil || strings.Contains(string(config), "bingchaai") || strings.Contains(string(config), "cli_auth_credentials_store") {
		t.Fatal("managed provider/store remained after stop")
	}
}

func TestCodexTakeoverAPIModeProtectsUnreadableCredentials(t *testing.T) {
	isolateCodexHome(t)
	original := []byte(`{"broken":`)
	if err := os.WriteFile(codexAuthPath(), original, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := codexOAuthBridgeForMode("api"); err == nil {
		t.Fatal("malformed login must stop API takeover")
	}
	auth, _ := os.ReadFile(codexAuthPath())
	if !bytes.Equal(auth, original) {
		t.Fatal("original credentials modified")
	}
}

func TestCodexTakeoverModeRejectsUnknownModeBeforeMutation(t *testing.T) {
	if _, err := (&App{}).InjectCodexWithMode("invalid"); err == nil {
		t.Fatal("unknown mode accepted")
	}
	if _, err := (codexTarget{authMode: "invalid"}).Inject(48800); err == nil {
		t.Fatal("unknown target mode accepted")
	}
}
