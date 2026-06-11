package main

import (
	"bytes"
	"testing"
)

const sampleClaudeSSE = "event: message_start\n" +
	`data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1000,"output_tokens":2,"cache_creation_input_tokens":50,"cache_read_input_tokens":200}}}` + "\n\n" +
	"event: content_block_delta\n" +
	`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}` + "\n\n" +
	"event: message_delta\n" +
	`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":350}}` + "\n\n" +
	"event: message_stop\n" +
	`data: {"type":"message_stop"}` + "\n\n"

func TestClaudeSSEParserExtractsUsage(t *testing.T) {
	var p claudeSSEParser
	p.Write([]byte(sampleClaudeSSE))
	u := p.Usage()

	if u.InputTokens != 1000 {
		t.Errorf("input = %d, want 1000", u.InputTokens)
	}
	if u.OutputTokens != 350 { // message_delta carries the cumulative final, not a delta to add
		t.Errorf("output = %d, want 350", u.OutputTokens)
	}
	if u.CacheCreationInputTokens != 50 {
		t.Errorf("cacheCreation = %d, want 50", u.CacheCreationInputTokens)
	}
	if u.CacheReadInputTokens != 200 {
		t.Errorf("cacheRead = %d, want 200", u.CacheReadInputTokens)
	}
	if got := u.rawTotal(); got != 1600 { // 1000 + 350 + 50 + 200
		t.Errorf("rawTotal = %d, want 1600", got)
	}
}

func TestClaudeSSEParserHandlesEventsSplitAcrossWrites(t *testing.T) {
	// Feed the stream one byte at a time — events must still be parsed across the
	// chunk boundaries (proxy reads arbitrary-sized chunks off the socket).
	var p claudeSSEParser
	for i := 0; i < len(sampleClaudeSSE); i++ {
		p.Write([]byte{sampleClaudeSSE[i]})
	}
	u := p.Usage()
	if u.InputTokens != 1000 || u.OutputTokens != 350 {
		t.Fatalf("split-write usage wrong: in=%d out=%d", u.InputTokens, u.OutputTokens)
	}
}

func TestCopyStreamingClaudeResponseTeesAndMeters(t *testing.T) {
	// chunkedReader returns the stream in small, event-splitting reads.
	src := &chunkedReader{data: []byte(sampleClaudeSSE), chunk: 7}
	var sink bytes.Buffer

	usage, err := copyStreamingClaudeResponse(&sink, src)
	if err != nil {
		t.Fatalf("copy error: %v", err)
	}
	// Downstream must receive the byte-for-byte original stream.
	if sink.String() != sampleClaudeSSE {
		t.Fatalf("downstream bytes differ from source")
	}
	if usage.InputTokens != 1000 || usage.OutputTokens != 350 {
		t.Fatalf("metered usage wrong: in=%d out=%d", usage.InputTokens, usage.OutputTokens)
	}
}

func TestClaudeSSEParserIgnoresMalformed(t *testing.T) {
	var p claudeSSEParser
	p.Write([]byte("event: message_start\ndata: not-json\n\nevent: ping\ndata: {}\n\n"))
	u := p.Usage()
	if u.InputTokens != 0 || u.OutputTokens != 0 {
		t.Fatalf("malformed stream should yield zero usage, got in=%d out=%d", u.InputTokens, u.OutputTokens)
	}
}
