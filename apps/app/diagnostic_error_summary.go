package main

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

const diagnosticSummaryMaxGroups = 30

var diagnosticDynamicNumber = regexp.MustCompile(`(?:#[0-9]+|\b[0-9]{2,}\b)`)

type diagnosticEventGroup struct {
	Severity string
	Message  string
	Count    int
	FirstAt  string
	LastAt   string
}

func diagnosticLineSeverity(line string) string {
	lower := strings.ToLower(line)
	for _, marker := range []string{"[error", " error", "failed", "failure", "panic", "permission denied", "access denied", "operation not permitted", "失败", "错误"} {
		if strings.Contains(lower, marker) {
			return "ERROR"
		}
	}
	for _, marker := range []string{"[warn", "warning", "retrying", " retry", "timed out", "timeout", "warning", "timeout", "retry"} {
		if strings.Contains(lower, marker) {
			return "WARN"
		}
	}
	return ""
}

func diagnosticEventParts(line string) (timestamp, message string) {
	line = strings.TrimSpace(redactDiagnosticText(line))
	stamp, rest, ok := strings.Cut(line, " ")
	if ok {
		if _, err := time.Parse(time.RFC3339Nano, stamp); err == nil {
			return stamp, strings.TrimSpace(rest)
		}
	}
	return "", line
}

func diagnosticSummaryMessage(message string) string {
	message = strings.Join(strings.Fields(message), " ")
	runes := []rune(message)
	if len(runes) > 500 {
		message = string(runes[:500]) + "..."
	}
	return message
}

func buildDiagnosticErrorSummary(logData []byte) []byte {
	groups := make(map[string]*diagnosticEventGroup)
	for _, line := range strings.Split(string(logData), "\n") {
		severity := diagnosticLineSeverity(line)
		if severity == "" {
			continue
		}
		stamp, message := diagnosticEventParts(line)
		message = diagnosticSummaryMessage(message)
		key := severity + "\x00" + strings.ToLower(diagnosticDynamicNumber.ReplaceAllString(message, "#"))
		group := groups[key]
		if group == nil {
			group = &diagnosticEventGroup{Severity: severity, Message: message, FirstAt: stamp}
			groups[key] = group
		}
		group.Count++
		if group.FirstAt == "" && stamp != "" {
			group.FirstAt = stamp
		}
		if stamp != "" {
			group.LastAt = stamp
		}
	}

	ordered := make([]*diagnosticEventGroup, 0, len(groups))
	for _, group := range groups {
		ordered = append(ordered, group)
	}
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].Severity != ordered[j].Severity {
			return ordered[i].Severity == "ERROR"
		}
		if ordered[i].Count != ordered[j].Count {
			return ordered[i].Count > ordered[j].Count
		}
		return ordered[i].Message < ordered[j].Message
	})
	if len(ordered) > diagnosticSummaryMaxGroups {
		ordered = ordered[:diagnosticSummaryMaxGroups]
	}

	var out strings.Builder
	out.WriteString("BingchaAI error summary\n")
	out.WriteString("Source: included desktop.log only; no additional scans or probes.\n\n")
	if len(ordered) == 0 {
		out.WriteString("No errors or warnings were found in the included log.\n")
		return []byte(out.String())
	}
	for _, group := range ordered {
		first, last := group.FirstAt, group.LastAt
		if first == "" {
			first = "unknown"
		}
		if last == "" {
			last = "unknown"
		}
		_, _ = fmt.Fprintf(&out, "[%s] count=%d first=%s last=%s\n%s\n\n", group.Severity, group.Count, first, last, group.Message)
	}
	return []byte(redactDiagnosticText(out.String()))
}
