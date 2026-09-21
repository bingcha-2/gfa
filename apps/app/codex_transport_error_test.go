package main

import (
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

type codexDiagnosticTestDialer struct {
	conn net.Conn
	err  error
}

func (d codexDiagnosticTestDialer) Dial(string, string) (net.Conn, error) {
	return d.conn, d.err
}

func TestCodexResponsesTransportErrorStages(t *testing.T) {
	t.Run("tunnel", func(t *testing.T) {
		rt := newCodexUtlsRoundTripper("direct")
		rt.dialer = codexDiagnosticTestDialer{err: io.ErrUnexpectedEOF}
		_, err := rt.createConnection(context.Background(), "chatgpt.com", "chatgpt.com:443")
		if !errors.Is(err, io.ErrUnexpectedEOF) || !strings.Contains(err.Error(), "proxy tunnel") {
			t.Fatalf("missing tunnel stage or original error: %v", err)
		}
	})
	t.Run("tls", func(t *testing.T) {
		client, server := net.Pipe()
		defer client.Close()
		go func() {
			defer server.Close()
			// Consume ClientHello, then close without returning ServerHello.
			buffer := make([]byte, 16384)
			_, _ = server.Read(buffer)
		}()
		rt := newCodexUtlsRoundTripper("direct")
		rt.dialer = codexDiagnosticTestDialer{conn: client}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_, err := rt.createConnection(ctx, "chatgpt.com", "chatgpt.com:443")
		if err == nil || !strings.Contains(err.Error(), "upstream TLS handshake") {
			t.Fatalf("missing TLS stage: %v", err)
		}
	})
}
