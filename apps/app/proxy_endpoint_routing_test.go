package main

import "testing"

// Claude/GPT third-party models are only served by daily-cloudcode-pa; routing
// them to the regular cloudcode-pa returns 403 service_disabled/permission_denied
// (and the proxy then mis-reads that as a verification challenge → bound card busy).
func TestCloudCodeEndpointForModel(t *testing.T) {
	cases := []struct {
		model string
		want  string
	}{
		{"gemini-2.5-pro", DefaultCloudEndpoint},
		{"gemini-3-flash-agent", DefaultCloudEndpoint},
		{"claude-sonnet-4-6", DailyCloudEndpoint},
		{"claude-opus-4-6-thinking", DailyCloudEndpoint},
		{"gpt-5", DailyCloudEndpoint},
		{"", DefaultCloudEndpoint}, // unknown → safe default (regular host)
	}
	for _, c := range cases {
		if got := cloudCodeEndpointForModel(c.model); got != c.want {
			t.Fatalf("cloudCodeEndpointForModel(%q) = %s, want %s", c.model, got, c.want)
		}
	}
}
