package manager

import (
	"context"
	"errors"
	"testing"
	"time"

	"bcai-wails/internal/local/account"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

// promptLoginStub 用 loginPromptFn 模拟一个「等待手动回调 URL」的 SDK 登录:
// 调用 prompt 拿到 URL,把 URL 原样当作 email 记进账号,便于断言喂入生效。
func promptLoginStub(gotURL *string) LoginPromptFunc {
	return func(ctx context.Context, _ *config.Config, prompt func(string) (string, error)) (*account.Account, error) {
		url, err := prompt("paste callback url")
		if err != nil {
			return nil, err
		}
		if gotURL != nil {
			*gotURL = url
		}
		return &account.Account{Provider: account.ProviderCodex, Email: url, AuthKind: account.AuthOAuth, PoolEnabled: true}, nil
	}
}

func TestSubmitLoginCallback_CompletesLogin(t *testing.T) {
	m, acc, _ := newMgr(t)
	var got string
	m.SetPromptLogin(promptLoginStub(&got))

	id := m.StartLogin()
	// StartLogin 异步,给 goroutine 一点时间进入 prompt 阻塞。
	callbackURL := "http://localhost:1455/auth/callback?code=CODE1&state=STATE1"
	if err := waitUntilSubmitAccepted(m, id, callbackURL); err != nil {
		t.Fatalf("submit: %v", err)
	}

	v, err := m.WaitLogin(id)
	if err != nil {
		t.Fatalf("wait: %v", err)
	}
	if got != callbackURL {
		t.Fatalf("prompt did not receive submitted URL: got %q", got)
	}
	if v.Email != callbackURL {
		t.Fatalf("login view wrong: %+v", v)
	}
	list, _ := acc.List(account.ProviderCodex)
	if len(list) != 1 {
		t.Fatalf("expected saved account, got %d", len(list))
	}
}

func TestSubmitLoginCallback_RejectsInvalidURL(t *testing.T) {
	m, _, _ := newMgr(t)
	m.SetPromptLogin(promptLoginStub(nil))
	id := m.StartLogin()
	defer m.CancelLogin(id)
	if err := m.SubmitLoginCallback(id, "not-a-valid-callback"); err == nil {
		t.Fatal("expected invalid callback URL rejected before touching session")
	}
}

func TestSubmitLoginCallback_UnknownSession(t *testing.T) {
	m, _, _ := newMgr(t)
	if err := m.SubmitLoginCallback("bogus", "http://localhost/?code=x&state=y"); err == nil {
		t.Fatal("expected unknown session error")
	}
}

func TestCancelLogin_UnblocksPrompt(t *testing.T) {
	m, _, _ := newMgr(t)
	m.SetPromptLogin(promptLoginStub(nil))
	id := m.StartLogin()

	if err := m.CancelLogin(id); err != nil {
		t.Fatalf("cancel: %v", err)
	}

	done := make(chan struct{})
	var waitErr error
	go func() {
		_, waitErr = m.WaitLogin(id)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("WaitLogin did not return after cancel (prompt still blocked)")
	}
	if waitErr == nil {
		t.Fatal("expected error after cancel")
	}
	if !errors.Is(waitErr, ErrLoginCanceled) {
		t.Fatalf("expected ErrLoginCanceled, got %v", waitErr)
	}
}

func TestCancelLogin_UnknownSession(t *testing.T) {
	m, _, _ := newMgr(t)
	if err := m.CancelLogin("nope"); err == nil {
		t.Fatal("expected unknown session error")
	}
}

func TestCancelLogin_Idempotent(t *testing.T) {
	m, _, _ := newMgr(t)
	m.SetPromptLogin(promptLoginStub(nil))
	id := m.StartLogin()
	if err := m.CancelLogin(id); err != nil {
		t.Fatalf("first cancel: %v", err)
	}
	// second cancel must not panic (double close guard) and must not error.
	if err := m.CancelLogin(id); err != nil {
		t.Fatalf("second cancel should be no-op, got %v", err)
	}
	_, _ = m.WaitLogin(id)
}

func TestSubmitLoginCallback_AfterCancel(t *testing.T) {
	m, _, _ := newMgr(t)
	m.SetPromptLogin(promptLoginStub(nil))
	id := m.StartLogin()
	_ = m.CancelLogin(id)
	_, _ = m.WaitLogin(id)
	if err := m.SubmitLoginCallback(id, "http://localhost/?code=x&state=y"); err == nil {
		t.Fatal("expected submit after cancel to fail")
	}
}

// waitUntilSubmitAccepted 轮询 SubmitLoginCallback 直到被接受(prompt 已就绪)或超时。
func waitUntilSubmitAccepted(m *Manager, id, url string) error {
	deadline := time.Now().Add(2 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		lastErr = m.SubmitLoginCallback(id, url)
		if lastErr == nil {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	if lastErr == nil {
		lastErr = errors.New("timed out")
	}
	return lastErr
}
