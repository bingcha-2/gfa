package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const codexCatalogKey = "model_catalog_json"

type codexCatalogBackup struct {
	Previous string `json:"previous"`
}

func codexManagedCatalogPath() string {
	return filepath.Join(codexHomeDir(), "bingchaai-models.json")
}

func codexCatalogBackupPath() string {
	return filepath.Join(codexHomeDir(), "bingchaai-models.backup.json")
}

// API-key custom providers may never request /models. Load the real upstream
// catalog explicitly before restarting Desktop, retaining all capability fields.
func syncCodexModelCatalog(proxyPort int) error {
	version := strings.SplitN(strings.TrimPrefix(codexDefaultUserAgent, "codex-tui/"), " ", 2)[0]
	req, err := http.NewRequest(http.MethodGet, codexProxyBaseURL(proxyPort)+"/models?client_version="+version, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+codexTakeoverAPIKey)
	req.Header.Set("User-Agent", codexDefaultUserAgent)
	req.Header.Set("Originator", codexDefaultOriginator)
	client := &http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{Proxy: nil}}
	defer client.CloseIdleConnections()
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("fetch Codex catalog: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Codex catalog status %d", resp.StatusCode)
	}
	body, err := readCodexModelsBody(resp)
	if err != nil {
		return err
	}
	return installCodexModelCatalog(body)
}

func installCodexModelCatalog(body []byte) error {
	if err := validateCodexModelsPayload(body); err != nil {
		return err
	}
	var catalog struct {
		Models []json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(body, &catalog); err != nil {
		return err
	}
	if len(catalog.Models) == 0 {
		return fmt.Errorf("Codex catalog is empty; keeping previous catalog")
	}
	content, _, err := readCodexConfigRaw()
	if err != nil {
		return err
	}
	if loadCodexConfigString(content, codexCatalogKey) != codexManagedCatalogPath() {
		backup, _ := json.Marshal(codexCatalogBackup{Previous: loadCodexConfigString(content, codexCatalogKey)})
		if err := writeFileAtomic(codexCatalogBackupPath(), backup, 0o600); err != nil {
			return err
		}
	} else if _, err := restoreCodexModelCatalog(content); err != nil {
		return err
	}
	if err := writeFileAtomic(codexManagedCatalogPath(), body, 0o600); err != nil {
		return err
	}
	content = setTopLevelString(content, codexCatalogKey, codexManagedCatalogPath())
	return writeFileAtomic(codexConfigPath(), []byte(content), 0o644)
}

// Only restore our own projection; preserve a catalog the user selected later.
func restoreCodexModelCatalog(content string) (string, error) {
	if loadCodexConfigString(content, codexCatalogKey) != codexManagedCatalogPath() {
		return content, nil
	}
	raw, err := os.ReadFile(codexCatalogBackupPath())
	if err != nil {
		return content, err
	}
	var backup codexCatalogBackup
	if err := json.Unmarshal(raw, &backup); err != nil {
		return content, err
	}
	if backup.Previous == "" {
		return removeTopLevelKey(content, codexCatalogKey), nil
	}
	return setTopLevelString(content, codexCatalogKey, backup.Previous), nil
}
