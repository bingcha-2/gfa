package gatewaycfg

import "testing"

func TestOpsStore_DefaultAndTimeoutsRoundTrip(t *testing.T) {
	s := NewOpsStore(t.TempDir())
	cfg := s.Load()
	if cfg.Timeouts != DefaultTimeouts() {
		t.Fatalf("default timeouts = %+v, want %+v", cfg.Timeouts, DefaultTimeouts())
	}
	if len(cfg.TimeoutPresets) != 0 {
		t.Fatalf("expected no presets, got %d", len(cfg.TimeoutPresets))
	}

	want := Timeouts{StreamKeepaliveSeconds: 15, StreamBootstrapRetries: 2, MaxRetryCredentials: 3, MaxRetryIntervalSeconds: 30}
	if _, err := s.SaveTimeouts(want); err != nil {
		t.Fatalf("SaveTimeouts: %v", err)
	}
	// 新 store 读同一路径,确认落盘。
	got := NewOpsStore(dirOf(s)).Load()
	if got.Timeouts != want {
		t.Fatalf("reloaded timeouts = %+v, want %+v", got.Timeouts, want)
	}
}

func TestOpsStore_TimeoutsNegativeClampedToZero(t *testing.T) {
	s := NewOpsStore(t.TempDir())
	cfg, err := s.SaveTimeouts(Timeouts{StreamKeepaliveSeconds: -5, StreamBootstrapRetries: -1, MaxRetryCredentials: -2, MaxRetryIntervalSeconds: -3})
	if err != nil {
		t.Fatalf("SaveTimeouts: %v", err)
	}
	if cfg.Timeouts != (Timeouts{}) {
		t.Fatalf("negatives should clamp to 0, got %+v", cfg.Timeouts)
	}
}

func TestOpsStore_PresetsSaveActivate(t *testing.T) {
	s := NewOpsStore(t.TempDir())
	presets := []TimeoutPreset{
		{ID: "fast", Name: "快", Timeouts: Timeouts{StreamKeepaliveSeconds: 5}},
		{ID: "long", Name: "长等待", Timeouts: Timeouts{StreamKeepaliveSeconds: 60, MaxRetryIntervalSeconds: 120}},
	}
	cfg, err := s.SavePresets(presets)
	if err != nil {
		t.Fatalf("SavePresets: %v", err)
	}
	if len(cfg.TimeoutPresets) != 2 {
		t.Fatalf("expected 2 presets, got %d", len(cfg.TimeoutPresets))
	}
	if cfg.TimeoutPresets[0].CreatedAt == 0 || cfg.TimeoutPresets[0].UpdatedAt == 0 {
		t.Fatal("expected timestamps filled")
	}

	cfg, err = s.ActivatePreset("long")
	if err != nil {
		t.Fatalf("ActivatePreset: %v", err)
	}
	if cfg.ActivePresetID != "long" || cfg.Timeouts.StreamKeepaliveSeconds != 60 || cfg.Timeouts.MaxRetryIntervalSeconds != 120 {
		t.Fatalf("activate did not apply preset timeouts: %+v", cfg)
	}

	if _, err := s.ActivatePreset("nope"); err == nil {
		t.Fatal("expected error activating unknown preset")
	}
}

func TestOpsStore_ActivePresetClearedWhenDeleted(t *testing.T) {
	s := NewOpsStore(t.TempDir())
	_, _ = s.SavePresets([]TimeoutPreset{{ID: "x", Name: "X"}})
	_, _ = s.ActivatePreset("x")
	cfg, err := s.SavePresets([]TimeoutPreset{{ID: "y", Name: "Y"}})
	if err != nil {
		t.Fatalf("SavePresets: %v", err)
	}
	if cfg.ActivePresetID != "" {
		t.Fatalf("active preset should clear when removed, got %q", cfg.ActivePresetID)
	}
}

func TestOpsStore_PresetsRejectMissingFields(t *testing.T) {
	s := NewOpsStore(t.TempDir())
	if _, err := s.SavePresets([]TimeoutPreset{{ID: "", Name: "x"}}); err == nil {
		t.Fatal("expected error on empty id")
	}
	if _, err := s.SavePresets([]TimeoutPreset{{ID: "a", Name: "  "}}); err == nil {
		t.Fatal("expected error on blank name")
	}
}

func TestOpsStore_UpstreamProxyRoundTripAndValidation(t *testing.T) {
	s := NewOpsStore(t.TempDir())
	for _, ok := range []string{"http://127.0.0.1:8080", "socks5://127.0.0.1:1080", "socks5h://h:1", "https://p:443", ""} {
		if _, err := s.SaveUpstreamProxy(ok); err != nil {
			t.Fatalf("SaveUpstreamProxy(%q) unexpected err: %v", ok, err)
		}
	}
	cfg := s.Load()
	if cfg.UpstreamProxyURL != "" {
		t.Fatalf("empty proxy should clear, got %q", cfg.UpstreamProxyURL)
	}
	if _, err := s.SaveUpstreamProxy("ftp://x:1"); err == nil {
		t.Fatal("expected error on unsupported scheme")
	}
	if _, err := s.SaveUpstreamProxy("http://"); err == nil {
		t.Fatal("expected error on missing host")
	}
	if _, err := s.SaveUpstreamProxy("::::not a url"); err == nil {
		t.Fatal("expected error on unparseable url")
	}
}

// dirOf 从 store 的落盘路径回推目录(测试内省用)。
func dirOf(s *OpsStore) string {
	// path 形如 <dir>/gateway-ops.json
	d := s.path
	for i := len(d) - 1; i >= 0; i-- {
		if d[i] == '/' {
			return d[:i]
		}
	}
	return "."
}
