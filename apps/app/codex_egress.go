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

func doCodexUpstream(lease *CodexTokenLease, userProxy string, body []byte, req *http.Request, newClient func(string) *http.Client) (*http.Response, error) {
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
