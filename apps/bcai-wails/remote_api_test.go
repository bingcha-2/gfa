package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPostJSONWithSecretToBase(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/lease-token" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if got := r.Header.Get("x-token-server-secret"); got != "secret-card" {
			t.Fatalf("x-token-server-secret = %q", got)
		}
		var payload map[string]string
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		if payload["clientId"] != "device-a" {
			t.Fatalf("clientId = %q", payload["clientId"])
		}
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}))
	defer server.Close()

	body, status, err := postJSONWithSecretToBase(server.URL, server.Client(), "/lease-token", map[string]string{
		"clientId": "device-a",
	}, "secret-card")
	if err != nil {
		t.Fatal(err)
	}
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if string(body) == "" {
		t.Fatal("expected response body")
	}
}
