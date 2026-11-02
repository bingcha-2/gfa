package main

import (
	"os"
)

// Legacy restore support only. New settings and sandbox creation are removed.
func restoreLegacySandboxWrapper() error {
	if _, err := os.Stat(vscodeWrapperPath()); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return err
	}
	for _, editor := range detectedVscodeEditors() {
		if err := clearVscodeWrapperSetting(editor.SettingsPath); err != nil {
			return err
		}
	}
	clearEditorLoginGate()
	return os.Remove(vscodeWrapperPath())
}
