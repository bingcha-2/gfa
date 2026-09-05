package main

// Manual refresh is authoritative. A drop in used USD of at least $5 triggers
// one confirmation request before either persistent or in-memory state changes.
// The second response may include new usage; accept its latest values, not an
// exact equality with the first response. Background report merging is unchanged.
const manualQuotaConfirmationThreshold = 5.0

func quotaUsageDropped(previous, incoming []SubscriptionSnapshot) bool {
	byID := make(map[string]SubscriptionSnapshot, len(previous))
	for _, sub := range previous {
		byID[sub.Id] = sub
	}
	for _, sub := range incoming {
		for product, next := range sub.UsdQuotaByProduct {
			old := byID[sub.Id].UsdQuotaByProduct[product]
			for _, pair := range [][2]*SubscriptionUsdQuotaWindow{{old.FiveHour, next.FiveHour}, {old.Weekly, next.Weekly}} {
				if pair[0] != nil && pair[1] != nil && pair[0].Used-pair[1].Used >= manualQuotaConfirmationThreshold {
					return true
				}
			}
		}
	}
	return false
}

func (l *Leaser) manualQuotaNeedsConfirmation(saved []SubscriptionSnapshot, result map[string]interface{}) bool {
	incoming, _ := parseHeartbeatSubscriptions(result)
	if quotaUsageDropped(saved, incoming) {
		return true
	}
	// The dashboard overlays the active lease's cache onto saved subscriptions.
	// Compare that value too; config may still contain an older heartbeat.
	l.mu.RLock()
	defer l.mu.RUnlock()
	id, _ := l.accessKeyStatus["id"].(string)
	products, _ := l.accessKeyStatus["usdQuotaByProduct"].(map[string]interface{})
	return quotaUsageDropped([]SubscriptionSnapshot{{Id: id, UsdQuotaByProduct: parseSubscriptionUsdQuotaByProduct(products)}}, incoming)
}

func (l *Leaser) applyManualQuotaSnapshot(result map[string]interface{}) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.accessKeyStatus == nil {
		return
	}
	subs, _ := result["subscriptions"].([]interface{})
	for _, raw := range subs {
		sub, ok := raw.(map[string]interface{})
		if !ok || sub["id"] != l.accessKeyStatus["id"] {
			continue
		}
		if quota, ok := sub["usdQuotaByProduct"].(map[string]interface{}); ok {
			// Bypass the normal max-used merge so GetStats cannot immediately
			// overwrite the confirmed reset with the pre-refresh cache.
			updated := make(map[string]interface{}, len(l.accessKeyStatus))
			for key, value := range l.accessKeyStatus {
				updated[key] = value
			}
			updated["usdQuotaByProduct"] = quota
			l.accessKeyStatus = updated
		}
		return
	}
}
