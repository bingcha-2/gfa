package wakeup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

const (
	// maxVerifyHistoryBatches 保活验证历史保留的批次上限(对齐 cockpit MAX_HISTORY_BATCHES)。
	maxVerifyHistoryBatches = 100
	verifyStateVersion      = 1
)

// verifyStateFile 是保活验证状态的落盘结构:
//   - items:每个账号最新一次验证结果(按账号 upsert)。
//   - history:最近若干「批次」(RunBatch 一次一条),capped。
type verifyStateFile struct {
	Version int            `json:"version"`
	Items   []VerifyResult `json:"items"`
	History []VerifyBatch  `json:"history"`
}

// verifyStore 原子持久化某 provider 的保活验证状态到一个小 JSON 文件。
// 与 ConfigStore 同风格(tmp+rename 原子写、损坏容忍为空)。
type verifyStore struct {
	path string
	mu   sync.Mutex
}

func newVerifyStore(dir, provider string) *verifyStore {
	return &verifyStore{path: filepath.Join(dir, "wakeup-verify-"+provider+".json")}
}

// load 读取全量状态;缺省/损坏则返回空(不报错,容忍)。调用方持锁。
func (s *verifyStore) loadLocked() verifyStateFile {
	f := verifyStateFile{Version: verifyStateVersion}
	data, err := os.ReadFile(s.path)
	if err != nil {
		return f
	}
	var parsed verifyStateFile
	if err := json.Unmarshal(data, &parsed); err != nil {
		return f // 损坏容忍为空
	}
	if parsed.Version == 0 {
		parsed.Version = verifyStateVersion
	}
	return parsed
}

func (s *verifyStore) saveLocked(f verifyStateFile) error {
	f.Version = verifyStateVersion
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// upsertItems 把本轮结果按账号覆盖进 items(每号只留最新),持久化。
func (s *verifyStore) upsertItems(items []VerifyResult) error {
	if len(items) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	f := s.loadLocked()
	byID := make(map[string]VerifyResult, len(f.Items)+len(items))
	order := make([]string, 0, len(f.Items)+len(items))
	seen := map[string]bool{}
	for _, it := range f.Items {
		if !seen[it.AccountID] {
			order = append(order, it.AccountID)
			seen[it.AccountID] = true
		}
		byID[it.AccountID] = it
	}
	for _, it := range items {
		if !seen[it.AccountID] {
			order = append(order, it.AccountID)
			seen[it.AccountID] = true
		}
		byID[it.AccountID] = it
	}
	merged := make([]VerifyResult, 0, len(order))
	for _, id := range order {
		merged = append(merged, byID[id])
	}
	f.Items = merged
	return s.saveLocked(f)
}

// appendBatch 追加一条历史批次:新批放最前(新→旧),同 BatchID 去重,超上限截尾(丢最旧)。
// 磁盘上已按新→旧存放,故最新批直接前插即可,capped 时截掉尾部(最旧)。
func (s *verifyStore) appendBatch(b VerifyBatch) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	f := s.loadLocked()
	out := make([]VerifyBatch, 0, len(f.History)+1)
	out = append(out, b) // 新批置顶
	for _, h := range f.History {
		if h.BatchID != b.BatchID {
			out = append(out, h)
		}
	}
	if len(out) > maxVerifyHistoryBatches {
		out = out[:maxVerifyHistoryBatches] // 截尾 = 丢最旧
	}
	f.History = out
	return s.saveLocked(f)
}

// items 返回每账号最新结果(顺序即插入顺序)。
func (s *verifyStore) items() []VerifyResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	f := s.loadLocked()
	out := make([]VerifyResult, len(f.Items))
	copy(out, f.Items)
	return out
}

// history 返回历史批次(新→旧)。
func (s *verifyStore) history() []VerifyBatch {
	s.mu.Lock()
	defer s.mu.Unlock()
	f := s.loadLocked()
	out := make([]VerifyBatch, len(f.History))
	copy(out, f.History)
	sortBatchesNewestFirst(out)
	return out
}

// deleteBatches 删除指定 BatchID 的历史批次,返回删除数量。
func (s *verifyStore) deleteBatches(ids map[string]bool) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f := s.loadLocked()
	kept := make([]VerifyBatch, 0, len(f.History))
	deleted := 0
	for _, h := range f.History {
		if ids[h.BatchID] {
			deleted++
			continue
		}
		kept = append(kept, h)
	}
	if deleted == 0 {
		return 0, nil
	}
	f.History = kept
	if err := s.saveLocked(f); err != nil {
		return 0, err
	}
	return deleted, nil
}

// sortBatchesNewestFirst 稳定地把批次按 AtMs 降序(新→旧)排列。
func sortBatchesNewestFirst(b []VerifyBatch) {
	// 简单插入排序(批次不多,≤100),保持稳定。
	for i := 1; i < len(b); i++ {
		j := i
		for j > 0 && b[j-1].AtMs < b[j].AtMs {
			b[j-1], b[j] = b[j], b[j-1]
			j--
		}
	}
}
