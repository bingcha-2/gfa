package aghistory

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func sampleItem(id string, ts int64, email string) SwitchHistoryItem {
	return SwitchHistoryItem{
		ID:              id,
		Timestamp:       ts,
		AccountID:       "acc-" + id,
		TargetEmail:     email,
		TriggerType:     "manual",
		TriggerSource:   "tools.account.switch",
		LocalOK:         true,
		SeamlessOK:      true,
		Success:         true,
		LocalDurationMs: 12,
		TotalDurationMs: 34,
	}
}

func TestLoadMissingReturnsEmpty(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)

	got, err := store.Load()
	if err != nil {
		t.Fatalf("Load() err = %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("Load() = %d items, want 0", len(got))
	}
	if _, statErr := os.Stat(filepath.Join(dir, historyFile)); !os.IsNotExist(statErr) {
		t.Fatalf("Load() must not create file when missing, stat err = %v", statErr)
	}
}

func TestAddThenLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)

	if err := store.Add(sampleItem("a", 100, "a@x.com")); err != nil {
		t.Fatalf("Add() err = %v", err)
	}
	got, err := store.Load()
	if err != nil {
		t.Fatalf("Load() err = %v", err)
	}
	if len(got) != 1 || got[0].ID != "a" || got[0].TargetEmail != "a@x.com" {
		t.Fatalf("round-trip = %+v", got)
	}
}

func TestAddSortsByTimestampDescending(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)

	for _, it := range []SwitchHistoryItem{
		sampleItem("old", 100, "o@x.com"),
		sampleItem("new", 300, "n@x.com"),
		sampleItem("mid", 200, "m@x.com"),
	} {
		if err := store.Add(it); err != nil {
			t.Fatalf("Add() err = %v", err)
		}
	}
	got, _ := store.Load()
	want := []string{"new", "mid", "old"}
	if len(got) != len(want) {
		t.Fatalf("got %d items, want %d", len(got), len(want))
	}
	for i, id := range want {
		if got[i].ID != id {
			t.Fatalf("item[%d].ID = %q, want %q", i, got[i].ID, id)
		}
	}
}

func TestAddDedupesByID(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)

	if err := store.Add(sampleItem("dup", 100, "first@x.com")); err != nil {
		t.Fatal(err)
	}
	if err := store.Add(sampleItem("dup", 200, "second@x.com")); err != nil {
		t.Fatal(err)
	}
	got, _ := store.Load()
	if len(got) != 1 {
		t.Fatalf("got %d items, want 1 (deduped)", len(got))
	}
	if got[0].TargetEmail != "second@x.com" || got[0].Timestamp != 200 {
		t.Fatalf("dedupe kept stale item: %+v", got[0])
	}
}

func TestAddTruncatesToMax(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)

	total := maxHistoryItems + 25
	for i := 0; i < total; i++ {
		if err := store.Add(sampleItem(strconv.Itoa(i), int64(i), "x@x.com")); err != nil {
			t.Fatalf("Add() #%d err = %v", i, err)
		}
	}
	got, _ := store.Load()
	if len(got) != maxHistoryItems {
		t.Fatalf("len = %d, want capped at %d", len(got), maxHistoryItems)
	}
	// 最新(最大 timestamp)应保留,最旧应被截断
	if got[0].Timestamp != int64(total-1) {
		t.Fatalf("newest timestamp = %d, want %d", got[0].Timestamp, total-1)
	}
}

func TestClearEmptiesHistory(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)

	if err := store.Add(sampleItem("a", 100, "a@x.com")); err != nil {
		t.Fatal(err)
	}
	if err := store.Clear(); err != nil {
		t.Fatalf("Clear() err = %v", err)
	}
	got, err := store.Load()
	if err != nil {
		t.Fatalf("Load() after Clear err = %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("after Clear got %d items, want 0", len(got))
	}
}

func TestLoadCorruptReturnsEmpty(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, historyFile), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := NewStore(dir).Load()
	if err != nil {
		t.Fatalf("corrupt Load() err = %v, want nil (tolerant)", err)
	}
	if len(got) != 0 {
		t.Fatalf("corrupt Load() = %d items, want 0", len(got))
	}
}

func TestLoadEmptyFileReturnsEmpty(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, historyFile), []byte("   \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := NewStore(dir).Load()
	if err != nil {
		t.Fatalf("Load() err = %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("empty-file Load() = %d items, want 0", len(got))
	}
}

func TestSaveIsAtomicNoTempLeftover(t *testing.T) {
	dir := t.TempDir()
	if err := NewStore(dir).Add(sampleItem("a", 1, "a@x.com")); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".tmp" {
			t.Fatalf("left temp file %q", e.Name())
		}
	}
}

func TestAutoSwitchReasonRoundTrip(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)
	it := sampleItem("r", 100, "r@x.com")
	it.AutoSwitchReason = &AutoSwitchReason{
		Rule:               "quota_below",
		Threshold:          20,
		ScopeMode:          "groups",
		SelectedGroupIDs:   []string{"g1"},
		SelectedGroupNames: []string{"Group 1"},
		HitGroups:          []AutoSwitchHitGroup{{GroupID: "g1", GroupName: "Group 1", Percentage: 15}},
		CandidateCount:     3,
		SelectedPolicy:     "lowest",
	}
	if err := store.Add(it); err != nil {
		t.Fatal(err)
	}
	got, _ := store.Load()
	if got[0].AutoSwitchReason == nil {
		t.Fatalf("AutoSwitchReason lost on round-trip")
	}
	if got[0].AutoSwitchReason.Rule != "quota_below" || got[0].AutoSwitchReason.CandidateCount != 3 {
		t.Fatalf("AutoSwitchReason corrupted: %+v", got[0].AutoSwitchReason)
	}
	if len(got[0].AutoSwitchReason.HitGroups) != 1 || got[0].AutoSwitchReason.HitGroups[0].Percentage != 15 {
		t.Fatalf("HitGroups corrupted: %+v", got[0].AutoSwitchReason.HitGroups)
	}
}
