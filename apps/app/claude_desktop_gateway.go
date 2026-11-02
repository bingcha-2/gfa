package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
)

const desktopGatewayProfileID = "6ec414ad-21df-4ac0-bf81-802b27256cda"

var desktopGatewayMu sync.Mutex

// Test seam for disk failures after the write-ahead journal is durable.
var writeDesktopGatewayFile = writeDesktopJSON

// A write-ahead journal owns only the keys we change, never the user's whole
// configuration. It also makes an interrupted four-file installation restorable.
type desktopGatewayFile struct {
	Path            string                 `json:"path"`
	Existed         bool                   `json:"existed"`
	Before          map[string]prevVal     `json:"before"`
	Written         map[string]interface{} `json:"written"`
	PreviousWritten map[string]interface{} `json:"previousWritten,omitempty"`
}
type desktopGatewayJournal struct {
	Files []desktopGatewayFile `json:"files"`
}

func desktopGatewayDirs() (string, string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", "", err
	}
	var root string
	switch runtime.GOOS {
	case "darwin":
		root = filepath.Join(home, "Library", "Application Support")
	case "windows":
		root = os.Getenv("LOCALAPPDATA")
		if root == "" {
			root = filepath.Join(home, "AppData", "Local")
		}
		normal, err := desktopWindowsConfigDir(root, "Claude")
		if err != nil {
			return "", "", err
		}
		threep, err := desktopWindowsConfigDir(root, "Claude-3p")
		return normal, threep, err
	default:
		return "", "", fmt.Errorf("Claude Desktop 3P 暂仅支持 macOS / Windows")
	}
	return filepath.Join(root, "Claude"), filepath.Join(root, "Claude-3p"), nil
}

// Some Desktop Windows distributions suffix the user-data directory. Never
// silently select one of several installations and change the wrong profile.
func desktopWindowsConfigDir(root, name string) (string, error) {
	exact := filepath.Join(root, name)
	if info, err := os.Stat(exact); err == nil && info.IsDir() {
		return exact, nil
	}
	entries, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return exact, nil
	}
	if err != nil {
		return "", err
	}
	var candidates []string
	for _, entry := range entries {
		if entry.IsDir() && strings.HasPrefix(entry.Name(), name+"_") {
			candidates = append(candidates, filepath.Join(root, entry.Name()))
		}
	}
	if len(candidates) > 1 {
		return "", fmt.Errorf("检测到多个 %s 配置目录，请保留当前使用的安装目录后重试", name)
	}
	if len(candidates) == 1 {
		return candidates[0], nil
	}
	return exact, nil
}

func desktopGatewayJournalPath(dir string) string {
	return filepath.Join(dir, ".gfa-gateway-backup.json")
}

func readDesktopJSON(path string) (map[string]interface{}, bool, error) {
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return map[string]interface{}{}, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	var obj map[string]interface{}
	if err = json.Unmarshal(b, &obj); err != nil || obj == nil {
		return nil, true, fmt.Errorf("配置不是有效 JSON 对象: %s", path)
	}
	return obj, true, nil
}

func writeDesktopJSON(path string, value interface{}) error {
	b, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	return writeFileAtomic(path, b, 0600)
}

