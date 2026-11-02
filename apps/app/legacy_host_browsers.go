package main

import (
	"os"
	"path/filepath"
	"runtime"
)

// Legacy restore support only. New settings and sandbox creation are removed.
type browserProfileBackup struct {
	Browser     string               `json:"browser"` // chrome / edge / brave / chromium
	Path        string               `json:"path"`
	HadFile     bool                 `json:"hadFile"`
	Perm        uint32               `json:"perm,omitempty"`
	WebRTC      hostPreferenceBackup `json:"webrtc"`
	Geolocation hostPreferenceBackup `json:"geolocation"`
}

type chromiumBrowser struct {
	Name      string
	UserData  string
	Processes []string
}

func chromiumBrowsers() []chromiumBrowser {
	if origConfigDir != "" {
		return []chromiumBrowser{{Name: "chrome", UserData: filepath.Join(origConfigDir, "test-chrome", "User Data"), Processes: []string{"test-chrome"}}}
	}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		local := os.Getenv("LOCALAPPDATA")
		if local == "" {
			local = filepath.Join(home, "AppData", "Local")
		}
		return []chromiumBrowser{
			{"chrome", filepath.Join(local, "Google", "Chrome", "User Data"), []string{"chrome.exe"}},
			{"edge", filepath.Join(local, "Microsoft", "Edge", "User Data"), []string{"msedge.exe"}},
			{"brave", filepath.Join(local, "BraveSoftware", "Brave-Browser", "User Data"), []string{"brave.exe"}},
			{"chromium", filepath.Join(local, "Chromium", "User Data"), []string{"chromium.exe"}},
		}
	case "darwin":
		as := filepath.Join(home, "Library", "Application Support")
		return []chromiumBrowser{
			{"chrome", filepath.Join(as, "Google", "Chrome"), []string{"Google Chrome"}},
			{"edge", filepath.Join(as, "Microsoft Edge"), []string{"Microsoft Edge"}},
			{"brave", filepath.Join(as, "BraveSoftware", "Brave-Browser"), []string{"Brave Browser"}},
			{"chromium", filepath.Join(as, "Chromium"), []string{"Chromium"}},
		}
	default: // linux 及其它类 unix
		cfg := filepath.Join(home, ".config")
		return []chromiumBrowser{
			{"chrome", filepath.Join(cfg, "google-chrome"), []string{"chrome"}},
			{"edge", filepath.Join(cfg, "microsoft-edge"), []string{"msedge"}},
			{"brave", filepath.Join(cfg, "BraveSoftware", "Brave-Browser"), []string{"brave"}},
			{"chromium", filepath.Join(cfg, "chromium"), []string{"chromium"}},
		}
	}
}

func restoreHostChromiumProfiles(snap *hostProtectionSnapshot) int {
	if len(snap.BrowserProfiles) == 0 {
		return 0
	}
	killChromiumBrowsers(snap.BrowserProfiles)
	restored := 0
	for i := range snap.BrowserProfiles {
		b := &snap.BrowserProfiles[i]
		root, exists, perm, err := readHostPreferenceDocument(b.Path)
		if err != nil {
			continue
		}
		if !exists {
			restored++
			continue
		}
		if b.Perm != 0 {
			perm = os.FileMode(b.Perm)
		}
		if snap.BlockWebRTC {
			if err := restoreHostPreference(root, hostWebRTCPreferencePath, b.WebRTC); err != nil {
				continue
			}
		}
		if snap.BlockGeolocation {
			if err := restoreHostPreference(root, hostGeolocationPreferencePath, b.Geolocation); err != nil {
				continue
			}
		}
		if err := writeHostPreferenceDocument(b.Path, root, perm); err != nil {
			continue
		}
		restored++
	}
	return restored
}

func killChromiumBrowsers(profiles []browserProfileBackup) {
	if appActionsSuppressed() || len(profiles) == 0 {
		return
	}
	procByBrowser := map[string][]string{}
	for _, br := range chromiumBrowsers() {
		procByBrowser[br.Name] = br.Processes
	}
	seen := map[string]bool{}
	for _, p := range profiles {
		for _, proc := range procByBrowser[p.Browser] {
			if seen[proc] {
				continue
			}
			seen[proc] = true
			killProcessByName(proc)
		}
	}
}
