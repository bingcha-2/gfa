package main

import "testing"

func TestDeviceIDFromMachineSourceStableAndUUIDShaped(t *testing.T) {
	first := deviceIDFromMachineSource("windows", "MachineGuid", "abc-123")
	second := deviceIDFromMachineSource("windows", "MachineGuid", "abc-123")

	if first == "" {
		t.Fatal("device ID should not be empty")
	}
	if first != second {
		t.Fatalf("device ID should be stable, first=%q second=%q", first, second)
	}
	if len(first) != 36 {
		t.Fatalf("device ID length = %d, want 36 (%q)", len(first), first)
	}
	for _, pos := range []int{8, 13, 18, 23} {
		if first[pos] != '-' {
			t.Fatalf("device ID %q missing dash at position %d", first, pos)
		}
	}
}

func TestDeviceIDFromMachineSourceSeparatesSourceNames(t *testing.T) {
	a := deviceIDFromMachineSource("windows", "MachineGuid", "same-value")
	b := deviceIDFromMachineSource("linux", "machine-id", "same-value")

	if a == b {
		t.Fatalf("different source scopes should not collide for same value: %q", a)
	}
}

func TestPreferredDeviceIDUsesMachineIDWhenAvailable(t *testing.T) {
	t.Cleanup(func() {
		readMachineID = readStableMachineID
	})

	readMachineID = func() (machineIDSource, error) {
		return machineIDSource{OS: "windows", Name: "MachineGuid", Value: "machine-a"}, nil
	}

	cfg := Config{DeviceId: "old-random-id"}
	got, migrated := preferredDeviceID(cfg)
	want := deviceIDFromMachineSource("windows", "MachineGuid", "machine-a")

	if got != want {
		t.Fatalf("preferredDeviceID() = %q, want machine-derived %q", got, want)
	}
	if !migrated {
		t.Fatal("preferredDeviceID should report migration from old random id")
	}
}

func TestPreferredDeviceIDFallsBackToExistingConfigWhenMachineIDUnavailable(t *testing.T) {
	t.Cleanup(func() {
		readMachineID = readStableMachineID
	})

	readMachineID = func() (machineIDSource, error) {
		return machineIDSource{}, errMachineIDUnavailable
	}

	got, migrated := preferredDeviceID(Config{DeviceId: "existing-id"})
	if got != "existing-id" {
		t.Fatalf("preferredDeviceID() = %q, want existing config id", got)
	}
	if migrated {
		t.Fatal("preferredDeviceID should not report migration when keeping existing id")
	}
}

func TestApplyPreferredDeviceIDKeepsLoggedInSessionIDWhenMigrationNotAllowed(t *testing.T) {
	t.Cleanup(func() {
		readMachineID = readStableMachineID
	})

	readMachineID = func() (machineIDSource, error) {
		return machineIDSource{OS: "windows", Name: "MachineGuid", Value: "machine-a"}, nil
	}

	cfg, changed, source := applyPreferredDeviceID(Config{
		DeviceId:  "old-session-id",
		UserToken: "session-token",
	}, false)

	if cfg.DeviceId != "old-session-id" {
		t.Fatalf("DeviceId = %q, want existing logged-in session id", cfg.DeviceId)
	}
	if changed {
		t.Fatal("logged-in session id should not be migrated during startup")
	}
	if source != "existing-session" {
		t.Fatalf("source = %q, want existing-session", source)
	}
}
