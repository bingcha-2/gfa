package main

import (
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

const deviceIDHashSalt = "bingchaai-device-id-v1"

var errMachineIDUnavailable = errors.New("stable machine id unavailable")

type machineIDSource struct {
	OS    string
	Name  string
	Value string
}

var readMachineID = readStableMachineID

func preferredDeviceID(cfg Config) (string, bool) {
	src, err := readMachineID()
	if err == nil {
		id := deviceIDFromMachineSource(src.OS, src.Name, src.Value)
		return id, cfg.DeviceId != id
	}
	if cfg.DeviceId != "" {
		return cfg.DeviceId, false
	}
	return generateUUID(), true
}

func applyPreferredDeviceID(cfg Config, allowMachineMigration bool) (Config, bool, string) {
	src, err := readMachineID()
	if err == nil {
		id := deviceIDFromMachineSource(src.OS, src.Name, src.Value)
		if cfg.DeviceId == id {
			return cfg, false, "machine"
		}
		if cfg.DeviceId == "" || allowMachineMigration {
			cfg.DeviceId = id
			return cfg, true, "machine"
		}
		return cfg, false, "existing-session"
	}

	if cfg.DeviceId == "" {
		cfg.DeviceId = generateUUID()
		return cfg, true, "random"
	}
	return cfg, false, "existing"
}

func deviceIDFromMachineSource(osName, sourceName, value string) string {
	normalized := strings.TrimSpace(strings.ToLower(value))
	input := fmt.Sprintf("%s|%s|%s|%s", deviceIDHashSalt, osName, sourceName, normalized)
	sum := sha256.Sum256([]byte(input))
	b := sum[:16]
	b[6] = (b[6] & 0x0f) | 0x50
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func readStableMachineID() (machineIDSource, error) {
	switch runtime.GOOS {
	case "windows":
		return readWindowsMachineGuid()
	case "darwin":
		return readDarwinPlatformUUID()
	case "linux":
		return readLinuxMachineID()
	default:
		return machineIDSource{}, errMachineIDUnavailable
	}
}

func readWindowsMachineGuid() (machineIDSource, error) {
	out, err := exec.Command("reg", "query", `HKLM\SOFTWARE\Microsoft\Cryptography`, "/v", "MachineGuid").Output()
	if err != nil {
		return machineIDSource{}, errMachineIDUnavailable
	}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 3 && strings.EqualFold(fields[0], "MachineGuid") {
			value := strings.TrimSpace(strings.Join(fields[2:], " "))
			if value != "" {
				return machineIDSource{OS: "windows", Name: "MachineGuid", Value: value}, nil
			}
		}
	}
	return machineIDSource{}, errMachineIDUnavailable
}

func readDarwinPlatformUUID() (machineIDSource, error) {
	out, err := exec.Command("ioreg", "-rd1", "-c", "IOPlatformExpertDevice").Output()
	if err != nil {
		return machineIDSource{}, errMachineIDUnavailable
	}
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(line, "IOPlatformUUID") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.Trim(strings.TrimSpace(parts[1]), `"`)
		if value != "" {
			return machineIDSource{OS: "darwin", Name: "IOPlatformUUID", Value: value}, nil
		}
	}
	return machineIDSource{}, errMachineIDUnavailable
}

func readLinuxMachineID() (machineIDSource, error) {
	for _, path := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		value := strings.TrimSpace(string(data))
		if value != "" {
			return machineIDSource{OS: "linux", Name: path, Value: value}, nil
		}
	}
	return machineIDSource{}, errMachineIDUnavailable
}

func generateUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "device-fallback-uuid"
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
