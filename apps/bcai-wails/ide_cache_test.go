package main

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestDetectCacheTTL 验证缓存 TTL 机制：
// 在 TTL 内多次调用应返回缓存结果，过期后应重新计算
func TestDetectCacheTTL(t *testing.T) {
	// 保存原始 TTL，测试后恢复
	origTTL := ideStatusCacheTTL
	defer func() { ideStatusCacheTTL = origTTL }()

	// 设置极短 TTL 以便测试
	ideStatusCacheTTL = 100 * time.Millisecond

	// 清空缓存
	InvalidateIDEDetectCache()

	// 首次调用（会执行实际检测）
	result1 := DetectIDEProducts(60670)

	// 立即再次调用（应命中缓存，返回相同结果）
	result2 := DetectIDEProducts(60670)

	if len(result1.Products) != len(result2.Products) {
		t.Errorf("缓存内结果不一致: %d vs %d products", len(result1.Products), len(result2.Products))
	}

	// 等待缓存过期
	time.Sleep(150 * time.Millisecond)

	// 过期后调用（应重新计算）
	result3 := DetectIDEProducts(60670)
	if len(result3.Products) != 2 {
		t.Errorf("期望 2 个产品，实际 %d", len(result3.Products))
	}
}

// TestInvalidateCache 验证主动失效后缓存被清空
func TestInvalidateCache(t *testing.T) {
	// 先填充缓存
	_ = DetectIDEProducts(60670)

	// 验证缓存存在
	detectCacheMu.RLock()
	hasCacheBefore := cachedIDEStatus != nil
	detectCacheMu.RUnlock()
	if !hasCacheBefore {
		t.Error("调用后应有缓存")
	}

	// 清除缓存
	InvalidateIDEDetectCache()

	// 验证缓存已清空
	detectCacheMu.RLock()
	hasCacheAfter := cachedIDEStatus != nil
	detectCacheMu.RUnlock()
	if hasCacheAfter {
		t.Error("InvalidateIDEDetectCache 后缓存应为 nil")
	}
}

// TestCacheConcurrency 验证并发调用不会 panic 或 data race
func TestCacheConcurrency(t *testing.T) {
	InvalidateIDEDetectCache()

	var wg sync.WaitGroup
	var callCount atomic.Int64

	// 启动 20 个并发 goroutine
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = DetectIDEProducts(60670)
			callCount.Add(1)
		}()
	}

	// 同时有失效操作
	wg.Add(1)
	go func() {
		defer wg.Done()
		time.Sleep(5 * time.Millisecond)
		InvalidateIDEDetectCache()
	}()

	wg.Wait()

	if callCount.Load() != 20 {
		t.Errorf("期望 20 次调用完成，实际 %d", callCount.Load())
	}
}

// TestAsarCacheKeyChange 验证 asar 缓存在文件变化时自动失效
func TestAsarCacheKeyChange(t *testing.T) {
	// 模拟不同的 cache key
	detectCacheMu.Lock()
	cachedAsarKey = "1234|5678|http://127.0.0.1:60670"
	cachedAsarResult = true
	cachedAsarAt = time.Now()
	detectCacheMu.Unlock()

	// 使用不同的 proxyURL → key 不同 → 不命中缓存
	result := checkAsarPatchedCached("/nonexistent/path", "http://127.0.0.1:99999")
	if result {
		t.Error("不存在的路径不应返回 true")
	}
}

// TestLSProcsCacheTTL 验证 LS 进程查询缓存
func TestLSProcsCacheTTL(t *testing.T) {
	origTTL := lsProcsCacheTTL
	defer func() { lsProcsCacheTTL = origTTL }()

	lsProcsCacheTTL = 50 * time.Millisecond
	InvalidateIDEDetectCache()

	// 首次调用
	r1 := queryLanguageServerProcessesCached()

	// 立即调用应命中缓存
	r2 := queryLanguageServerProcessesCached()

	// 两次结果长度应一致（缓存返回相同值）
	if len(r1) != len(r2) {
		t.Errorf("缓存内 LS 结果不一致: %d vs %d", len(r1), len(r2))
	}

	// 等过期
	time.Sleep(60 * time.Millisecond)

	// 再次调用应重新执行
	_ = queryLanguageServerProcessesCached()
}
