package main

import (
	"encoding/json"
	"os"
	"time"
)

func pendingReportsPath(userID, product string) string {
	base := usageNamespaceFile(userID)
	if base == "" {
		return ""
	}
	return base[:len(base)-len(".json")] + "." + product + ".pending.json"
}

func persistPendingReports(userID, product string, reports []pendingReport) {
	path := pendingReportsPath(userID, product)
	if path == "" {
		return
	}
	if len(reports) == 0 {
		_ = os.Remove(path)
		return
	}
	data, err := json.Marshal(reports)
	if err == nil {
		_ = atomicWriteFile(path, data, 0600)
	}
}

func readPendingReports(userID, product string) []pendingReport {
	path := pendingReportsPath(userID, product)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var reports []pendingReport
	if json.Unmarshal(data, &reports) != nil {
		return nil
	}
	cutoff := time.Now().Add(-pendingReportMaxAge)
	filtered := reports[:0]
	for _, report := range reports {
		if report.AddedAt.After(cutoff) && report.Payload != nil {
			filtered = append(filtered, report)
		}
	}
	if len(filtered) > maxPendingReports {
		filtered = filtered[len(filtered)-maxPendingReports:]
	}
	return filtered
}

func switchPendingReportNamespace(oldUserID, newUserID string) {
	for _, item := range []struct {
		product string
		lock    func() (*[]pendingReport, func())
	}{
		{"antigravity", func() (*[]pendingReport, func()) {
			l := GetLeaser()
			l.mu.Lock()
			return &l.pendingReports, l.mu.Unlock
		}},
		{"codex", func() (*[]pendingReport, func()) {
			l := GetCodexLeaser()
			l.mu.Lock()
			return &l.pendingReports, l.mu.Unlock
		}},
		{"anthropic", func() (*[]pendingReport, func()) {
			l := GetClaudeLeaser()
			l.mu.Lock()
			return &l.pendingReports, l.mu.Unlock
		}},
	} {
		queue, unlock := item.lock()
		persistPendingReports(oldUserID, item.product, *queue)
		*queue = readPendingReports(newUserID, item.product)
		unlock()
	}
}
