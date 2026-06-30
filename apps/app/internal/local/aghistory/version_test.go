package aghistory

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseProductJSONUsesIdeVersion(t *testing.T) {
	content := []byte(`{"nameShort":"Antigravity","ideVersion":"1.4.2","version":"0.0.0"}`)
	info, ok := ParseProductJSON(content)
	if !ok {
		t.Fatalf("ParseProductJSON ok = false, want true")
	}
	if info.Version != "1.4.2" {
		t.Errorf("Version = %q, want 1.4.2 (ideVersion preferred over version)", info.Version)
	}
	if info.ProductName != "Antigravity" {
		t.Errorf("ProductName = %q, want Antigravity", info.ProductName)
	}
	if info.Source != "product.json" {
		t.Errorf("Source = %q, want product.json", info.Source)
	}
}

func TestParseProductJSONFallsBackToVersion(t *testing.T) {
	content := []byte(`{"nameLong":"Antigravity IDE","version":"2.0.0"}`)
	info, ok := ParseProductJSON(content)
	if !ok {
		t.Fatalf("ok = false, want true")
	}
	if info.Version != "2.0.0" {
		t.Errorf("Version = %q, want 2.0.0", info.Version)
	}
	if info.ProductName != "Antigravity IDE" {
		t.Errorf("ProductName = %q, want Antigravity IDE", info.ProductName)
	}
}

func TestParseProductJSONDefaultsProductName(t *testing.T) {
	content := []byte(`{"version":"3.1.0"}`)
	info, ok := ParseProductJSON(content)
	if !ok {
		t.Fatalf("ok = false, want true")
	}
	if info.ProductName != "Antigravity" {
		t.Errorf("ProductName = %q, want default Antigravity", info.ProductName)
	}
}

func TestParseProductJSONNoVersionFails(t *testing.T) {
	content := []byte(`{"nameShort":"Antigravity"}`)
	if _, ok := ParseProductJSON(content); ok {
		t.Fatalf("ok = true, want false when no version field present")
	}
}

func TestParseProductJSONBlankVersionFails(t *testing.T) {
	content := []byte(`{"ideVersion":"   ","version":""}`)
	if _, ok := ParseProductJSON(content); ok {
		t.Fatalf("ok = true, want false when version is blank/whitespace")
	}
}

func TestParseProductJSONInvalidJSONFails(t *testing.T) {
	if _, ok := ParseProductJSON([]byte("{not json")); ok {
		t.Fatalf("ok = true, want false on invalid json")
	}
}

func TestReadProductJSONFromPath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "product.json")
	if err := os.WriteFile(path, []byte(`{"nameShort":"Antigravity","ideVersion":"9.9.9"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	info, ok := ReadVersionFile(path)
	if !ok {
		t.Fatalf("ReadVersionFile ok = false, want true")
	}
	if info.Version != "9.9.9" {
		t.Errorf("Version = %q, want 9.9.9", info.Version)
	}
	if info.AppPath != path {
		t.Errorf("AppPath = %q, want %q (caller-supplied path)", info.AppPath, path)
	}
}

func TestReadVersionFileMissingFails(t *testing.T) {
	if _, ok := ReadVersionFile(filepath.Join(t.TempDir(), "nope.json")); ok {
		t.Fatalf("ok = true, want false for missing file")
	}
}

func TestReadVersionFilePlistContent(t *testing.T) {
	// plutil -p style text (caller may supply an already-dumped Info.plist .txt)
	dir := t.TempDir()
	path := filepath.Join(dir, "Info.plist.txt")
	dump := `{
  "CFBundleShortVersionString" => "1.2.3"
  "CFBundleDisplayName" => "Antigravity IDE"
  "CFBundleName" => "Antigravity"
}`
	if err := os.WriteFile(path, []byte(dump), 0o600); err != nil {
		t.Fatal(err)
	}
	info, ok := ReadVersionFile(path)
	if !ok {
		t.Fatalf("ReadVersionFile(plist dump) ok = false, want true")
	}
	if info.Version != "1.2.3" {
		t.Errorf("Version = %q, want 1.2.3", info.Version)
	}
	if info.ProductName != "Antigravity IDE" {
		t.Errorf("ProductName = %q, want Antigravity IDE (DisplayName preferred)", info.ProductName)
	}
	if info.Source != "Info.plist" {
		t.Errorf("Source = %q, want Info.plist", info.Source)
	}
}

func TestParsePlistDumpFallsBackBundleVersion(t *testing.T) {
	dump := `{
  "CFBundleVersion" => "44"
  "CFBundleName" => "Antigravity"
}`
	info, ok := ParsePlistDump([]byte(dump))
	if !ok {
		t.Fatalf("ok = false, want true")
	}
	if info.Version != "44" {
		t.Errorf("Version = %q, want 44 (CFBundleVersion fallback)", info.Version)
	}
	if info.ProductName != "Antigravity" {
		t.Errorf("ProductName = %q, want Antigravity (CFBundleName fallback)", info.ProductName)
	}
}

func TestParsePlistDumpNoVersionFails(t *testing.T) {
	if _, ok := ParsePlistDump([]byte(`{ "CFBundleName" => "Antigravity" }`)); ok {
		t.Fatalf("ok = true, want false when no version key")
	}
}
