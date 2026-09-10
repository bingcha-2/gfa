package main

import (
	"encoding/csv"
	"io"
	"strconv"
	"strings"
)

// Inspect process records instead of localized "no matching tasks" messages.
func tasklistContainsImage(output, imageName string) bool {
	r := csv.NewReader(strings.NewReader(strings.TrimPrefix(output, "\ufeff")))
	r.FieldsPerRecord = -1
	for {
		record, err := r.Read()
		if err == io.EOF {
			return false
		}
		if err != nil {
			continue
		}
		if len(record) < 2 || !strings.EqualFold(strings.TrimSpace(record[0]), imageName) {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSpace(record[1]))
		if err == nil && pid > 0 {
			return true
		}
	}
}
