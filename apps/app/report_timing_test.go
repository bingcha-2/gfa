package main

import "testing"

func TestCausalReportFieldsAreCompleteAndStableAcrossRetries(t *testing.T) {
	payload := map[string]interface{}{"modelKey": "gpt-5.6-luna"}
	addCausalReportFields(payload, "lease-1", ReportDetails{
		RequestStartedAt:    1000,
		UpstreamCompletedAt: 2000,
	})
	reportID, _ := payload["reportId"].(string)
	if reportID == "" || payload["traceId"] != reportID {
		t.Fatalf("missing stable ids: %+v", payload)
	}
	if payload["requestStartedAt"] != int64(1000) || payload["upstreamCompletedAt"] != int64(2000) {
		t.Fatalf("wrong event times: %+v", payload)
	}
	queued := pendingReport{Payload: payload}
	if queued.Payload["reportId"] != reportID || queued.Payload["requestStartedAt"] != int64(1000) {
		t.Fatalf("queued retry changed causal identity: %+v", queued.Payload)
	}
}

func TestCausalReportFieldsClampMissingOrBackwardsTimes(t *testing.T) {
	payload := map[string]interface{}{}
	addCausalReportFields(payload, "lease-2", ReportDetails{
		RequestStartedAt:    3000,
		UpstreamCompletedAt: 2000,
	})
	if payload["requestStartedAt"] != int64(2000) || payload["upstreamCompletedAt"] != int64(2000) {
		t.Fatalf("backwards times not clamped: %+v", payload)
	}
}
