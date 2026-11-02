package main

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// Cache is session-scoped: never expose the previous user's ledger after login changes.
var gatewaySummaryCache struct {
	sync.Mutex
	token   string
	at      time.Time
	loading bool
	value   map[string]interface{}
}

func gatewaySummarySnapshot(token string) map[string]interface{} {
	c := &gatewaySummaryCache
	c.Lock()
	defer c.Unlock()
	if c.token != token {
		c.token, c.at, c.loading, c.value = token, time.Time{}, false, nil
	}
	if token == "" {
		return nil
	}
	if !c.loading && time.Since(c.at) >= 15*time.Second {
		c.loading = true
		go func() {
			body, status, err := doAuthPostWithBearer("/app/gateway/summary", struct{}{}, token)
			result := map[string]interface{}{}
			if err != nil || status != http.StatusOK || json.Unmarshal(body, &result) != nil {
				result = map[string]interface{}{"error": "网关用量暂时无法读取，请稍后刷新"}
			}
			c.Lock()
			defer c.Unlock()
			if c.token == token {
				c.value, c.at, c.loading = result, time.Now(), false
			}
		}()
	}
	if c.value == nil {
		return map[string]interface{}{"loading": true}
	}
	return c.value
}
