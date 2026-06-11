package main

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

// rtFunc adapts a function to http.RoundTripper.
type rtFunc func(*http.Request) (*http.Response, error)

func (f rtFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// clientFactory builds a newClient(proxy) where dialing through any proxy in
// failProxies returns a transport error (代理拨不通), and every other proxy
// succeeds with a 200 whose body echoes "ok-<proxy>". It records, per proxy, the
// request body bytes it saw so a test can assert the retry replayed the body.
func clientFactory(failProxies map[string]bool, seenBody map[string][]byte) func(string) *http.Client {
	return func(proxy string) *http.Client {
		return &http.Client{Transport: rtFunc(func(r *http.Request) (*http.Response, error) {
			b, _ := io.ReadAll(r.Body)
			seenBody[proxy] = b
			if failProxies[proxy] {
				return nil, errors.New("dial fail via " + proxy)
			}
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(strings.NewReader("ok-" + proxy)),
				Header:     make(http.Header),
			}, nil
		})}
	}
}

func mustReq(t *testing.T, body []byte) *http.Request {
	t.Helper()
	req, err := http.NewRequest("POST", "https://upstream.test/v1/responses", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("build req: %v", err)
	}
	return req
}

func bodyOf(t *testing.T, resp *http.Response) string {
	t.Helper()
	b, _ := io.ReadAll(resp.Body)
	return string(b)
}

func TestResolveEgress(t *testing.T) {
	cases := []struct {
		name        string
		e           EgressInfo
		userProxy   string
		wantProxy   string
		wantBlocked bool
	}{
		{
			name:      "bound proxy wins over user proxy (any policy)",
			e:         EgressInfo{ProxyURL: "socks5://res:1080", EgressRequired: false},
			userProxy: "http://user:8080",
			wantProxy: "socks5://res:1080",
		},
		{
			name:      "bound proxy wins under required policy too",
			e:         EgressInfo{ProxyURL: "socks5://res:1080", EgressRequired: true},
			userProxy: "http://user:8080",
			wantProxy: "socks5://res:1080",
		},
		{
			name:        "required + no bound proxy => blocked (anthropic fail-closed)",
			e:           EgressInfo{ProxyURL: "", EgressRequired: true},
			userProxy:   "http://user:8080",
			wantBlocked: true,
		},
		{
			name:      "optional + no bound proxy => fall back to user proxy (fail-open)",
			e:         EgressInfo{ProxyURL: "", EgressRequired: false},
			userProxy: "http://user:8080",
			wantProxy: "http://user:8080",
		},
		{
			name:      "optional + no bound proxy + no user proxy => local direct (empty, resolved downstream)",
			e:         EgressInfo{ProxyURL: "", EgressRequired: false},
			userProxy: "",
			wantProxy: "",
		},
		{
			name:      "blank bound proxy is treated as unset",
			e:         EgressInfo{ProxyURL: "   ", EgressRequired: false},
			userProxy: "http://user:8080",
			wantProxy: "http://user:8080",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			proxy, blocked := resolveEgress(tc.e, tc.userProxy)
			if blocked != tc.wantBlocked {
				t.Fatalf("blocked = %v, want %v", blocked, tc.wantBlocked)
			}
			if !tc.wantBlocked && proxy != tc.wantProxy {
				t.Fatalf("proxy = %q, want %q", proxy, tc.wantProxy)
			}
		})
	}
}

func TestDoUpstreamWithFallback(t *testing.T) {
	body := []byte(`{"prompt":"hi"}`)

	t.Run("bound proxy succeeds → no fallback, returns bound response", func(t *testing.T) {
		seen := map[string][]byte{}
		nc := clientFactory(map[string]bool{}, seen)
		resp, err := doUpstreamWithFallback(
			EgressInfo{ProxyURL: "socks5://bound:1080", EgressRequired: false},
			"http://user:8080", body, mustReq(t, body), nc)
		if err != nil {
			t.Fatalf("err = %v, want nil", err)
		}
		if got := bodyOf(t, resp); got != "ok-socks5://bound:1080" {
			t.Fatalf("body = %q, want bound proxy response", got)
		}
		if _, hitLocal := seen["http://user:8080"]; hitLocal {
			t.Fatalf("must NOT fall back to local when bound proxy succeeds")
		}
	})

	t.Run("optional: bound proxy fails at transport → degrade to local direct, replaying body", func(t *testing.T) {
		seen := map[string][]byte{}
		nc := clientFactory(map[string]bool{"socks5://bound:1080": true}, seen)
		resp, err := doUpstreamWithFallback(
			EgressInfo{ProxyURL: "socks5://bound:1080", EgressRequired: false},
			"http://user:8080", body, mustReq(t, body), nc)
		if err != nil {
			t.Fatalf("err = %v, want nil (should have degraded to local)", err)
		}
		if got := bodyOf(t, resp); got != "ok-http://user:8080" {
			t.Fatalf("body = %q, want local-direct response", got)
		}
		if got := string(seen["http://user:8080"]); got != string(body) {
			t.Fatalf("retry replayed body = %q, want %q", got, string(body))
		}
	})

	t.Run("optional: bound fails AND local fails → returns error (caller rotates)", func(t *testing.T) {
		seen := map[string][]byte{}
		nc := clientFactory(map[string]bool{"socks5://bound:1080": true, "http://user:8080": true}, seen)
		_, err := doUpstreamWithFallback(
			EgressInfo{ProxyURL: "socks5://bound:1080", EgressRequired: false},
			"http://user:8080", body, mustReq(t, body), nc)
		if err == nil {
			t.Fatalf("err = nil, want error after both proxy and local fail")
		}
	})

	t.Run("required: no bound proxy → errEgressRequired, client never built", func(t *testing.T) {
		seen := map[string][]byte{}
		nc := clientFactory(map[string]bool{}, seen)
		_, err := doUpstreamWithFallback(
			EgressInfo{ProxyURL: "", EgressRequired: true},
			"http://user:8080", body, mustReq(t, body), nc)
		if !errors.Is(err, errEgressRequired) {
			t.Fatalf("err = %v, want errEgressRequired", err)
		}
		if len(seen) != 0 {
			t.Fatalf("required+no-proxy must not dial anything, saw %v", seen)
		}
	})

	t.Run("required: bound proxy fails → NO degrade to local (anthropic never touches local IP)", func(t *testing.T) {
		seen := map[string][]byte{}
		nc := clientFactory(map[string]bool{"socks5://bound:1080": true}, seen)
		_, err := doUpstreamWithFallback(
			EgressInfo{ProxyURL: "socks5://bound:1080", EgressRequired: true},
			"http://user:8080", body, mustReq(t, body), nc)
		if err == nil {
			t.Fatalf("err = nil, want error (required must not fall back)")
		}
		if _, hitLocal := seen["http://user:8080"]; hitLocal {
			t.Fatalf("required policy must NEVER degrade to local direct")
		}
	})

	t.Run("optional: no bound proxy → uses user proxy directly (fail-open)", func(t *testing.T) {
		seen := map[string][]byte{}
		nc := clientFactory(map[string]bool{}, seen)
		resp, err := doUpstreamWithFallback(
			EgressInfo{ProxyURL: "", EgressRequired: false},
			"http://user:8080", body, mustReq(t, body), nc)
		if err != nil {
			t.Fatalf("err = %v, want nil", err)
		}
		if got := bodyOf(t, resp); got != "ok-http://user:8080" {
			t.Fatalf("body = %q, want user-proxy response", got)
		}
	})
}
