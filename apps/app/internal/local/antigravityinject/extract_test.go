package antigravityinject

import "testing"

// ExtractToken 应是 InjectToPath 的逆:注入一份 token 后,从同一个 state.vscdb
// 解码回 access/refresh/id_token/email/project,字段一致。
func TestExtractToken_RoundTrip(t *testing.T) {
	path, _ := openTestDB(t)
	in := Token{
		AccessToken: "AT123", RefreshToken: "RT456", Expiry: 1893456000,
		IDToken: "IDTOK", Email: "user@example.com", ProjectID: "proj-1", IsGCPTos: true,
	}
	if err := InjectToPath(path, in); err != nil {
		t.Fatalf("inject: %v", err)
	}

	out, err := ExtractToken(path)
	if err != nil {
		t.Fatalf("ExtractToken: %v", err)
	}
	if out.AccessToken != "AT123" || out.RefreshToken != "RT456" || out.IDToken != "IDTOK" {
		t.Fatalf("tokens mismatch: %+v", out)
	}
	if out.Email != "user@example.com" {
		t.Fatalf("email mismatch: %q", out.Email)
	}
	if out.ProjectID != "proj-1" {
		t.Fatalf("project mismatch: %q", out.ProjectID)
	}
	if out.Expiry != 1893456000 {
		t.Fatalf("expiry mismatch: %d", out.Expiry)
	}
}

// 个人号(无 project):ProjectID 为空,仍能取 email + token。
func TestExtractToken_PersonalNoProject(t *testing.T) {
	path, _ := openTestDB(t)
	if err := InjectToPath(path, Token{AccessToken: "AT", RefreshToken: "RT", Email: "p@gmail.com"}); err != nil {
		t.Fatalf("inject: %v", err)
	}
	out, err := ExtractToken(path)
	if err != nil {
		t.Fatalf("ExtractToken: %v", err)
	}
	if out.AccessToken != "AT" || out.Email != "p@gmail.com" {
		t.Fatalf("personal mismatch: %+v", out)
	}
	if out.ProjectID != "" {
		t.Fatalf("expected empty project, got %q", out.ProjectID)
	}
}

// 无 oauthToken(IDE 未登录):返回错误。
func TestExtractToken_NotLoggedIn(t *testing.T) {
	path, _ := openTestDB(t)
	if _, err := ExtractToken(path); err == nil {
		t.Fatal("expected error when no oauth token present")
	}
}
