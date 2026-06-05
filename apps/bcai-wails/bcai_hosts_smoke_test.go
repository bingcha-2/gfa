package main

import (
	"reflect"
	"testing"
)

func TestBcaiURLCandidatesSmoke(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"https://bcai.lol/remote-token", []string{"https://bcai.lol/remote-token", "https://bcai.space/remote-token"}},
		{"https://bcai.space/updates/latest-wails.json", []string{"https://bcai.lol/updates/latest-wails.json", "https://bcai.space/updates/latest-wails.json"}},
		{"https://bcai.lol/remote-token/lease-token?x=1", []string{"https://bcai.lol/remote-token/lease-token?x=1", "https://bcai.space/remote-token/lease-token?x=1"}},
		{"http://127.0.0.1:3001/api", []string{"http://127.0.0.1:3001/api"}},           // 非 bcai：原样
		{"https://bcai.store/foo", []string{"https://bcai.store/foo"}},                 // 不同 TLD：原样
		{"https://my.custom.host/remote-token", []string{"https://my.custom.host/remote-token"}}, // 自定义覆盖：原样
	}
	for _, c := range cases {
		got := bcaiURLCandidates(c.in)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("bcaiURLCandidates(%q)=%v want %v", c.in, got, c.want)
		}
	}
}
