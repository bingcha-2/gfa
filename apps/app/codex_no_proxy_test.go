package main

import (
	"strings"
	"testing"
)

func TestCodexLaunchEnvMergesLocalProxyBypass(t *testing.T) {
	got := codexLaunchEnv([]string{
		"PATH=C:\\Windows",
		"NO_PROXY=example.com,localhost",
		"no_proxy=api.internal,EXAMPLE.com",
		"HTTPS_PROXY=http://127.0.0.1:10808",
	})

	values := map[string]string{}
	for _, item := range got {
		key, value, ok := strings.Cut(item, "=")
		if ok {
			values[key] = value
		}
	}
	if values["PATH"] != `C:\Windows` || values["HTTPS_PROXY"] != "http://127.0.0.1:10808" {
		t.Fatalf("unrelated proxy environment changed: %v", values)
	}
	if values["NO_PROXY"] != values["no_proxy"] {
		t.Fatalf("NO_PROXY variants differ: %q vs %q", values["NO_PROXY"], values["no_proxy"])
	}
	for _, want := range []string{"example.com", "api.internal", "127.0.0.1", "127.0.0.0/8", "localhost", "::1", "::1/128"} {
		if !containsCommaItemFold(values["NO_PROXY"], want) {
			t.Errorf("NO_PROXY %q does not contain %q", values["NO_PROXY"], want)
		}
	}
	if strings.Count(strings.ToLower(values["NO_PROXY"]), "example.com") != 1 {
		t.Fatalf("existing bypass entry was not deduplicated: %q", values["NO_PROXY"])
	}
}

func containsCommaItemFold(value, want string) bool {
	for _, item := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(item), want) {
			return true
		}
	}
	return false
}
