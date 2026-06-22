package main

import "testing"

func TestShouldHideWindowOnClose(t *testing.T) {
	cases := map[string]bool{
		"windows": true,  // 缩到托盘
		"darwin":  true,  // 缩到 Dock
		"linux":   false, // 无回退手段,直接退出
	}
	for goos, want := range cases {
		if got := shouldHideWindowOnClose(goos); got != want {
			t.Errorf("shouldHideWindowOnClose(%q) = %v, want %v", goos, got, want)
		}
	}
}
