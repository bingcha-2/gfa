package main

import (
	"sync"
	"sync/atomic"
	"time"
)

var (
	guardOnce    sync.Once
	guardTripped atomic.Bool
)

// GuardOK 供 leaser/proxy 等核心路径检查；触发后静默拒绝服务
func GuardOK() bool { return !guardTripped.Load() }

func initGuard() {
	guardOnce.Do(func() {
		go guardLoop()
	})
}

func guardLoop() {
	if detectDebugger() {
		trip()
	}
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		if detectDebugger() {
			trip()
		}
	}
}

func trip() {
	if guardTripped.CompareAndSwap(false, true) {
		Log("[guard] protection triggered")
	}
}
