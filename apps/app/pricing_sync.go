package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var syncedPrices struct {
	sync.RWMutex
	Snapshots []apiPriceRegistry
}

func apiPriceSnapshotAt(at time.Time) apiPriceRegistry {
	syncedPrices.RLock()
	defer syncedPrices.RUnlock()
	for i := len(syncedPrices.Snapshots) - 1; i >= 0; i-- {
		if syncedPrices.Snapshots[i].EffectiveAt <= at.UnixMilli() {
			return syncedPrices.Snapshots[i]
		}
	}
	return exactAPIPrices
}
func decodePriceSnapshots(data []byte) ([]apiPriceRegistry, error) {
	var payload struct {
		Snapshots []apiPriceRegistry `json:"snapshots"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, err
	}
	last := int64(0)
	for _, s := range payload.Snapshots {
		if s.Version == "" || len(s.Models) == 0 || s.EffectiveAt <= last {
			return nil, fmt.Errorf("invalid pricing snapshot")
		}
		last = s.EffectiveAt
	}
	if len(payload.Snapshots) == 0 {
		return nil, fmt.Errorf("empty pricing snapshot")
	}
	return payload.Snapshots, nil
}
func priceCachePath() string {
	hash := sha256.Sum256([]byte(authBaseURL))
	return filepath.Join(getAppDataDir(), fmt.Sprintf("model-prices-%x.json", hash[:8]))
}
func loadPriceCache() {
	if data, err := os.ReadFile(priceCachePath()); err == nil {
		if snapshots, err := decodePriceSnapshots(data); err == nil {
			syncedPrices.Lock()
			syncedPrices.Snapshots = snapshots
			syncedPrices.Unlock()
		}
	}
}
func startPriceSync(ctx context.Context) {
	loadPriceCache()
	// Server-scoped cache: a development server must not replace production prices.
	// No credentials are sent to the public snapshot endpoint.
	go func() {
		ticker := time.NewTicker(6 * time.Hour)
		defer ticker.Stop()
		for {
			syncPricesFromServer(ctx)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}
func syncPricesFromServer(ctx context.Context) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(authBaseURL, "/")+"/pricing/snapshot", nil)
	if err != nil {
		return
	}
	response, err := (&http.Client{Timeout: 25 * time.Second}).Do(request)
	if err != nil {
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 20_000_001))
	if err != nil || len(data) > 20_000_000 {
		return
	}
	snapshots, err := decodePriceSnapshots(data)
	if err != nil {
		return
	}
	syncedPrices.Lock()
	syncedPrices.Snapshots = snapshots
	syncedPrices.Unlock()
	_ = os.MkdirAll(getAppDataDir(), 0700)
	_ = atomicWriteFile(priceCachePath(), data, 0600)
}
