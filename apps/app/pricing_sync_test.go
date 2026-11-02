package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestPriceSyncCachesAndRetainsSnapshotOffline(t *testing.T) {
	oldURL := authBaseURL
	oldDir := origConfigDir
	origConfigDir = t.TempDir()
	defer func() {
		authBaseURL = oldURL
		origConfigDir = oldDir
		syncedPrices.Lock()
		syncedPrices.Snapshots = nil
		syncedPrices.Unlock()
	}()
	registry := apiPriceRegistry{Version: "remote-v1", EffectiveAt: 1000, Models: []apiPriceModel{{Provider: "codex", CanonicalModelID: "gpt-test", EffectiveFrom: "1970-01-01T00:00:01Z", Modes: map[string]apiPriceMode{"standard": {Short: &apiTokenPrice{Input: 2, Output: 10}}}}}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/pricing/snapshot" {
			t.Errorf("path %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"snapshots": []apiPriceRegistry{registry}})
	}))
	authBaseURL = server.URL
	syncPricesFromServer(context.Background())
	server.Close()
	value := calculateAPIValue("codex", "gpt-test", "standard", 0, 1000000, 0, 0, 0, 0, time.UnixMilli(2000))
	if value.USD != 2 || value.PricingVersion != "remote-v1" {
		t.Fatalf("value %+v", value)
	}
	syncedPrices.Lock()
	syncedPrices.Snapshots = nil
	syncedPrices.Unlock()
	loadPriceCache()
	syncPricesFromServer(context.Background())
	if apiPriceSnapshotAt(time.UnixMilli(2000)).Version != "remote-v1" {
		t.Fatal("offline lost cached prices")
	}
	row := &ModelUsageRecord{Family: "gpt", ModelKey: "gpt-test", PricingVersion: "old", EstimatedCostUSD: 7}
	if repriceModelUsage(row, time.Now()) || row.EstimatedCostUSD != 7 {
		t.Fatal("historical amount changed")
	}
}
