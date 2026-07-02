package authsync

import (
	"context"
	"testing"

	"bcai-wails/internal/local/account"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
)

// 网关 core auth auto-refresh(15m)刷新 codex 令牌后会调 Store.Save 落新令牌。
// codex refresh token 轮换:旧 refresh_token 刷一次即作废。旧实现 Save 是 no-op,
// 丢弃轮换后的新令牌 → GFA 自己的额度/保活刷新拿旧令牌再刷 → 上游 refresh_token_reused(401)。
// 本测试锁住修复:Save 必须把轮换后的新 token 写回 account.Store(单一事实源)。
func TestStore_SaveWritesBackRotatedTokens(t *testing.T) {
	dir := t.TempDir()
	acc, err := account.OpenStore(dir + "/a.db")
	if err != nil {
		t.Fatal(err)
	}
	defer acc.Close()

	a := &account.Account{
		Provider: account.ProviderCodex, Email: "rot@y.com", AuthKind: account.AuthOAuth,
		AccessToken: "at_old", RefreshToken: "rt_old", IDToken: "id_old", PoolEnabled: true,
	}
	if err := acc.Add(a); err != nil {
		t.Fatal(err)
	}

	st := NewStore(acc, account.ProviderCodex)
	// 模拟网关刷新后回调:带轮换出来的新令牌。
	_, err = st.Save(context.Background(), &coreauth.Auth{
		ID: a.ID,
		Metadata: map[string]any{
			"access_token":  "at_new",
			"refresh_token": "rt_new",
			"id_token":      "id_new",
		},
	})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	got, err := acc.Get(a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.RefreshToken != "rt_new" {
		t.Fatalf("refresh_token 未写回:want rt_new, got %q", got.RefreshToken)
	}
	if got.AccessToken != "at_new" {
		t.Fatalf("access_token 未写回:want at_new, got %q", got.AccessToken)
	}
	if got.IDToken != "id_new" {
		t.Fatalf("id_token 未写回:want id_new, got %q", got.IDToken)
	}
}

// 未知 ID / 空 Auth 不应报错(网关可能对非持久化的临时 auth 调 Save)。
func TestStore_SaveUnknownIDNoError(t *testing.T) {
	dir := t.TempDir()
	acc, err := account.OpenStore(dir + "/a.db")
	if err != nil {
		t.Fatal(err)
	}
	defer acc.Close()

	st := NewStore(acc, account.ProviderCodex)
	if _, err := st.Save(context.Background(), &coreauth.Auth{ID: "nope", Metadata: map[string]any{"refresh_token": "x"}}); err != nil {
		t.Fatalf("未知 ID 不应报错: %v", err)
	}
	if _, err := st.Save(context.Background(), nil); err != nil {
		t.Fatalf("nil Auth 不应报错: %v", err)
	}
}
