package economy

import "testing"

func TestResolvePresetDefault(t *testing.T) {
	if got := ResolveContextPreset(nil, nil); got != PresetDefault {
		t.Fatalf("nil/nil must be default, got %q", got)
	}
}

func TestResolvePreset516K(t *testing.T) {
	cw, ac := int64(contextWindow516K), int64(autoCompact516K)
	if got := ResolveContextPreset(&cw, &ac); got != Preset516K {
		t.Fatalf("want preset_516k, got %q", got)
	}
}

func TestResolvePreset1M(t *testing.T) {
	cw, ac := int64(contextWindow1M), int64(autoCompact1M)
	if got := ResolveContextPreset(&cw, &ac); got != Preset1M {
		t.Fatalf("want preset_1m, got %q", got)
	}
}

func TestResolvePresetCustom(t *testing.T) {
	cw, ac := int64(700000), int64(600000)
	if got := ResolveContextPreset(&cw, &ac); got != PresetCustom {
		t.Fatalf("arbitrary values must be custom, got %q", got)
	}
}

func TestPresetContextValuesDefaultClearsKeys(t *testing.T) {
	cw, ac := PresetContextValues(PresetDefault)
	if cw != nil || ac != nil {
		t.Fatalf("default preset must clear both keys, got cw=%v ac=%v", cw, ac)
	}
}

func TestPresetContextValues516K(t *testing.T) {
	cw, ac := PresetContextValues(Preset516K)
	if cw == nil || *cw != contextWindow516K || ac == nil || *ac != autoCompact516K {
		t.Fatalf("516k values mismatch cw=%v ac=%v", cw, ac)
	}
}

func TestPresetContextValues1M(t *testing.T) {
	cw, ac := PresetContextValues(Preset1M)
	if cw == nil || *cw != contextWindow1M || ac == nil || *ac != autoCompact1M {
		t.Fatalf("1m values mismatch cw=%v ac=%v", cw, ac)
	}
}

func TestServiceTierValueFast(t *testing.T) {
	if got, set := ServiceTierValue(TierFast); !set || got != serviceTierPriority {
		t.Fatalf("fast tier must set %q, got %q set=%v", serviceTierPriority, got, set)
	}
}

func TestServiceTierValueStandardRemovesKey(t *testing.T) {
	if _, set := ServiceTierValue(TierStandard); set {
		t.Fatalf("standard tier must remove the key (set=false)")
	}
}

func TestNormalizeServiceTier(t *testing.T) {
	cases := map[string]ServiceTier{
		"fast":     TierFast,
		"priority": TierFast,
		"flex":     TierFast,
		"":         TierStandard,
		"default":  TierStandard,
		"standard": TierStandard,
	}
	for in, want := range cases {
		if got := NormalizeServiceTier(in); got != want {
			t.Fatalf("normalize %q want %v got %v", in, want, got)
		}
	}
}

func TestAppSpeedRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := NewSpeedStore(dir)

	got := s.Load()
	if got.ContextPreset != PresetDefault || got.Tier != TierStandard {
		t.Fatalf("default app speed mismatch: %+v", got)
	}

	want := AppSpeed{
		ContextPreset:       Preset516K,
		Tier:                TierFast,
		CustomContextWindow: 0,
		CustomAutoCompact:   0,
	}
	if err := s.Save(want); err != nil {
		t.Fatalf("save: %v", err)
	}
	reloaded := NewSpeedStore(dir).Load()
	if reloaded.ContextPreset != Preset516K || reloaded.Tier != TierFast {
		t.Fatalf("round trip mismatch: %+v", reloaded)
	}
	if err := s.Save(want); err != nil {
		t.Fatalf("idempotent save: %v", err)
	}
}

func TestAppSpeedResolveCustomValues(t *testing.T) {
	sp := AppSpeed{ContextPreset: PresetCustom, CustomContextWindow: 800000, CustomAutoCompact: 700000}
	cw, ac := sp.ContextValues()
	if cw == nil || *cw != 800000 || ac == nil || *ac != 700000 {
		t.Fatalf("custom context values mismatch cw=%v ac=%v", cw, ac)
	}
}

func TestAppSpeedResolvePresetValues(t *testing.T) {
	sp := AppSpeed{ContextPreset: Preset1M}
	cw, ac := sp.ContextValues()
	if cw == nil || *cw != contextWindow1M || ac == nil || *ac != autoCompact1M {
		t.Fatalf("preset context values mismatch cw=%v ac=%v", cw, ac)
	}
}

func TestAppSpeedCustomRejectsNonPositive(t *testing.T) {
	sp := AppSpeed{ContextPreset: PresetCustom, CustomContextWindow: 0, CustomAutoCompact: 0}
	cw, ac := sp.ContextValues()
	if cw != nil || ac != nil {
		t.Fatalf("non-positive custom values must clear keys, got cw=%v ac=%v", cw, ac)
	}
}
