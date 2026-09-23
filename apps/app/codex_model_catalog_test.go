package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"testing"
)

func TestCodexManagedCatalogRoundTrip(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	original := "model_catalog_json = 'custom.json'\nmodel = 'gpt-5.6-sol'\n"
	if err := os.WriteFile(codexConfigPath(), []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"models":[{"slug":"gpt-6-sol","visibility":"list","supported_reasoning_levels":[{"effort":"max","description":"Maximum"}]}]}`)
	for i := 0; i < 2; i++ {
		if err := installCodexModelCatalog(body); err != nil {
			t.Fatal(err)
		}
	}
	got, err := os.ReadFile(codexManagedCatalogPath())
	if err != nil || string(got) != string(body) {
		t.Fatalf("catalog capabilities changed: %s, %v", got, err)
	}
	content, _, _ := readCodexConfigRaw()
	if loadCodexConfigString(content, codexCatalogKey) != codexManagedCatalogPath() {
		t.Fatal("catalog not selected")
	}
	restored, err := restoreCodexModelCatalog(content)
	if err != nil || loadCodexConfigString(restored, codexCatalogKey) != "custom.json" {
		t.Fatalf("original catalog lost: %s, %v", restored, err)
	}
	userEdit := setTopLevelString(content, codexCatalogKey, "new-user-catalog.json")
	if restored, err := restoreCodexModelCatalog(userEdit); err != nil || restored != userEdit {
		t.Fatal("overwrote user edit")
	}
	if err := installCodexModelCatalog([]byte(`{"models":[]}`)); err == nil {
		t.Fatal("empty catalog accepted")
	}
	got, _ = os.ReadFile(codexManagedCatalogPath())
	if string(got) != string(body) {
		t.Fatal("failed refresh replaced good catalog")
	}
}

func TestCodexManagedCatalogFetchesBeforeDesktopLaunch(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	if err := os.WriteFile(codexConfigPath(), []byte("model_provider = 'bingchaai'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.URL.Query().Get("client_version") == "" || r.Header.Get("Authorization") != "Bearer "+codexTakeoverAPIKey {
			t.Errorf("unexpected catalog request")
		}
		_, _ = w.Write([]byte(`{"models":[{"slug":"gpt-6-sol"},{"slug":"gpt-6-luna"}]}`))
	}))
	defer server.Close()
	u, _ := url.Parse(server.URL)
	port, _ := strconv.Atoi(u.Port())
	if err := syncCodexModelCatalog(port); err != nil {
		t.Fatal(err)
	}
	content, _, _ := readCodexConfigRaw()
	restored, err := restoreCodexModelCatalog(content)
	if err != nil || loadCodexConfigString(restored, codexCatalogKey) != "" {
		t.Fatal("absent original key was not restored")
	}
}

func TestCodexManagedCatalogRestoredOnCancelAndProviderSwitch(t *testing.T) {
	for _, target := range []string{"cancel", "provider"} {
		t.Run(target, func(t *testing.T) {
			t.Setenv("CODEX_HOME", t.TempDir())
			if err := os.WriteFile(codexConfigPath(), []byte("model_catalog_json = 'original.json'\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := InjectCodexSettings(12345); err != nil {
				t.Fatal(err)
			}
			if err := installCodexModelCatalog([]byte(`{"models":[{"slug":"gpt-6-sol"}]}`)); err != nil {
				t.Fatal(err)
			}
			if target == "cancel" {
				if _, err := restoreCodexSettingsManaged(); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := InjectCodexProvider(codexProviderSpec{Name: "test", BaseURL: "http://127.0.0.1:9/v1"}); err != nil {
					t.Fatal(err)
				}
			}
			content, _, _ := readCodexConfigRaw()
			if loadCodexConfigString(content, codexCatalogKey) != "original.json" {
				t.Fatal("catalog leaked into next provider")
			}
		})
	}
}
