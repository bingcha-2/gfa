package refreshcfg

import "testing"

func TestLoad_DefaultsWhenMissing(t *testing.T) {
	s := NewStore(t.TempDir())
	c := s.Load()
	if c.QuotaMinutes != defaultQuotaMinutes || c.CurrentMinutes != defaultCurrentMinutes {
		t.Fatalf("defaults wrong: %+v (want %d/%d)", c, defaultQuotaMinutes, defaultCurrentMinutes)
	}
}

func TestSaveLoad_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	if err := s.Save(Config{QuotaMinutes: 30, CurrentMinutes: 5}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	c := NewStore(dir).Load()
	if c.QuotaMinutes != 30 || c.CurrentMinutes != 5 {
		t.Fatalf("round-trip wrong: %+v", c)
	}
}

func TestSave_ClampsNonPositiveToDefault(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	if err := s.Save(Config{QuotaMinutes: 0, CurrentMinutes: -3}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	c := s.Load()
	if c.QuotaMinutes != defaultQuotaMinutes || c.CurrentMinutes != defaultCurrentMinutes {
		t.Fatalf("non-positive should clamp to default: %+v", c)
	}
}
