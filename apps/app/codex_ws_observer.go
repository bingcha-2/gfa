package main

import (
	"sync"
	"time"

	"github.com/tidwall/gjson"
)

type codexWSTurn struct {
	sequence                     uint64
	diagnostic                   codexStreamDiagnostic
	started                      time.Time
	input, output, cached, total int64
}

// One report per response, not the largest usage value on the whole socket.
// Both pumps call this observer; callbacks run without holding its mutex.
type codexWSObserver struct {
	mu           sync.Mutex
	turns        []*codexWSTurn
	defaultModel string
	sequence     uint64
	report       func(ReportDetails)
	completed    map[string]bool
}

func codexFrameModel(data []byte) string {
	if model := gjson.GetBytes(data, "model").String(); model != "" {
		return model
	}
	return gjson.GetBytes(data, "response.model").String()
}

func (o *codexWSObserver) request(data []byte) {
	if gjson.GetBytes(data, "type").String() != "response.create" {
		return
	}
	o.mu.Lock()
	model := codexFrameModel(data)
	if model == "" {
		model = o.defaultModel
	} else {
		o.defaultModel = model
	}
	o.sequence++
	turn := &codexWSTurn{sequence: o.sequence, started: time.Now(), diagnostic: codexStreamDiagnostic{RequestedModel: model, SentModel: model, ReasoningEffort: codexReasoningEffort(data)}}
	// Bound memory even if a broken client sends endless requests without replies.
	var evicted *codexWSTurn
	if len(o.turns) >= 64 {
		evicted = o.turns[0]
		o.turns = o.turns[1:]
	}
	o.turns = append(o.turns, turn)
	o.mu.Unlock()
	if evicted != nil {
		o.finish(evicted)
	}
}

func (o *codexWSObserver) response(data []byte) {
	o.mu.Lock()
	if len(data) > codexObservedEventLimit {
		for _, turn := range o.turns {
			turn.diagnostic.ObservationLimited = true
		}
		o.mu.Unlock()
		return
	}
	id := gjson.GetBytes(data, "response.id").String()
	if id == "" {
		id = gjson.GetBytes(data, "response_id").String()
	}
	if id != "" && o.completed[id] {
		o.mu.Unlock()
		return
	}
	index := -1
	for i, turn := range o.turns {
		if id != "" && turn.diagnostic.ResponseID == id {
			index = i
			break
		}
	}
	if index < 0 {
		if gjson.GetBytes(data, "type").String() == "response.created" {
			for i, turn := range o.turns {
				if turn.diagnostic.ResponseID == "" {
					index = i
					break
				}
			}
		} else if len(o.turns) == 1 && (id == "" || o.turns[0].diagnostic.ResponseID == "" || o.turns[0].diagnostic.ResponseID == id) {
			index = 0
		}
	}
	if index < 0 {
		o.mu.Unlock()
		return
	}
	turn := o.turns[index]
	if id != "" {
		turn.diagnostic.ResponseID = id
	}
	turn.diagnostic.observe(data)
	if in, out, cached, total, ok := parseCodexWSUsage(data); ok {
		turn.input, turn.output, turn.cached, turn.total = in, out, cached, total
	}
	terminal := turn.diagnostic.Result != ""
	if terminal {
		o.turns = append(o.turns[:index], o.turns[index+1:]...)
		if id != "" {
			if o.completed == nil {
				o.completed = make(map[string]bool)
			}
			if len(o.completed) >= 256 {
				for old := range o.completed {
					delete(o.completed, old)
					break
				}
			}
			o.completed[id] = true
		}
	}
	o.mu.Unlock()
	if terminal {
		o.finish(turn)
	}
}

func (o *codexWSObserver) finish(turn *codexWSTurn) {
	model := turn.diagnostic.UpstreamModel
	if model == "" {
		model = turn.diagnostic.SentModel
	}
	details := codexDetailsFrom(200, model, turn.input, turn.output, turn.cached, turn.total)
	details.RequestStartedAt = turn.started.UnixMilli()
	details.UpstreamCompletedAt = time.Now().UnixMilli()
	details.CodexDiagnostic = turn.diagnostic.metadata(200, nil)
	details.CodexDiagnostic.RequestSequence = turn.sequence
	details.Reason = turn.diagnostic.reportReason(nil, turn.total)
	if o.report != nil {
		o.report(details)
	}
}

func (o *codexWSObserver) close() {
	o.mu.Lock()
	turns := o.turns
	o.turns = nil
	o.mu.Unlock()
	for _, turn := range turns {
		o.finish(turn)
	}
}
