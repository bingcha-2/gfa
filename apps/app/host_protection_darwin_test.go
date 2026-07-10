//go:build darwin

package main

import (
	"strings"
	"testing"
)

func TestMacHostProtectionCombinesTimezoneAndDNSInOneAuthorization(t *testing.T) {
	script := macHostProtectionApplyScript("Asia/Singapore", true, true)
	if strings.Count(script, "with administrator privileges") != 1 {
		t.Fatalf("expected one authorization prompt: %s", script)
	}
	for _, want := range []string{"systemsetup -settimezone", "dscacheutil -flushcache", "mDNSResponder"} {
		if !strings.Contains(script, want) {
			t.Fatalf("script missing %q: %s", want, script)
		}
	}
}
