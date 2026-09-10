package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHistorySwitchWithoutGUIRoundTrip(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "sessions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "rollout-chat.jsonl")
	body := "{\"type\":\"event_msg\",\"payload\":{\"message\":\"保留聊天正文\"}}\n"
	if err := os.WriteFile(path, []byte("{\"type\":\"session_meta\",\"payload\":{\"id\":\"chat\",\"model_provider\":\"bingchaai\"}}\n"+body), 0o600); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(home, codexStateDBFile))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT); INSERT INTO threads VALUES ('chat','bingchaai')`); err != nil {
		t.Fatal(err)
	}
	for _, provider := range []string{"openai", "bingchaai", "bingchaai"} {
		if err := alignCodexHistoryForSwitch(home, "", provider, true); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasSuffix(string(data), body) || !strings.Contains(string(data), `"model_provider":"`+provider+`"`) {
			t.Fatalf("history changed unexpectedly: %s", data)
		}
		var got string
		if err := db.QueryRow(`SELECT model_provider FROM threads WHERE id='chat'`).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != provider {
			t.Fatalf("provider=%q want %q", got, provider)
		}
	}
}

func TestHistorySwitchReportsBrokenDatabase(t *testing.T) {
	for _, alignAll := range []bool{true, false} {
		home := t.TempDir()
		if err := os.WriteFile(filepath.Join(home, codexStateDBFile), []byte("broken database"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := alignCodexHistoryForSwitch(home, "bingchaai", "openai", alignAll); err == nil {
			t.Fatalf("alignAll=%v: database failure must not report success", alignAll)
		}
	}
}
