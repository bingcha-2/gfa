package wakeup

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"bcai-wails/internal/local/account"
)

// AccountResolver 按 id 解析出一个账号(hub 注入 = acc.Get)。未找到返回错误。
type AccountResolver func(id string) (*account.Account, error)

// VerifyResult 一次对单个账号的「保活验证」结果(跑一次真 keepAlive:刷 token + 轻探额度)。
// 对齐 cockpit WakeupVerificationStateItem 的核心字段(pass/fail + 时间 + 原因),
// 不做 cockpit 的 verification_required/tos_violation 细分(GFA keepAlive 只回 ok/err)。
type VerifyResult struct {
	AccountID  string `json:"accountId"`
	Email      string `json:"email"`
	Ok         bool   `json:"ok"`
	Reason     string `json:"reason,omitempty"` // 失败原因(ok=true 时空)
	AtMs       int64  `json:"atMs"`             // 验证时刻,unix ms
	DurationMs int64  `json:"durationMs"`       // 本次验证耗时
	NewExpiry  int64  `json:"newExpiry,omitempty"`
}

// VerifyBatch 一次批量验证的聚合 + 明细(历史一条 = 一批)。
type VerifyBatch struct {
	BatchID   string         `json:"batchId"`
	AtMs      int64          `json:"atMs"`
	Total     int            `json:"total"`
	PassCount int            `json:"passCount"`
	FailCount int            `json:"failCount"`
	Records   []VerifyResult `json:"records"`
}

// Verification 组件:对选中的一批自有号跑一次真 keepAlive 验证它们确实可用,
// 记录每号 pass/fail + 聚合 + 持久化历史(JSON,原子,capped)。
// keepAlive 复用 hub 给 wakeup 注入的那一个(真 token 续约 + 轻探额度)。
type Verification struct {
	keepAlive KeepAliveFunc
	resolve   AccountResolver
	store     *verifyStore
	seq       atomic.Int64 // 保证同一毫秒内多批的 BatchID 唯一
}

func NewVerification(dir, provider string, keepAlive KeepAliveFunc, resolve AccountResolver) *Verification {
	return &Verification{
		keepAlive: keepAlive,
		resolve:   resolve,
		store:     newVerifyStore(dir, provider),
	}
}

// dedupe 去重 + 去空白,保持首次出现顺序。
func dedupe(ids []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(ids))
	for _, raw := range ids {
		id := strings.TrimSpace(raw)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

// verifyOne 对一个 id 跑一次 keepAlive,产出 VerifyResult(解析失败也记为一条失败结果)。
func (v *Verification) verifyOne(ctx context.Context, id string) VerifyResult {
	started := time.Now()
	nowMs := started.UnixMilli()
	a, err := v.resolve(id)
	if err != nil {
		return VerifyResult{AccountID: id, Ok: false, Reason: err.Error(), AtMs: nowMs, DurationMs: 0}
	}
	var newExpiry int64
	if v.keepAlive != nil {
		newExpiry, err = v.keepAlive(ctx, a)
	}
	res := VerifyResult{
		AccountID:  a.ID,
		Email:      a.Email,
		Ok:         err == nil,
		AtMs:       nowMs,
		DurationMs: time.Since(started).Milliseconds(),
		NewExpiry:  newExpiry,
	}
	if err != nil {
		res.Reason = err.Error()
	}
	return res
}

// RunBatch 对选中的账号逐个跑一次真 keepAlive 验证,记录每号 pass/fail + 聚合,
// 把每号最新结果 upsert 进 state、把本批追加进 history(capped)。
func (v *Verification) RunBatch(ctx context.Context, ids []string) (VerifyBatch, error) {
	targets := dedupe(ids)
	if len(targets) == 0 {
		return VerifyBatch{}, errors.New("wakeup: 未选择任何账号")
	}
	records := make([]VerifyResult, 0, len(targets))
	pass, fail := 0, 0
	for _, id := range targets {
		r := v.verifyOne(ctx, id)
		if r.Ok {
			pass++
		} else {
			fail++
		}
		records = append(records, r)
	}
	atMs := time.Now().UnixMilli()
	// BatchID 加自增序号:同一毫秒内多次 RunBatch 也不会撞 id(否则 appendBatch 去重会互相覆盖)。
	seq := v.seq.Add(1)
	batch := VerifyBatch{
		BatchID:   "verify_" + strconv.FormatInt(atMs, 10) + "_" + strconv.FormatInt(seq, 10),
		AtMs:      atMs,
		Total:     len(records),
		PassCount: pass,
		FailCount: fail,
		Records:   records,
	}
	// 持久化:先 upsert 每号最新态,再追加本批历史(失败不阻断返回,best-effort)。
	_ = v.store.upsertItems(records)
	_ = v.store.appendBatch(batch)
	return batch, nil
}

// SingleTest 对单个账号即席跑一次 keepAlive 验证(临时单号测试),同样 upsert state。
func (v *Verification) SingleTest(ctx context.Context, id string) (VerifyResult, error) {
	if strings.TrimSpace(id) == "" {
		return VerifyResult{}, errors.New("wakeup: 账号 id 为空")
	}
	if _, err := v.resolve(id); err != nil {
		return VerifyResult{}, err
	}
	r := v.verifyOne(ctx, id)
	_ = v.store.upsertItems([]VerifyResult{r})
	return r, nil
}

// LoadState 返回每账号最新一次验证结果(从磁盘)。
func (v *Verification) LoadState() ([]VerifyResult, error) {
	return v.store.items(), nil
}

// LoadHistory 返回历史批次(新→旧)。
func (v *Verification) LoadHistory() ([]VerifyBatch, error) {
	return v.store.history(), nil
}

// DeleteHistory 删除指定 batchId 的历史批次,返回删除数量。空/空白 id 忽略。
func (v *Verification) DeleteHistory(batchIDs []string) (int, error) {
	ids := map[string]bool{}
	for _, raw := range batchIDs {
		if id := strings.TrimSpace(raw); id != "" {
			ids[id] = true
		}
	}
	if len(ids) == 0 {
		return 0, nil
	}
	return v.store.deleteBatches(ids)
}
