package main

import (
	"context"
	"testing"
	"time"
)

func TestAppVersionMatchesRelease1355(t *testing.T) {
	if AppVersion != "13.5.5" {
		t.Fatalf("AppVersion = %q, want 13.5.5", AppVersion)
	}
}

func TestCreateUpdaterDownloadClientHasNoGlobalTimeout(t *testing.T) {
	client := createUpdaterDownloadClient(false)
	if client == nil {
		t.Fatal("createUpdaterDownloadClient returned nil")
	}
	if client.Timeout != 0 {
		t.Fatalf("download client Timeout = %s, want no global timeout", client.Timeout)
	}
	if client.Transport == nil {
		t.Fatal("download client should have a transport")
	}
}

func TestUpdaterDownloadContextUsesIdleTimeout(t *testing.T) {
	ctx, stop, markProgress := newUpdaterDownloadContext(context.Background(), 100*time.Millisecond)
	defer stop()

	time.Sleep(60 * time.Millisecond)
	markProgress()
	time.Sleep(60 * time.Millisecond)
	if err := ctx.Err(); err != nil {
		t.Fatalf("context canceled while progress was still being reported: %v", err)
	}

	time.Sleep(130 * time.Millisecond)
	if err := ctx.Err(); err == nil {
		t.Fatal("context was not canceled after download went idle")
	}
}
