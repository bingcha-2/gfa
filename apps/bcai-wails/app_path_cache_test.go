package main

import "testing"

func TestInvalidateIDEDetectCacheForInstallPathChange(t *testing.T) {
	detectCacheMu.Lock()
	cachedIDEStatus = &IDEStatus{}
	detectCacheMu.Unlock()

	oldCfg := Config{}
	newCfg := oldCfg
	newCfg.CodexAppPath = `C:\Users\tester\AppData\Local\OpenAI\Codex\bin\hash\codex.exe`

	invalidateIDEDetectCacheForInstallPathChange(oldCfg, newCfg)

	detectCacheMu.RLock()
	defer detectCacheMu.RUnlock()
	if cachedIDEStatus != nil {
		t.Fatal("Codex path change must invalidate the cached IDE detection result")
	}
}

func TestKeepIDEDetectCacheWhenInstallPathsAreUnchanged(t *testing.T) {
	detectCacheMu.Lock()
	cachedIDEStatus = &IDEStatus{}
	detectCacheMu.Unlock()

	cfg := Config{CodexAppPath: `C:\Codex\Codex.exe`}
	invalidateIDEDetectCacheForInstallPathChange(cfg, cfg)

	detectCacheMu.RLock()
	defer detectCacheMu.RUnlock()
	if cachedIDEStatus == nil {
		t.Fatal("unchanged install paths should keep the cached IDE detection result")
	}
}
