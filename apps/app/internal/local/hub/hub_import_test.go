package hub

import (
	"os"
	"path/filepath"
	"testing"

	"bcai-wails/internal/local/account"
)

func TestImportCodexFromLocal(t *testing.T) {
	h, fp := newHub(t)
	dir := t.TempDir()
	authPath := filepath.Join(dir, "auth.json")
	if err := os.WriteFile(authPath, []byte(`{"OPENAI_API_KEY":null,"tokens":{"id_token":"id","access_token":"AT","refresh_token":"RT","account_id":"acc"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	fp.codexAuthPath = authPath

	n, err := h.ImportCodexFromLocal()
	if err != nil || n != 1 {
		t.Fatalf("ImportCodexFromLocal n=%d err=%v", n, err)
	}
	list, _ := h.acc.List(account.ProviderCodex)
	if len(list) != 1 || list[0].AccessToken != "AT" || list[0].AccountID != "acc" {
		t.Fatalf("imported account wrong: %+v", list)
	}

	// 再次导入相同号(email 为空,无去重键)会再加一条;但带 email 的会去重。验证 email 去重。
	_ = h.acc.Add(&account.Account{Provider: account.ProviderCodex, Email: "dup@x.com"})
	authPath2 := filepath.Join(dir, "auth2.json")
	_ = os.WriteFile(authPath2, []byte(`{"access_token":"AT2","refresh_token":"RT2","email":"dup@x.com"}`), 0o600)
	fp.codexAuthPath = authPath2
	n2, err := h.ImportCodexFromLocal()
	if err != nil {
		t.Fatal(err)
	}
	if n2 != 0 {
		t.Fatalf("expected dedup (0 added), got %d", n2)
	}
}

func TestImportCodexFromLocal_MissingFile(t *testing.T) {
	h, fp := newHub(t)
	fp.codexAuthPath = filepath.Join(t.TempDir(), "nope.json")
	if _, err := h.ImportCodexFromLocal(); err == nil {
		t.Fatal("expected error for missing auth.json")
	}
}

func TestImportCodexAuthFiles_MixedFormats(t *testing.T) {
	h, _ := newHub(t)
	contents := []string{
		// codex auth.json 单账号
		`{"access_token":"AT1","refresh_token":"RT1","email":"a@x.com"}`,
		// 我们导出的 ExportRecord[]
		`[{"email":"b@x.com","authKind":"oauth","accessToken":"ATB","refreshToken":"RTB"}]`,
		// 垃圾文本:跳过
		`garbage`,
		// 重复 a@x.com:去重
		`{"access_token":"AT1b","refresh_token":"RT1b","email":"a@x.com"}`,
	}
	n, err := h.ImportCodexAuthFiles(contents)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("expected 2 added (a,b; dup skipped), got %d", n)
	}
	list, _ := h.acc.List(account.ProviderCodex)
	if len(list) != 2 {
		t.Fatalf("store should have 2, got %d", len(list))
	}
}

func TestImportAntigravityAuthFiles(t *testing.T) {
	h, _ := newHub(t)
	contents := []string{
		// antigravity 凭证 JSON
		`{"access_token":"AT","refresh_token":"RT","id_token":"ID","email":"ag@x.com","project_id":"proj"}`,
		// 我们导出格式
		`[{"email":"ag2@x.com","authKind":"oauth","accessToken":"AT2"}]`,
	}
	n, err := h.ImportAntigravityAuthFiles(contents)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("expected 2 added, got %d", n)
	}
	list, _ := h.acc.List(account.ProviderAntigravity)
	var withProj *account.Account
	for _, a := range list {
		if a.Email == "ag@x.com" {
			withProj = a
		}
	}
	if withProj == nil || withProj.ProjectID != "proj" || withProj.IDToken != "ID" {
		t.Fatalf("antigravity credential not parsed: %+v", withProj)
	}
}

func TestSyncAntigravityFromIDE(t *testing.T) {
	h, fp := newHub(t)
	fp.ideToken = AntigravityToken{
		AccessToken: "AT", RefreshToken: "RT", IDToken: "ID",
		Email: "ide@x.com", ProjectID: "p", Expiry: 123, IsGCPTos: true,
	}
	n, err := h.SyncAntigravityFromIDE()
	if err != nil || n != 1 {
		t.Fatalf("SyncAntigravityFromIDE n=%d err=%v", n, err)
	}
	list, _ := h.acc.List(account.ProviderAntigravity)
	if len(list) != 1 || list[0].Email != "ide@x.com" || list[0].Expiry != 123 || !list[0].IsGCPTos {
		t.Fatalf("synced account wrong: %+v", list)
	}
	// 再次同步同号:去重。
	n2, _ := h.SyncAntigravityFromIDE()
	if n2 != 0 {
		t.Fatalf("expected dedup on second sync, got %d", n2)
	}
}

func TestSyncAntigravityFromIDE_NotLoggedIn(t *testing.T) {
	h, fp := newHub(t)
	fp.ideTokenErr = os.ErrNotExist
	if _, err := h.SyncAntigravityFromIDE(); err == nil {
		t.Fatal("expected error when IDE has no token")
	}
}
