package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var (
	logLock  sync.Mutex
	logLines []string
	logFile  *os.File
)

const maxLogLines = 100

func initLogger() {
	logLock.Lock()
	defer logLock.Unlock()

	dir := getAppDataDir()
	_ = os.MkdirAll(filepath.Join(dir, "logs"), 0700)

	logPath := filepath.Join(dir, "logs", "desktop.log")
	var err error
	logFile, err = os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		fmt.Printf("Failed to open log file: %v\n", err)
	}

	logLines = make([]string, 0, maxLogLines)
}

func Log(format string, v ...interface{}) {
	logLock.Lock()
	defer logLock.Unlock()

	msg := fmt.Sprintf(format, v...)
	timestamp := time.Now().Format("2006-01-02T15:04:05.000Z07:00")
	line := fmt.Sprintf("%s %s", timestamp, msg)

	// Print to stdout
	fmt.Println(line)

	// Write to file
	if logFile != nil {
		_, _ = logFile.WriteString(line + "\n")
	}

	// Keep last 100 lines in memory
	if len(logLines) >= maxLogLines {
		logLines = logLines[1:]
	}
	logLines = append(logLines, line)
}

func GetInMemoryLogs() []string {
	logLock.Lock()
	defer logLock.Unlock()

	res := make([]string, len(logLines))
	copy(res, logLines)
	return res
}

func ClearInMemoryLogs() {
	logLock.Lock()
	defer logLock.Unlock()

	logLines = make([]string, 0, maxLogLines)
	if logFile != nil {
		_ = logFile.Truncate(0)
		_, _ = logFile.Seek(0, 0)
	}
}
