package manager

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"bcai-wails/internal/local/account"
	"bcai-wails/internal/local/quota"
)

// concurrencyProbeRefresher 记录 FetchQuota 的并发峰值(自身并发安全)。
type concurrencyProbeRefresher struct {
	mu   sync.Mutex
	cur  int
	peak int
	res  quota.Result
}

func (f *concurrencyProbeRefresher) TokenExpired(*account.Account) bool  { return false }
func (f *concurrencyProbeRefresher) RefreshToken(*account.Account) error { return nil }
func (f *concurrencyProbeRefresher) FetchQuota(*account.Account) (quota.Result, error) {
	f.mu.Lock()
	f.cur++
	if f.cur > f.peak {
		f.peak = f.cur
	}
	f.mu.Unlock()

	time.Sleep(15 * time.Millisecond) // 模拟拉额度的网络耗时

	f.mu.Lock()
	f.cur--
	f.mu.Unlock()
	return f.res, nil
}

func (f *concurrencyProbeRefresher) peakConcurrency() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.peak
}

// 批量刷额度必须是【有界并发】:既不能退化成串行(号多要等到天荒地老),
// 也不能无限扇出(把上游打限流)。对齐 cockpit ab84211f 的取舍。
func TestRefreshAllQuotas_BoundedConcurrency(t *testing.T) {
	r := &concurrencyProbeRefresher{res: quota.Result{HourlyPercent: 50, WeeklyPercent: 50, HourlyKnown: true, WeeklyKnown: true}}
	m, acc := newMgrWithRefresher(t, r)

	const n = 12
	for i := 0; i < n; i++ {
		if err := acc.Add(&account.Account{
			Provider: account.ProviderCodex, Email: fmt.Sprintf("a%d@x", i),
			AuthKind: account.AuthOAuth, PoolEnabled: true,
		}); err != nil {
			t.Fatal(err)
		}
	}

	got, err := m.RefreshAllQuotas()
	if err != nil {
		t.Fatalf("RefreshAllQuotas: %v", err)
	}
	if got != n {
		t.Fatalf("刷新成功数 = %d, want %d(并发下不能丢号)", got, n)
	}

	peak := r.peakConcurrency()
	if peak > quotaRefreshMaxConcurrent {
		t.Fatalf("并发峰值 %d 超过上限 %d(无限扇出会打限流)", peak, quotaRefreshMaxConcurrent)
	}
	if peak < 2 {
		t.Fatalf("并发峰值只有 %d —— 退化成串行了(号多会很慢)", peak)
	}
}

// 同一账号绝不并发刷:refreshOne 过期时会续 token,而 refresh_token 轮换,
// 并发续同一个号会互相作废。每号一把锁保证串行(峰值必须为 1)。
func TestRefreshQuota_PerAccountLockSerializes(t *testing.T) {
	r := &concurrencyProbeRefresher{res: quota.Result{HourlyPercent: 50, WeeklyPercent: 50, HourlyKnown: true, WeeklyKnown: true}}
	m, acc := newMgrWithRefresher(t, r)
	a := &account.Account{Provider: account.ProviderCodex, Email: "same@x", AuthKind: account.AuthOAuth, PoolEnabled: true}
	if err := acc.Add(a); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = m.RefreshQuota(a.ID)
		}()
	}
	wg.Wait()

	if peak := r.peakConcurrency(); peak != 1 {
		t.Fatalf("同一账号并发刷的峰值 = %d, want 1(每号锁失效,token 轮换会互相作废)", peak)
	}
}
