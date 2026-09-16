package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"time"

	"golang.org/x/net/proxy"
)

type codexContextDialer interface {
	proxy.Dialer
	proxy.ContextDialer
}

// The local proxy transports the connection to the account proxy. It never
// replaces the account proxy as the upstream exit.
func codexProxyOver(raw string, forward codexContextDialer) (codexContextDialer, error) {
	checked, err := normalizeCodexProxyURL(raw)
	if err != nil {
		return nil, err
	}
	u, _ := url.Parse(checked)
	if u.Scheme == "http" || u.Scheme == "https" {
		return &codexHTTPConnectDialer{proxyURL: u, forward: forward}, nil
	}
	var auth *proxy.Auth
	if u.User != nil {
		password, _ := u.User.Password()
		auth = &proxy.Auth{User: u.User.Username(), Password: password}
	}
	d, err := proxy.SOCKS5("tcp", u.Host, auth, forward)
	if err != nil {
		return nil, err
	}
	contextDialer, ok := d.(codexContextDialer)
	if !ok {
		return nil, errors.New("Codex proxy does not support context dialing")
	}
	return contextDialer, nil
}

func codexLocalHop(bound, userProxy string) (codexContextDialer, bool, error) {
	direct := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	local := resolveCodexEffectiveProxy(userProxy)
	if local == "" {
		return direct, false, nil
	}
	checked, err := normalizeCodexProxyURL(local)
	if err != nil {
		return nil, false, errors.New("Codex local/system proxy configuration is invalid")
	}
	account, err := normalizeCodexProxyURL(bound)
	if err != nil {
		return nil, false, err
	}
	a, _ := url.Parse(account)
	b, _ := url.Parse(checked)
	if a.Host == b.Host {
		return direct, false, nil
	}
	hop, err := codexProxyOver(checked, direct)
	return hop, true, err
}

func codexBoundProxyDialer(bound, userProxy string) (codexContextDialer, error) {
	hop, _, err := codexLocalHop(bound, userProxy)
	if err != nil {
		return nil, err
	}
	return codexProxyOver(bound, hop)
}

type codexProxyErrorTransport struct{ err error }

func (t codexProxyErrorTransport) RoundTrip(*http.Request) (*http.Response, error) { return nil, t.err }

func codexClientViaLocalProxy(client *http.Client, bound, userProxy string) *http.Client {
	copyClient := *client
	hop, chained, err := codexLocalHop(bound, userProxy)
	if err == nil && !chained {
		return client
	}
	if err == nil {
		copyClient.Transport, err = codexTransportViaLocalProxy(client.Transport, bound, hop)
	}
	if err != nil {
		copyClient.Transport = codexProxyErrorTransport{err}
	}
	return &copyClient
}

func codexTransportViaLocalProxy(rt http.RoundTripper, bound string, hop codexContextDialer) (http.RoundTripper, error) {
	switch t := rt.(type) {
	case *http.Transport:
		copyTransport := t.Clone()
		copyTransport.DialContext = hop.DialContext
		return copyTransport, nil
	case *codexFallbackRoundTripper:
		dialer, err := codexProxyOver(bound, hop)
		if err != nil {
			return nil, err
		}
		utls := newCodexUtlsRoundTripper(bound)
		utls.dialer = dialer
		fallback, err := codexTransportViaLocalProxy(t.fallback, bound, hop)
		if err != nil {
			return nil, err
		}
		return &codexFallbackRoundTripper{utls: utls, fallback: fallback}, nil
	default:
		return nil, errors.New("Codex transport cannot use the configured local proxy")
	}
}

func codexEgressReachable(target, bound string) error {
	// Resolve the local selection once, including an explicit direct selection
	// when there is no system proxy. Candidate protocols bypass the scheme cache.
	local := resolveCodexEffectiveProxy("")
	if local == "" {
		local = "direct"
	}
	return egressReachableWithProbe(target, bound, func(target, candidate string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		defer cancel()
		dialer, err := codexBoundProxyDialer(candidate, local)
		if err != nil {
			return err
		}
		conn, err := dialer.DialContext(ctx, "tcp", target)
		if err == nil {
			conn.Close()
		}
		return err
	})
}