// injectDesktopGatewayAt is independent of OS processes, enabling isolated tests.
func injectDesktopGatewayAt(normal, threep, baseURL, key string, models []string) error {
	desktopGatewayMu.Lock()
	defer desktopGatewayMu.Unlock()
	if baseURL == "" || !isGatewayKey(key) {
		return fmt.Errorf("无效的 GFA 网关配置")
	}
	journalPath := desktopGatewayJournalPath(threep)
	j := desktopGatewayJournal{}
	if b, err := os.ReadFile(journalPath); err == nil {
		if json.Unmarshal(b, &j) != nil || len(j.Files) != 4 {
			return fmt.Errorf("Desktop 配置备份损坏，停止写入")
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	profile := map[string]interface{}{
		"inferenceProvider": "gateway", "inferenceGatewayBaseUrl": baseURL,
		"inferenceGatewayApiKey": key, "inferenceGatewayAuthScheme": "bearer",
		"disableDeploymentModeChooser": true,
	}
	if len(models) > 0 {
		if len(models) > 200 {
			return fmt.Errorf("母号模型数量超过 Desktop 上限 200")
		}
		items := []interface{}{}
		for _, model := range models {
			items = append(items, map[string]interface{}{"name": model})
		}
		profile["inferenceModels"] = items
	}
	paths := []string{filepath.Join(threep, "configLibrary", desktopGatewayProfileID+".json"), filepath.Join(threep, "configLibrary", "_meta.json"), filepath.Join(threep, "claude_desktop_config.json"), filepath.Join(normal, "claude_desktop_config.json")}
	patches := []map[string]interface{}{profile, {"appliedId": desktopGatewayProfileID}, {"deploymentMode": "3p"}, {"deploymentMode": "3p"}}
	docs := make([]map[string]interface{}, len(paths))
	for i, path := range paths {
		doc, exists, err := readDesktopJSON(path)
		if err != nil {
			return err
		}
		if i == 1 {
			entries := []interface{}{}
			if v, ok := doc["entries"]; ok {
				var valid bool
				entries, valid = v.([]interface{})
				if !valid {
					return fmt.Errorf("Desktop configLibrary.entries 必须是数组")
				}
			}
			entries = append([]interface{}{}, entries...)
			found := false
			for _, e := range entries {
				if m, ok := e.(map[string]interface{}); ok && m["id"] == desktopGatewayProfileID {
					found = true
				}
			}
			if !found {
				entries = append(entries, map[string]interface{}{"id": desktopGatewayProfileID, "name": "GFA"})
			}
			patches[i]["entries"] = entries
		}
		if len(j.Files) <= i {
			j.Files = append(j.Files, desktopGatewayFile{Path: path, Existed: exists, Before: map[string]prevVal{}})
		}
		f := &j.Files[i]
		if f.Path != path {
			return fmt.Errorf("Desktop 配置目录与备份不一致")
		}
		for k, v := range patches[i] {
			if _, ok := f.Before[k]; !ok {
				old, present := doc[k]
				f.Before[k] = prevVal{Present: present, Value: old}
			}
			doc[k] = v
		}
		f.PreviousWritten = f.Written
		f.Written = patches[i]
		docs[i] = doc
	}
	if err := writeDesktopGatewayFile(journalPath, j); err != nil {
		return err
	}
	for i, path := range paths {
		if err := writeDesktopGatewayFile(path, docs[i]); err != nil {
			// Leave the journal if rollback also fails; Restore can retry safely.
			if rollback := restoreDesktopGatewayLocked(threep); rollback != nil {
				return fmt.Errorf("写入失败: %v; 恢复失败: %w", err, rollback)
			}
			return err
		}
	}
	return nil
}

func restoreDesktopGatewayAt(threep string) error {
	desktopGatewayMu.Lock()
	defer desktopGatewayMu.Unlock()
	return restoreDesktopGatewayLocked(threep)
}

func restoreDesktopGatewayLocked(threep string) error {
	path := desktopGatewayJournalPath(threep)
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var j desktopGatewayJournal
	if json.Unmarshal(b, &j) != nil || len(j.Files) != 4 {
		return fmt.Errorf("Desktop 配置备份损坏，停止恢复")
	}
	meta, _, err := readDesktopJSON(filepath.Join(threep, "configLibrary", "_meta.json"))
	if err != nil {
		return err
	}
	selected, _ := meta["appliedId"].(string)
	userSelectedAnotherProfile := selected != "" && selected != desktopGatewayProfileID
	for i := len(j.Files) - 1; i >= 0; i-- {
		f := j.Files[i]
		doc, exists, err := readDesktopJSON(f.Path)
		if err != nil {
			return err
		}
		if !exists {
			continue
		}
		// Desktop seals static keys on startup. This dedicated GFA profile and
		// its unchanged gateway URL still belong to this installation journal.
		sealedOwnedKey := filepath.Base(f.Path) == desktopGatewayProfileID+".json" &&
			isGatewayKey(asString(f.Written["inferenceGatewayApiKey"])) &&
			reflect.DeepEqual(doc["inferenceGatewayBaseUrl"], f.Written["inferenceGatewayBaseUrl"]) &&
			strings.HasPrefix(asString(doc["inferenceGatewayApiKey"]), "__sealed__:v1:")
		for k, written := range f.Written {
			if k == "deploymentMode" && userSelectedAnotherProfile {
				continue
			}
			before := f.Before[k]
			if reflect.DeepEqual(doc[k], written) || (f.PreviousWritten != nil && reflect.DeepEqual(doc[k], f.PreviousWritten[k])) || (k == "inferenceGatewayApiKey" && sealedOwnedKey) {
				if before.Present {
					doc[k] = before.Value
				} else {
					delete(doc, k)
				}
			} else if k == "entries" && !desktopEntriesContain(before.Value, desktopGatewayProfileID) {
				if entries, ok := doc[k].([]interface{}); ok {
					kept := []interface{}{}
					for _, e := range entries {
						m, _ := e.(map[string]interface{})
						if m["id"] != desktopGatewayProfileID {
							kept = append(kept, e)
						}
					}
					doc[k] = kept
				}
			}
		}
		if !f.Existed && len(doc) == 0 {
			err = os.Remove(f.Path)
		} else {
			err = writeDesktopGatewayFile(f.Path, doc)
		}
		if err != nil {
			return err
		}
	}
	return os.Remove(path)
}

func desktopEntriesContain(value interface{}, id string) bool {
	entries, _ := value.([]interface{})
	for _, e := range entries {
		m, _ := e.(map[string]interface{})
		if m["id"] == id {
			return true
		}
	}
	return false
}

func isDesktopGatewayInjected() bool {
	normal, threep, err := desktopGatewayDirs()
	if err != nil {
		return false
	}
	return isDesktopGatewayInjectedAt(normal, threep, gatewayClaudeBaseURL())
}

func isDesktopGatewayInjectedAt(normal, threep, baseURL string) bool {
	for _, dir := range []string{normal, threep} {
		doc, _, e := readDesktopJSON(filepath.Join(dir, "claude_desktop_config.json"))
		if e != nil || doc["deploymentMode"] != "3p" {
			return false
		}
	}
	meta, _, err := readDesktopJSON(filepath.Join(threep, "configLibrary", "_meta.json"))
	if err != nil || meta["appliedId"] != desktopGatewayProfileID {
		return false
	}
	p, _, err := readDesktopJSON(filepath.Join(threep, "configLibrary", desktopGatewayProfileID+".json"))
	key := asString(p["inferenceGatewayApiKey"])
	_, journalErr := os.Stat(desktopGatewayJournalPath(threep))
	return err == nil && p["inferenceGatewayBaseUrl"] == baseURL &&
		(isGatewayKey(key) || (journalErr == nil && strings.HasPrefix(key, "__sealed__:v1:")))
}
