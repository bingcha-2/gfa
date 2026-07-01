package codexsettings

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeConfigTOML(t *testing.T, dir, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, configTOMLName), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readConfigTOML(t *testing.T, dir string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, configTOMLName))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestReadQuickConfigMissingFile(t *testing.T) {
	dir := t.TempDir()
	got, err := ReadQuickConfig(dir)
	if err != nil {
		t.Fatalf("ReadQuickConfig() error = %v", err)
	}
	if got.ContextWindow1M {
		t.Errorf("ContextWindow1M = true, want false")
	}
	if got.AutoCompactTokenLimit != autoCompactDefaultLimit {
		t.Errorf("AutoCompactTokenLimit = %d, want %d", got.AutoCompactTokenLimit, autoCompactDefaultLimit)
	}
	if got.DetectedModelContextWindow != nil || got.DetectedAutoCompactTokenLimit != nil {
		t.Errorf("detected fields should be nil for missing file, got %+v", got)
	}
}

func TestReadQuickConfigDetects1M(t *testing.T) {
	dir := t.TempDir()
	writeConfigTOML(t, dir, "model_context_window = 1000000\nmodel_auto_compact_token_limit = 850000\n")
	got, err := ReadQuickConfig(dir)
	if err != nil {
		t.Fatalf("ReadQuickConfig() error = %v", err)
	}
	if !got.ContextWindow1M {
		t.Errorf("ContextWindow1M = false, want true for 1000000")
	}
	if got.AutoCompactTokenLimit != 850000 {
		t.Errorf("AutoCompactTokenLimit = %d, want 850000", got.AutoCompactTokenLimit)
	}
	if got.DetectedModelContextWindow == nil || *got.DetectedModelContextWindow != 1000000 {
		t.Errorf("DetectedModelContextWindow = %v, want 1000000", got.DetectedModelContextWindow)
	}
	if got.DetectedAutoCompactTokenLimit == nil || *got.DetectedAutoCompactTokenLimit != 850000 {
		t.Errorf("DetectedAutoCompactTokenLimit = %v, want 850000", got.DetectedAutoCompactTokenLimit)
	}
}

func TestReadQuickConfigIgnoresNonPositiveCompactLimit(t *testing.T) {
	dir := t.TempDir()
	writeConfigTOML(t, dir, "model_auto_compact_token_limit = 0\n")
	got, err := ReadQuickConfig(dir)
	if err != nil {
		t.Fatalf("ReadQuickConfig() error = %v", err)
	}
	if got.DetectedAutoCompactTokenLimit != nil {
		t.Errorf("DetectedAutoCompactTokenLimit = %v, want nil (filtered <=0)", got.DetectedAutoCompactTokenLimit)
	}
	if got.AutoCompactTokenLimit != autoCompactDefaultLimit {
		t.Errorf("AutoCompactTokenLimit = %d, want default %d", got.AutoCompactTokenLimit, autoCompactDefaultLimit)
	}
}

func TestSaveQuickConfigPreservesExistingStructure(t *testing.T) {
	dir := t.TempDir()
	original := `# my codex config
model = "gpt-5"

[model_providers.openai]
name = "OpenAI"
base_url = "https://api.openai.com/v1"
`
	writeConfigTOML(t, dir, original)

	cw := int64(1000000)
	acl := int64(900000)
	got, err := SaveQuickConfig(dir, &cw, &acl)
	if err != nil {
		t.Fatalf("SaveQuickConfig() error = %v", err)
	}
	if !got.ContextWindow1M {
		t.Errorf("returned ContextWindow1M = false, want true")
	}

	out := readConfigTOML(t, dir)
	// 既有内容必须保留
	if !strings.Contains(out, "# my codex config") {
		t.Errorf("comment lost:\n%s", out)
	}
	if !strings.Contains(out, `model = "gpt-5"`) {
		t.Errorf("model key lost:\n%s", out)
	}
	if !strings.Contains(out, "[model_providers.openai]") {
		t.Errorf("provider table lost:\n%s", out)
	}
	// 新键写入顶层
	if !strings.Contains(out, "model_context_window = 1000000") {
		t.Errorf("model_context_window not written:\n%s", out)
	}
	if !strings.Contains(out, "model_auto_compact_token_limit = 900000") {
		t.Errorf("model_auto_compact_token_limit not written:\n%s", out)
	}
}

func TestSaveQuickConfigUpdatesExistingKeyInPlace(t *testing.T) {
	dir := t.TempDir()
	writeConfigTOML(t, dir, "model_context_window = 272000\nmodel = \"gpt-5\"\n")
	cw := int64(1000000)
	if _, err := SaveQuickConfig(dir, &cw, nil); err != nil {
		t.Fatalf("SaveQuickConfig() error = %v", err)
	}
	out := readConfigTOML(t, dir)
	if strings.Contains(out, "272000") {
		t.Errorf("old value 272000 should be replaced:\n%s", out)
	}
	if !strings.Contains(out, "model_context_window = 1000000") {
		t.Errorf("new value not written:\n%s", out)
	}
	if strings.Count(out, "model_context_window") != 1 {
		t.Errorf("model_context_window should appear once, got:\n%s", out)
	}
}

