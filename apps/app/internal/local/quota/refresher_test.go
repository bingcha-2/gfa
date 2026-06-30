package quota

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"bcai-wails/internal/local/account"
)

func TestCodexRefresher_TokenExpired(t *testing.T) {
	r := NewCodexRefresher(CodexEndpoints{})
	past := &account.Account{AccessToken: jwtWith(t, map[string]any{"exp": time.Now().Add(-time.Hour).Unix()})}
	future := &account.Account{AccessToken: jwtWith(t, map[string]any{"exp": time.Now().Add(time.Hour).Unix()})}
	if !r.TokenExpired(past) {
		t.Fatal("past token should be expired")
	}
	if r.TokenExpired(future) {
		t.Fatal("future token should not be expired")
	}
}

func TestCodexRefresher_RefreshToken_WritesBack(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id_token": "nid", "access_token": "nacc", "refresh_token": "nref",
		})
	}))
	defer srv.Close()
	r := NewCodexRefresher(CodexEndpoints{TokenURL: srv.URL + "/t"})
	a := &account.Account{IDToken: "oid", AccessToken: "oacc", RefreshToken: "oref"}
	if err := r.RefreshToken(a); err != nil {
		t.Fatalf("RefreshToken: %v", err)
	}
	if a.AccessToken != "nacc" || a.RefreshToken != "nref" || a.IDToken != "nid" {
		t.Fatalf("token not written back: %+v", a)
	}
}

func TestAntigravityRefresher_RefreshToken_WritesBack(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "ag-new", "expires_in": 3600})
	}))
	defer srv.Close()
	r := NewAntigravityRefresher(AntigravityEndpoints{TokenURL: srv.URL + "/t"})
	a := &account.Account{AccessToken: "old", RefreshToken: "ref"}
	if err := r.RefreshToken(a); err != nil {
		t.Fatalf("RefreshToken: %v", err)
	}
	if a.AccessToken != "ag-new" {
		t.Fatalf("access not written back: %+v", a)
	}
	if a.Expiry <= time.Now().Unix() {
		t.Fatalf("expiry not written back: %+v", a)
	}
}

// TestAntigravityRefresher_TokenExpired:用 account.Expiry(unix 秒)判,留 60s skew。
func TestAntigravityRefresher_TokenExpired(t *testing.T) {
	r := NewAntigravityRefresher(AntigravityEndpoints{})
	if !r.TokenExpired(&account.Account{Expiry: time.Now().Add(-time.Hour).Unix()}) {
		t.Fatal("past expiry should be expired")
	}
	if r.TokenExpired(&account.Account{Expiry: time.Now().Add(time.Hour).Unix()}) {
		t.Fatal("future expiry should not be expired")
	}
	// Expiry=0(未知)按未过期(不主动续约)。
	if r.TokenExpired(&account.Account{Expiry: 0}) {
		t.Fatal("unknown expiry should not be treated as expired")
	}
}

// TestAntigravityRefresher_FetchQuota_ProbesAndReturnsFull:轻探(刷 token 即视为存活),
// 额度细项 antigravity 不暴露,返回满血占位(保活语义)。
func TestAntigravityRefresher_FetchQuota_LightProbe(t *testing.T) {
	r := NewAntigravityRefresher(AntigravityEndpoints{})
	res, err := r.FetchQuota(&account.Account{AccessToken: "x"})
	if err != nil {
		t.Fatalf("FetchQuota: %v", err)
	}
	if res.HourlyPercent != 100 || res.WeeklyPercent != 100 {
		t.Fatalf("light probe should return full, got %d/%d", res.HourlyPercent, res.WeeklyPercent)
	}
}
