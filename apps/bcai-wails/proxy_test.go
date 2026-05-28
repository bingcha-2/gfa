package main

import (
	"math"
	"testing"
)

// ═══════════════════════════════════════════════════════════════════════════
// classifyModel
// ═══════════════════════════════════════════════════════════════════════════

func TestClassifyModel_Opus(t *testing.T) {
	cases := []string{"claude-opus-4", "opus", "Claude-Opus", "claude-4-opus"}
	for _, m := range cases {
		if got := classifyModel(m); got != "opus" {
			t.Errorf("classifyModel(%q) = %q, want opus", m, got)
		}
	}
}

func TestClassifyModel_Gemini(t *testing.T) {
	cases := []string{"gemini-2.5-pro", "gemini-2.5-flash", "pro", "flash"}
	for _, m := range cases {
		if got := classifyModel(m); got != "gemini" {
			t.Errorf("classifyModel(%q) = %q, want gemini", m, got)
		}
	}
}

func TestClassifyModel_Other(t *testing.T) {
	cases := []string{"", "gpt-4o", "unknown-model"}
	for _, m := range cases {
		if got := classifyModel(m); got != "other" {
			t.Errorf("classifyModel(%q) = %q, want other", m, got)
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Path detection functions
// ═══════════════════════════════════════════════════════════════════════════

func TestIsGenerationRequest(t *testing.T) {
	positive := []string{
		"/v1/models/gemini:streamGenerateContent",
		"/v1beta/models/gemini-2.5-pro:generateContent",
		"/v1internal/some:bidiGenerateContent",
	}
	for _, p := range positive {
		if !isGenerationRequest(p) {
			t.Errorf("isGenerationRequest(%q) = false, want true", p)
		}
	}
	negative := []string{
		"/v1/models",
		"/health",
		"/v1internal/fetchAvailableModels",
	}
	for _, p := range negative {
		if isGenerationRequest(p) {
			t.Errorf("isGenerationRequest(%q) = true, want false", p)
		}
	}
}

func TestIsCloudCodeRequest(t *testing.T) {
	if !isCloudCodeRequest("/v1internal/some:streamGenerateContent") {
		t.Error("expected true for v1internal path")
	}
	if isCloudCodeRequest("/v1beta/models/gemini:streamGenerateContent") {
		t.Error("expected false for v1beta path")
	}
}

func TestIsModelsRequest(t *testing.T) {
	if !isModelsRequest("/v1internal:fetchAvailableModels") {
		t.Error("expected true for fetchAvailableModels")
	}
	if isModelsRequest("/v1/generateContent") {
		t.Error("expected false for generateContent")
	}
}

func TestIsNoiseRequest(t *testing.T) {
	noises := []string{
		"/v1internal:listExperiments",
		"/cascadeNuxes",
		"/loadCodeAssist",
		"/countTokens",
		"/fetchAdminControls",
		"/recordCodeAssistMetrics",
		"/client/metrics",
	}
	for _, p := range noises {
		if !isNoiseRequest(p) {
			t.Errorf("isNoiseRequest(%q) = false, want true", p)
		}
	}
	if isNoiseRequest("/v1/generateContent") {
		t.Error("expected false for generateContent")
	}
}

func TestIsPassthroughRequest(t *testing.T) {
	if !isPassthroughRequest("/getUserInfo") {
		t.Error("expected true for getUserInfo")
	}
	if !isPassthroughRequest("/onboardUser") {
		t.Error("expected true for onboardUser")
	}
	if isPassthroughRequest("/v1/generateContent") {
		t.Error("expected false for generateContent")
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// hasProjectField / rewriteProjectFields
// ═══════════════════════════════════════════════════════════════════════════

func TestHasProjectField(t *testing.T) {
	withProject := map[string]interface{}{
		"project": "my-project",
		"data":    "something",
	}
	if !hasProjectField(withProject) {
		t.Error("expected true when project field exists")
	}

	withNestedProject := map[string]interface{}{
		"outer": map[string]interface{}{
			"projectId": "nested-project",
		},
	}
	if !hasProjectField(withNestedProject) {
		t.Error("expected true for nested projectId")
	}

	without := map[string]interface{}{
		"data": "something",
		"name": "test",
	}
	if hasProjectField(without) {
		t.Error("expected false when no project field")
	}
}

func TestRewriteProjectFields(t *testing.T) {
	input := map[string]interface{}{
		"project": "old-project",
		"data":    "unchanged",
	}

	result, updated := rewriteProjectFields(input, "new-project")
	if !updated {
		t.Error("expected updated=true")
	}
	m := result.(map[string]interface{})
	if m["project"] != "new-project" {
		t.Errorf("project = %v, want new-project", m["project"])
	}
	if m["data"] != "unchanged" {
		t.Error("data should be unchanged")
	}
}

func TestRewriteProjectFields_ProjectsPrefix(t *testing.T) {
	input := map[string]interface{}{
		"project": "projects/old-project",
	}
	result, _ := rewriteProjectFields(input, "new-project")
	m := result.(map[string]interface{})
	if m["project"] != "projects/new-project" {
		t.Errorf("project = %v, want projects/new-project", m["project"])
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// extractModelKeyFromPath / extractModelKeyFromBody
// ═══════════════════════════════════════════════════════════════════════════

func TestExtractModelKeyFromPath(t *testing.T) {
	cases := map[string]string{
		"/v1beta/models/gemini-2.5-pro:streamGenerateContent": "gemini-2.5-pro",
		"/v1/models/gemini-2.5-flash:generateContent":         "gemini-2.5-flash",
		"/v1internal/something":                               "",
		"/no-models-here":                                     "",
	}
	for path, want := range cases {
		got := extractModelKeyFromPath(path)
		if got != want {
			t.Errorf("extractModelKeyFromPath(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestExtractModelKeyFromBody(t *testing.T) {
	body := []byte(`{"model":"gemini-2.5-pro","contents":[]}`)
	got := extractModelKeyFromBody(body)
	if got != "gemini-2.5-pro" {
		t.Errorf("got %q, want gemini-2.5-pro", got)
	}

	nested := []byte(`{"config":{"model":"claude-opus-4"}}`)
	got = extractModelKeyFromBody(nested)
	if got != "claude-opus-4" {
		t.Errorf("got %q, want claude-opus-4", got)
	}

	noModel := []byte(`{"data":"something"}`)
	got = extractModelKeyFromBody(noModel)
	if got != "" {
		t.Errorf("got %q, want empty", got)
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// parseDurationToMs / extractQuotaResetDelayMs
// ═══════════════════════════════════════════════════════════════════════════

func TestParseDurationToMs(t *testing.T) {
	cases := map[string]int64{
		"5h30m0s":  5*3600000 + 30*60000,
		"1h":      3600000,
		"30m":     30 * 60000,
		"10s":     10000,
		"4h59m35s": 4*3600000 + 59*60000 + 35000,
		"":        0,
		"no-time": 0,
	}
	for input, want := range cases {
		got := parseDurationToMs(input)
		if got != want {
			t.Errorf("parseDurationToMs(%q) = %d, want %d", input, got, want)
		}
	}
}

func TestExtractQuotaResetDelayMs_FromStructuredJSON(t *testing.T) {
	errorBody := `{
		"error": {
			"message": "Resource exhausted",
			"details": [
				{
					"metadata": {
						"quotaResetDelay": "2h30m0s"
					}
				}
			]
		}
	}`
	got := extractQuotaResetDelayMs(errorBody)
	want := int64(2*3600000 + 30*60000)
	if got != want {
		t.Errorf("got %d, want %d", got, want)
	}
}

func TestExtractQuotaResetDelayMs_FromMessage(t *testing.T) {
	errorBody := `{
		"error": {
			"message": "Quota exhausted, reset after 4h59m35s"
		}
	}`
	got := extractQuotaResetDelayMs(errorBody)
	want := int64(4*3600000 + 59*60000 + 35000)
	if got != want {
		t.Errorf("got %d, want %d", got, want)
	}
}

func TestExtractQuotaResetDelayMs_Empty(t *testing.T) {
	if got := extractQuotaResetDelayMs(""); got != 0 {
		t.Errorf("got %d, want 0", got)
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// extractCapacityModelKey
// ═══════════════════════════════════════════════════════════════════════════

func TestExtractCapacityModelKey_FromJSON(t *testing.T) {
	body := `{
		"error": {
			"details": [
				{
					"metadata": {
						"model": "gemini-2.5-pro"
					}
				}
			]
		}
	}`
	got := extractCapacityModelKey(body)
	if got != "gemini-2.5-pro" {
		t.Errorf("got %q, want gemini-2.5-pro", got)
	}
}

func TestExtractCapacityModelKey_FromRegex(t *testing.T) {
	body := `No capacity available for model gemini-2.5-flash`
	got := extractCapacityModelKey(body)
	if got != "gemini-2.5-flash" {
		t.Errorf("got %q, want gemini-2.5-flash", got)
	}
}

func TestExtractCapacityModelKey_Empty(t *testing.T) {
	if got := extractCapacityModelKey(""); got != "" {
		t.Errorf("got %q, want empty", got)
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// checkStreamingQuotaError
// ═══════════════════════════════════════════════════════════════════════════

func TestCheckStreamingQuotaError_Quota(t *testing.T) {
	cases := []string{
		`"status":"RESOURCE_EXHAUSTED"`,
		`baseline model quota reached`,
		`QUOTA_EXHAUSTED`,
	}
	for _, chunk := range cases {
		reason, _, _ := checkStreamingQuotaError(chunk)
		if reason != "quota" {
			t.Errorf("checkStreamingQuotaError(%q) reason=%q, want quota", chunk, reason)
		}
	}
}

func TestCheckStreamingQuotaError_Capacity(t *testing.T) {
	cases := []string{
		`MODEL_CAPACITY_EXHAUSTED`,
		`No capacity available for model gemini-2.5-pro`,
	}
	for _, chunk := range cases {
		reason, _, _ := checkStreamingQuotaError(chunk)
		if reason != "capacity" {
			t.Errorf("checkStreamingQuotaError(%q) reason=%q, want capacity", chunk, reason)
		}
	}
}

func TestCheckStreamingQuotaError_NoError(t *testing.T) {
	reason, _, _ := checkStreamingQuotaError(`{"candidates":[{"content":"hello"}]}`)
	if reason != "" {
		t.Errorf("expected empty reason for normal content, got %q", reason)
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// cloudCodeAccountProblemReason
// ═══════════════════════════════════════════════════════════════════════════

func TestCloudCodeAccountProblemReason_429(t *testing.T) {
	reason := cloudCodeAccountProblemReason(429, `{"error":{"status":"RESOURCE_EXHAUSTED"}}`)
	if reason == "" {
		t.Error("expected non-empty reason for 429")
	}
}

func TestCloudCodeAccountProblemReason_403_ServiceDisabled(t *testing.T) {
	reason := cloudCodeAccountProblemReason(403, `Cloud Code Private API has not been used in project`)
	if reason == "" {
		t.Error("expected non-empty reason for 403 service_disabled")
	}
}

func TestCloudCodeAccountProblemReason_200(t *testing.T) {
	reason := cloudCodeAccountProblemReason(200, `{"result":"ok"}`)
	if reason != "" {
		t.Errorf("expected empty reason for 200, got %q", reason)
	}
}

func TestCloudCodeAccountProblemReason_400_LocationUnsupported(t *testing.T) {
	reason := cloudCodeAccountProblemReason(400, `User location is not supported for the API use`)
	if reason == "" {
		t.Error("expected non-empty reason for 400 location unsupported")
	}
}

func TestCloudCodeAccountProblemReason_400_Normal(t *testing.T) {
	reason := cloudCodeAccountProblemReason(400, `{"error":{"message":"invalid argument"}}`)
	if reason != "" {
		t.Errorf("expected empty reason for normal 400, got %q", reason)
	}
}

func TestCloudCodeAccountProblemReason_401(t *testing.T) {
	reason := cloudCodeAccountProblemReason(401, `{"error":{"code":401,"message":"Request had invalid authentication credentials.","status":"UNAUTHENTICATED"}}`)
	if reason == "" {
		t.Error("expected non-empty reason for 401")
	}
	if reason != "http_401_unauthenticated" {
		t.Errorf("got %q, expected 'http_401_unauthenticated'", reason)
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// isVerificationChallengeError / isLocationUnsupportedError
// ═══════════════════════════════════════════════════════════════════════════

func TestIsVerificationChallengeError(t *testing.T) {
	positives := []string{
		"Please verify your account",
		"validation_required",
		"PERMISSION_DENIED",
		"al_alert something",
	}
	for _, s := range positives {
		if !isVerificationChallengeError(s) {
			t.Errorf("isVerificationChallengeError(%q) = false, want true", s)
		}
	}
	if isVerificationChallengeError("normal error message") {
		t.Error("expected false for normal error")
	}
}

func TestIsLocationUnsupportedError(t *testing.T) {
	// Note: isLocationUnsupportedError expects already-lowercased input (called with lowerBody)
	positives := []string{
		"user location is not supported",
		"location is not supported for the api use",
		"failed_precondition: location is not supported",
	}
	for _, s := range positives {
		if !isLocationUnsupportedError(s) {
			t.Errorf("isLocationUnsupportedError(%q) = false, want true", s)
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// discountedCachedTokens / extractFieldCount
// ═══════════════════════════════════════════════════════════════════════════

func TestDiscountedCachedTokens(t *testing.T) {
	cases := map[int64]int64{
		0:    0,
		1:    1,     // ceil(1/10) = 1
		10:   1,     // ceil(10/10) = 1
		100:  10,    // ceil(100/10) = 10
		1000: 100,   // ceil(1000/10) = 100
		15:   2,     // ceil(15/10) = 2
		-5:   0,     // negative
	}
	for input, want := range cases {
		got := discountedCachedTokens(input)
		if got != want {
			t.Errorf("discountedCachedTokens(%d) = %d, want %d", input, got, want)
		}
	}
}

func TestExtractFieldCount(t *testing.T) {
	text := `{"usageMetadata":{"promptTokenCount":1234,"candidatesTokenCount":5678}}`
	input := extractFieldCount(text, "promptTokenCount", "inputTokenCount")
	if input != 1234 {
		t.Errorf("input tokens = %d, want 1234", input)
	}
	output := extractFieldCount(text, "candidatesTokenCount", "outputTokenCount")
	if output != 5678 {
		t.Errorf("output tokens = %d, want 5678", output)
	}
	missing := extractFieldCount(text, "missingField")
	if missing != 0 {
		t.Errorf("missing field = %d, want 0", missing)
	}
}

func TestExtractFieldCount_MultipleOccurrences(t *testing.T) {
	// usageMetadata appears multiple times in streaming chunks; should pick max
	text := `{"usageMetadata":{"promptTokenCount":100}}
	{"usageMetadata":{"promptTokenCount":500}}`
	got := extractFieldCount(text, "promptTokenCount")
	if got != 500 {
		t.Errorf("got %d, want 500 (max of occurrences)", got)
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// remoteRetryDelay
// ═══════════════════════════════════════════════════════════════════════════

func TestRemoteRetryDelay_WithinBounds(t *testing.T) {
	for attempt := 1; attempt <= 10; attempt++ {
		d := remoteRetryDelay(attempt)
		if d < 0 || d > 5000*1e6 { // 5000ms in nanoseconds
			t.Errorf("attempt %d: delay %v out of bounds [0, 5s]", attempt, d)
		}
	}
}

func TestRemoteRetryDelayForStatus_503MinFloor(t *testing.T) {
	d := remoteRetryDelayForStatus(1, 503)
	if d < 2000*1e6 { // 2000ms
		t.Errorf("503 delay = %v, expected >= 2s", d)
	}
}

func TestRemoteRetryDelayForStatus_429MinFloor(t *testing.T) {
	d := remoteRetryDelayForStatus(1, 429)
	if d < 1000*1e6 { // 1000ms
		t.Errorf("429 delay = %v, expected >= 1s", d)
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// debugResponseBody
// ═══════════════════════════════════════════════════════════════════════════

func TestDebugResponseBody_PlainText(t *testing.T) {
	data := []byte("hello world")
	got := debugResponseBody(data, "", 100)
	if got != "hello world" {
		t.Errorf("got %q, want 'hello world'", got)
	}
}

func TestDebugResponseBody_Truncation(t *testing.T) {
	data := []byte("hello world this is a long string")
	got := debugResponseBody(data, "", 10)
	if got != "hello worl..." {
		t.Errorf("got %q, want 'hello worl...'", got)
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// getErrorSnippet
// ═══════════════════════════════════════════════════════════════════════════

func TestGetErrorSnippet_Short(t *testing.T) {
	got := getErrorSnippet("short error")
	if got != "short error" {
		t.Errorf("got %q", got)
	}
}

func TestGetErrorSnippet_Truncates(t *testing.T) {
	long := ""
	for i := 0; i < 200; i++ {
		long += "abcdefghij" // 2000 chars
	}
	got := getErrorSnippet(long)
	if len(got) > 1200 {
		t.Errorf("len = %d, want <= 1200", len(got))
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// buildAccountProblemReason / sanitizeAccountProblemReason
// ═══════════════════════════════════════════════════════════════════════════

func TestBuildAccountProblemReason(t *testing.T) {
	got := buildAccountProblemReason(429, "RESOURCE_EXHAUSTED")
	if got != "http_429_resource_exhausted" {
		t.Errorf("got %q", got)
	}
}

func TestSanitizeAccountProblemReason_SpecialChars(t *testing.T) {
	got := sanitizeAccountProblemReason("HTTP 403 Service@Disabled!")
	// Should be lowercase, special chars → underscore, no consecutive underscores
	if got == "" {
		t.Error("expected non-empty result")
	}
	// Should not contain special chars
	for _, r := range got {
		isAlphaNum := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_'
		if !isAlphaNum {
			t.Errorf("unexpected character %q in %q", string(r), got)
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// upstreamEndpointForPath / isUndefinedEndpoint / ideFallbackPayload
// ═══════════════════════════════════════════════════════════════════════════

func TestUpstreamEndpointForPath(t *testing.T) {
	cloudCode := upstreamEndpointForPath("/v1internal/something")
	if cloudCode != DefaultCloudEndpoint {
		t.Errorf("got %q, want %q", cloudCode, DefaultCloudEndpoint)
	}
	gemini := upstreamEndpointForPath("/v1beta/models/gemini:generate")
	if gemini != DefaultGeminiEndpoint {
		t.Errorf("got %q, want %q", gemini, DefaultGeminiEndpoint)
	}
}

func TestIsUndefinedEndpoint(t *testing.T) {
	if !isUndefinedEndpoint("/v1internal/undefined") {
		t.Error("expected true")
	}
	if !isUndefinedEndpoint("/some/path/undefined") {
		t.Error("expected true")
	}
	if isUndefinedEndpoint("/v1internal/something") {
		t.Error("expected false")
	}
}

func TestIdeFallbackPayload_Models(t *testing.T) {
	payload, ok := ideFallbackPayload("/v1internal:fetchAvailableModels")
	if !ok {
		t.Error("expected ok=true for fetchAvailableModels")
	}
	m, isMap := payload.(map[string]interface{})
	if !isMap {
		t.Fatal("expected map payload")
	}
	if _, hasModels := m["models"]; !hasModels {
		t.Error("expected models key in payload")
	}
}

func TestIdeFallbackPayload_Noise(t *testing.T) {
	payload, ok := ideFallbackPayload("/v1internal:listExperiments")
	if !ok {
		t.Error("expected ok=true for listExperiments")
	}
	m, isMap := payload.(map[string]interface{})
	if !isMap {
		t.Fatal("expected map payload")
	}
	if len(m) != 0 {
		t.Error("expected empty map for noise endpoints")
	}
}

func TestIdeFallbackPayload_Unknown(t *testing.T) {
	_, ok := ideFallbackPayload("/unknown/endpoint")
	if ok {
		t.Error("expected ok=false for unknown endpoint")
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// formatProjectId
// ═══════════════════════════════════════════════════════════════════════════

func TestFormatProjectId(t *testing.T) {
	if got := formatProjectId("old-project", "new-project"); got != "new-project" {
		t.Errorf("got %q", got)
	}
	if got := formatProjectId("projects/old-project", "new-project"); got != "projects/new-project" {
		t.Errorf("got %q, want projects/new-project", got)
	}
	if got := formatProjectId("", "new-project"); got != "new-project" {
		t.Errorf("got %q", got)
	}
	if got := formatProjectId(123, "new-project"); got != "new-project" {
		t.Errorf("got %q", got)
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// findFirstStringByKey
// ═══════════════════════════════════════════════════════════════════════════

func TestFindFirstStringByKey_Flat(t *testing.T) {
	data := map[string]interface{}{"model": "gemini-2.5-pro"}
	if got := findFirstStringByKey(data, "model"); got != "gemini-2.5-pro" {
		t.Errorf("got %q", got)
	}
}

func TestFindFirstStringByKey_Nested(t *testing.T) {
	data := map[string]interface{}{
		"config": map[string]interface{}{
			"model": "claude-opus-4",
		},
	}
	if got := findFirstStringByKey(data, "model"); got != "claude-opus-4" {
		t.Errorf("got %q", got)
	}
}

func TestFindFirstStringByKey_InArray(t *testing.T) {
	data := []interface{}{
		map[string]interface{}{"model": "flash"},
	}
	if got := findFirstStringByKey(data, "model"); got != "flash" {
		t.Errorf("got %q", got)
	}
}

func TestFindFirstStringByKey_Missing(t *testing.T) {
	data := map[string]interface{}{"other": "value"}
	if got := findFirstStringByKey(data, "model"); got != "" {
		t.Errorf("got %q, want empty", got)
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// googleErrorStatusAndReason
// ═══════════════════════════════════════════════════════════════════════════

func TestGoogleErrorStatusAndReason(t *testing.T) {
	body := `{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"reason":"RATE_LIMIT_EXCEEDED"}]}}`
	status, reason := googleErrorStatusAndReason(body)
	if status != "RESOURCE_EXHAUSTED" {
		t.Errorf("status = %q", status)
	}
	if reason != "RATE_LIMIT_EXCEEDED" {
		t.Errorf("reason = %q", reason)
	}
}

func TestGoogleErrorStatusAndReason_Empty(t *testing.T) {
	status, reason := googleErrorStatusAndReason("")
	if status != "" || reason != "" {
		t.Errorf("expected empty for invalid JSON")
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// firstNonEmpty
// ═══════════════════════════════════════════════════════════════════════════

func TestFirstNonEmpty(t *testing.T) {
	if got := firstNonEmpty("", "", "hello"); got != "hello" {
		t.Errorf("got %q", got)
	}
	if got := firstNonEmpty("first", "second"); got != "first" {
		t.Errorf("got %q", got)
	}
	if got := firstNonEmpty("", ""); got != "" {
		t.Errorf("got %q, want empty", got)
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// accountIdsFromSet
// ═══════════════════════════════════════════════════════════════════════════

func TestAccountIdsFromSet(t *testing.T) {
	set := map[int]bool{1: true, 3: true, 0: true, -1: true}
	ids := accountIdsFromSet(set)
	// Should only include positive IDs
	for _, id := range ids {
		if id <= 0 {
			t.Errorf("unexpected non-positive ID: %d", id)
		}
	}
	if len(ids) != 2 {
		t.Errorf("expected 2 positive IDs, got %d", len(ids))
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Consistency: remoteRetryDelay is exponential
// ═══════════════════════════════════════════════════════════════════════════

func TestRemoteRetryDelay_Increasing(t *testing.T) {
	// Average of many samples should increase with attempt
	// (can't test exact values due to jitter)
	var sum1, sum5 float64
	n := 100
	for i := 0; i < n; i++ {
		sum1 += float64(remoteRetryDelay(1))
		sum5 += float64(remoteRetryDelay(5))
	}
	avg1 := sum1 / float64(n)
	avg5 := sum5 / float64(n)
	if avg5 <= avg1 {
		t.Errorf("expected attempt 5 avg (%v) > attempt 1 avg (%v)", avg5, avg1)
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// parseDurationToMs edge cases
// ═══════════════════════════════════════════════════════════════════════════

func TestParseDurationToMs_Fractional(t *testing.T) {
	got := parseDurationToMs("1.5s")
	if got != 1500 {
		t.Errorf("got %d, want 1500", got)
	}
}

func TestParseDurationToMs_InContext(t *testing.T) {
	// Should extract from longer text
	got := parseDurationToMs("reset after 4h59m35s please wait")
	want := int64(4*3600000 + 59*60000 + 35000)
	if got != want {
		t.Errorf("got %d, want %d", got, want)
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// MaxCloudCodeGenerationAttempts constant sanity
// ═══════════════════════════════════════════════════════════════════════════

func TestMaxAttemptsSanity(t *testing.T) {
	if MaxCloudCodeGenerationAttempts < 1 || MaxCloudCodeGenerationAttempts > 50 {
		t.Errorf("MaxCloudCodeGenerationAttempts = %d, expected [1,50]", MaxCloudCodeGenerationAttempts)
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// extractFieldCount with thoughtsTokenCount
// ═══════════════════════════════════════════════════════════════════════════

func TestExtractFieldCount_ThoughtsTokenCount(t *testing.T) {
	text := `{"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":200,"thoughtsTokenCount":50}}`
	thoughts := extractFieldCount(text, "thoughtsTokenCount")
	if thoughts != 50 {
		t.Errorf("thoughts = %d, want 50", thoughts)
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// isLocationUnsupportedError — lowercase input requirement
// ═══════════════════════════════════════════════════════════════════════════

func TestIsLocationUnsupportedError_AlreadyLower(t *testing.T) {
	// The function expects lowercase input (called with lowerBody)
	if !isLocationUnsupportedError("user location is not supported") {
		t.Error("expected true")
	}
	if !isLocationUnsupportedError("failed_precondition and location and not supported") {
		t.Error("expected true for combined conditions")
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Ensure endpoints match expected values
// ═══════════════════════════════════════════════════════════════════════════

func TestDefaultEndpoints(t *testing.T) {
	if DefaultCloudEndpoint != "https://cloudcode-pa.googleapis.com" {
		t.Errorf("unexpected cloud endpoint: %s", DefaultCloudEndpoint)
	}
	if DefaultGeminiEndpoint != "https://generativelanguage.googleapis.com" {
		t.Errorf("unexpected gemini endpoint: %s", DefaultGeminiEndpoint)
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// buildFallbackModels structure
// ═══════════════════════════════════════════════════════════════════════════

func TestBuildFallbackModels(t *testing.T) {
	m := buildFallbackModels()
	models, ok := m["models"]
	if !ok {
		t.Fatal("missing models key")
	}
	modelsMap, ok := models.(map[string]interface{})
	if !ok {
		t.Fatal("models is not a map")
	}
	if len(modelsMap) == 0 {
		t.Error("expected at least one model in fallback")
	}
	if _, ok := m["defaultAgentModelId"]; !ok {
		t.Error("missing defaultAgentModelId")
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// classifyModel boundary: claude without opus
// ═══════════════════════════════════════════════════════════════════════════

func TestClassifyModel_ClaudeWithoutOpus(t *testing.T) {
	// "claude-sonnet-4" contains "claude" → should be classified as opus
	got := classifyModel("claude-sonnet-4")
	if got != "opus" {
		t.Errorf("classifyModel('claude-sonnet-4') = %q, want opus", got)
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Sanity: NaN / Infinity not returned from delay
// ═══════════════════════════════════════════════════════════════════════════

func TestRemoteRetryDelay_NoNaN(t *testing.T) {
	for i := 0; i < 100; i++ {
		d := remoteRetryDelay(i)
		ns := float64(d)
		if math.IsNaN(ns) || math.IsInf(ns, 0) {
			t.Errorf("attempt %d: NaN/Inf delay", i)
		}
	}
}