func TestSaveQuickConfigNilRemovesKey(t *testing.T) {
	dir := t.TempDir()
	writeConfigTOML(t, dir, "model_context_window = 1000000\nmodel = \"gpt-5\"\n")
	if _, err := SaveQuickConfig(dir, nil, nil); err != nil {
		t.Fatalf("SaveQuickConfig() error = %v", err)
	}
	out := readConfigTOML(t, dir)
	if strings.Contains(out, "model_context_window") {
		t.Errorf("model_context_window should be removed when nil:\n%s", out)
	}
	if !strings.Contains(out, `model = "gpt-5"`) {
		t.Errorf("unrelated key must survive removal:\n%s", out)
	}
}

func TestSaveQuickConfigRejectsNonPositive(t *testing.T) {
	dir := t.TempDir()
	bad := int64(0)
	if _, err := SaveQuickConfig(dir, &bad, nil); err == nil {
		t.Errorf("SaveQuickConfig() with 0 context window should error")
	}
	badACL := int64(-5)
	if _, err := SaveQuickConfig(dir, nil, &badACL); err == nil {
		t.Errorf("SaveQuickConfig() with negative compact limit should error")
	}
}

func TestSaveQuickConfigEmptyFileNoChangeNoCreate(t *testing.T) {
	dir := t.TempDir()
	// 空目录 + 两个 nil:不创建文件,直接返回默认读取
	got, err := SaveQuickConfig(dir, nil, nil)
	if err != nil {
		t.Fatalf("SaveQuickConfig() error = %v", err)
	}
	if got.AutoCompactTokenLimit != autoCompactDefaultLimit {
		t.Errorf("AutoCompactTokenLimit = %d, want default", got.AutoCompactTokenLimit)
	}
	if _, statErr := os.Stat(filepath.Join(dir, configTOMLName)); !os.IsNotExist(statErr) {
		t.Errorf("config.toml should not be created when nothing to write, err = %v", statErr)
	}
}

func TestSaveQuickConfigAtomicNoTempLeftover(t *testing.T) {
	dir := t.TempDir()
	writeConfigTOML(t, dir, "model = \"gpt-5\"\n")
	cw := int64(1000000)
	if _, err := SaveQuickConfig(dir, &cw, nil); err != nil {
		t.Fatalf("SaveQuickConfig() error = %v", err)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".tmp" {
			t.Fatalf("left temp file %q", e.Name())
		}
	}
}

func TestSaveQuickConfigDoesNotTouchTableScopedKey(t *testing.T) {
	dir := t.TempDir()
	// 表内出现同名键时,不能被顶层 upsert 误伤。
	original := "model = \"gpt-5\"\n\n[some_table]\nmodel_context_window = 12345\n"
	writeConfigTOML(t, dir, original)
	cw := int64(1000000)
	if _, err := SaveQuickConfig(dir, &cw, nil); err != nil {
		t.Fatalf("SaveQuickConfig() error = %v", err)
	}
	out := readConfigTOML(t, dir)
	if !strings.Contains(out, "[some_table]\nmodel_context_window = 12345") {
		t.Errorf("table-scoped key must be untouched:\n%s", out)
	}
	// 顶层应新增一条(追加在表头之前)。
	if !strings.Contains(out, "model_context_window = 1000000") {
		t.Errorf("top-level key not added:\n%s", out)
	}
}

func TestSaveQuickConfigNoPrefixCollision(t *testing.T) {
	dir := t.TempDir()
	// 形似前缀的键(model_context_window_extra)不应被当作匹配。
	writeConfigTOML(t, dir, "model_context_window_extra = 7\n")
	cw := int64(1000000)
	if _, err := SaveQuickConfig(dir, &cw, nil); err != nil {
		t.Fatalf("SaveQuickConfig() error = %v", err)
	}
	out := readConfigTOML(t, dir)
	if !strings.Contains(out, "model_context_window_extra = 7") {
		t.Errorf("prefix-similar key must survive:\n%s", out)
	}
	if strings.Count(out, "model_context_window = 1000000") != 1 {
		t.Errorf("real key should be added exactly once:\n%s", out)
	}
}

func TestCodexHomeDirRespectsEnvOverride(t *testing.T) {
	t.Setenv("CODEX_HOME", `  "/custom/codex/home"  `)
	got := CodexHomeDir()
	if got != "/custom/codex/home" {
		t.Errorf("CodexHomeDir() = %q, want /custom/codex/home (trimmed+unquoted)", got)
	}
}

func TestCodexHomeDirFallsBackToHome(t *testing.T) {
	t.Setenv("CODEX_HOME", "")
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home dir")
	}
	want := filepath.Join(home, ".codex")
	if got := CodexHomeDir(); got != want {
		t.Errorf("CodexHomeDir() = %q, want %q", got, want)
	}
}
