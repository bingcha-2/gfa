package main

import (
	"errors"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Fingerprint-enabled accounts must use their assigned exit, even when an older
// server omitted egressRequired. Do not mutate the shared lease snapshot.
func codexRequiresBoundEgress(lease *CodexTokenLease) bool {
	if lease == nil || lease.IsRelay() {
		return false
	}
	if lease.EgressRequired {
		return true
	}
	if lease.Fingerprint == nil {
		return false
	}
	switch lease.Fingerprint.Mode {
	case "device", "session", "full":
		return true
	default:
		return false
	}
}

func resolveCodexLeaseProxy(lease *CodexTokenLease, userProxy string) (string, error) {
	if lease == nil {
		return "", errEgressRequired
	}
	if !codexRequiresBoundEgress(lease) {
		proxy, blocked := resolveEgress(lease.EgressInfo, userProxy)
		if blocked {
			return "", errEgressRequired
		}
		return proxy, nil
	}
	raw := strings.TrimSpace(lease.ProxyURL)
	if raw == "" {
		return "", errEgressRequired
	}
	// Reuse the protocol verified by takeover preflight. This only changes the
	// scheme of the same bound endpoint; it never selects a local/direct exit.
	raw = resolveEgressProxyURL(raw)
	return normalizeCodexProxyURL(raw)
}

func normalizeCodexProxyURL(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	invalid := errors.New("Codex bound proxy is invalid or unsupported; refusing direct connection")
	if err != nil || parsed.Hostname() == "" || parsed.Opaque != "" || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return "", invalid
	}
	defaults := map[string]string{"http": "80", "https": "443", "socks5": "1080", "socks5h": "1080"}
	port, supported := defaults[parsed.Scheme]
	if !supported {
		return "", invalid
	}
	if parsed.Port() != "" {
		n, err := strconv.Atoi(parsed.Port())
		if err != nil || n < 1 || n > 65535 {
			return "", invalid
		}
		port = parsed.Port()
	}
	parsed.Host = net.JoinHostPort(parsed.Hostname(), port)
	return parsed.String(), nil
}

type codexEgressTrace struct {
	Fingerprint string
	Changed     bool
}

// Keep a stateful conversation on its bound exit after transport errors.
func codexSessionLease(lease *CodexTokenLease, sessionHash string) *CodexTokenLease {
	if lease == nil || lease.IsRelay() || sessionHash == "" || strings.TrimSpace(lease.ProxyURL) == "" {
		return lease
	}
	copy := *lease
	copy.EgressRequired = true
	return &copy
}

func doCodexUpstream(lease *CodexTokenLease, userProxy string, body []byte, req *http.Request, newClient func(string) *http.Client, traces ...*codexEgressTrace) (*http.Response, error) {
	if len(traces) > 0 && traces[0] != nil {
		factory := newClient
		trace := traces[0]
		newClient = func(endpoint string) *http.Client {
			fingerprint := codexOpaqueHash("route:" + endpoint)
			if trace.Fingerprint != "" && trace.Fingerprint != fingerprint {
				trace.Changed = true
			}
			trace.Fingerprint = fingerprint
			return factory(endpoint)
		}
	}
	if lease != nil && strings.TrimSpace(lease.ProxyURL) != "" {
		factory := newClient
		bound := resolveEgressProxyURL(strings.TrimSpace(lease.ProxyURL))
		newClient = func(endpoint string) *http.Client {
			client := factory(endpoint)
			if endpoint == userProxy && !codexRequiresBoundEgress(lease) {
				return client
			}
			return codexClientViaLocalProxy(client, bound, userProxy)
		}
	}
	if codexRequiresBoundEgress(lease) {
		proxy, err := resolveCodexLeaseProxy(lease, userProxy)
		if err != nil {
			return nil, err
		}
		return newClient(proxy).Do(req)
	}
	if lease == nil {
		return nil, errEgressRequired
	}
	return doUpstreamWithFallback(lease.EgressInfo, userProxy, body, req, newClient)
}
