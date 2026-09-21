package main

import (
	"context"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Discover protocol before TLS/application bytes; keep endpoint, credentials and local hop.
type codexProtocolState struct {
	gate   chan struct{}
	scheme string
}

var codexProtocolStates = struct {
	sync.Mutex
	entries map[string]*codexProtocolState
}{entries: make(map[string]*codexProtocolState)}

type codexProtocolDialer struct {
	bound string
	hop   codexContextDialer
	state *codexProtocolState
}

func newCodexProtocolDialer(bound, route string, hop codexContextDialer) (codexContextDialer, error) {
	checked, err := normalizeCodexProxyURL(bound)
	if err != nil {
		return nil, err
	}
	u, _ := url.Parse(checked)
	// Never downgrade an explicitly TLS-protected proxy connection.
	if u.Scheme != "http" {
		return codexProxyOver(checked, hop)
	}
	key := codexOpaqueHash(checked + "\x00" + route)
	codexProtocolStates.Lock()
	state := codexProtocolStates.entries[key]
	if state == nil {
		if len(codexProtocolStates.entries) >= 1024 {
			codexProtocolStates.entries = make(map[string]*codexProtocolState)
		}
		state = &codexProtocolState{gate: make(chan struct{}, 1)}
		codexProtocolStates.entries[key] = state
	}
	codexProtocolStates.Unlock()
	return &codexProtocolDialer{bound: checked, hop: hop, state: state}, nil
}
func (d *codexProtocolDialer) Dial(network, addr string) (net.Conn, error) {
	return d.DialContext(context.Background(), network, addr)
}
func (d *codexProtocolDialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	select {
	case d.state.gate <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-d.state.gate }()
	u, _ := url.Parse(d.bound)
	schemes := []string{"http", "socks5"}
	if d.state.scheme != "" {
		schemes = []string{d.state.scheme}
	}
	var lastErr error
	for _, scheme := range schemes {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		u.Scheme = scheme
		dialer, err := codexProxyOver(u.String(), d.hop)
		if err != nil {
			return nil, err
		}
		attempt, cancel := context.WithTimeout(ctx, 5*time.Second)
		conn, err := dialer.DialContext(attempt, network, addr)
		cancel()
		if err == nil {
			d.state.scheme = scheme
			return conn, nil
		}
		lastErr = err
		// Access/authentication denials must not trigger a protocol retry.
		if strings.Contains(err.Error(), "failed: 403") || strings.Contains(err.Error(), "failed: 407") {
			break
		}
	}
	d.state.scheme = ""
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return nil, lastErr
}
