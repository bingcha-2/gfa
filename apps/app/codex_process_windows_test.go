//go:build windows

package main

import "testing"

func TestCodexProcessCommandsHideWindow(t *testing.T) {
	for _, name := range []string{"tasklist", "taskkill"} {
		cmd := hideCmd(name)
		if cmd.SysProcAttr == nil || !cmd.SysProcAttr.HideWindow {
			t.Fatalf("%s would open a console window", name)
		}
	}
}

func TestTasklistMissingImageOnWindows(t *testing.T) {
	const missing = "bcai-process-test-not-running.exe"
	out, err := hideCmd("tasklist", "/FI", "IMAGENAME eq "+missing, "/NH", "/FO", "CSV").Output()
	if err != nil {
		t.Fatalf("tasklist failed: %v", err)
	}
	if tasklistContainsImage(string(out), missing) {
		t.Fatalf("localized no-match output treated as a running process: %q", out)
	}
}
