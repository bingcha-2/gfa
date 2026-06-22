package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestParseSetCookieValue(t *testing.T) {
	cases := map[string]string{
		"sessionKey=sk-ant-sid01-abc; Domain=.claude.ai; Path=/; HttpOnly": "sk-ant-sid01-abc",
		"sessionKey=xyz":             "xyz",
		"sessionKey=":                "",
		"noequalshere":               "",
		"sessionKey= spaced ; Path=/": "spaced",
	}
	for in, want := range cases {
		if got := parseSetCookieValue(in); got != want {
			t.Errorf("parseSetCookieValue(%q) = %q, want %q", in, got, want)
		}
	}
}

// 轮换:本地 current.sk 顶替成新值,并异步上报 /rotate-session(带 accountId + 新 sk)。
func TestOnRotatedSessionKeyUpdatesAndReports(t *testing.T) {
	var mu sync.Mutex
	var gotBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/rotate-session" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		_ = json.Unmarshal(b, &gotBody)
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true})
	}))
	defer srv.Close()

	prev := ANTHROPIC_WEB_REMOTE_BASE
	ANTHROPIC_WEB_REMOTE_BASE = srv.URL
	t.Cleanup(func() { ANTHROPIC_WEB_REMOTE_BASE = prev })

	l := &ClaudeSessionLeaser{}
	l.card, l.upstream = "card-1", ""
	l.current = &SessionLease{AccountId: 42, Email: "x@y.com", SessionKey: "old-sk"}

	l.OnRotatedSessionKey("new-sk")

	if got := l.CurrentSessionKey(); got != "new-sk" {
		t.Fatalf("current sk = %q, want new-sk (本地顶替失败)", got)
	}

	// 上报是异步的,等它到达。
	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		done := gotBody != nil
		mu.Unlock()
		if done || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if gotBody == nil {
		t.Fatal("服务端没收到 rotate-session 上报")
	}
	if gotBody["sessionKey"] != "new-sk" {
		t.Fatalf("上报 sessionKey = %v, want new-sk", gotBody["sessionKey"])
	}
	if gotBody["accountId"] != float64(42) {
		t.Fatalf("上报 accountId = %v, want 42", gotBody["accountId"])
	}
}

// 去重/守护:空 sk、与当前相同、未借号(current==nil)三种情况都不顶替、不上报。
func TestOnRotatedSessionKeyDedupsAndGuards(t *testing.T) {
	var mu sync.Mutex
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true})
	}))
	defer srv.Close()
	prev := ANTHROPIC_WEB_REMOTE_BASE
	ANTHROPIC_WEB_REMOTE_BASE = srv.URL
	t.Cleanup(func() { ANTHROPIC_WEB_REMOTE_BASE = prev })

	l := &ClaudeSessionLeaser{}
	l.card = "card-1"
	l.current = &SessionLease{AccountId: 1, SessionKey: "same"}

	l.OnRotatedSessionKey("")     // 空 → 忽略
	l.OnRotatedSessionKey("same") // 没变 → 忽略
	l.current = nil
	l.OnRotatedSessionKey("whatever") // 未借号 → 忽略

	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if hits != 0 {
		t.Fatalf("空/未变/未借号都不该上报,却命中 %d 次", hits)
	}
}
