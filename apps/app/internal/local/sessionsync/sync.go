package sessionsync

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	configFileName   = "config.toml"
	defaultProviderID = "openai"
)

// SyncToInstance 把一组会话恢复/复制到目标实例:从其他实例找到源 rollout,按目标实例
// 的 config provider 校正 session_meta 后落到目标(保持相对路径),并补齐 session_index。
// 目标已存在同会话则跳过(不覆盖)。缺失的会话计入 MissingSessionCount。
func SyncToInstance(instances []Instance, sessionIDs []string, targetInstanceID string) (SyncToInstanceSummary, error) {
	requested := dedupeTrimmed(sessionIDs)
	if len(requested) == 0 {
		return SyncToInstanceSummary{}, errors.New("sessionsync: 请至少选择一条会话")
	}
	target := strings.TrimSpace(targetInstanceID)
	if target == "" {
		return SyncToInstanceSummary{}, errors.New("sessionsync: 请选择目标实例")
	}

	var targetInst *Instance
	for i := range instances {
		if instances[i].ID == target {
			targetInst = &instances[i]
			break
		}
	}
	if targetInst == nil {
		return SyncToInstanceSummary{}, fmt.Errorf("sessionsync: 目标实例不存在: %s", target)
	}

	// 目标实例已有会话集合 + 源实例中匹配的会话快照(首见即取)。
	targetSnaps, err := loadThreadSnapshots(targetInst.DataDir)
	if err != nil {
		return SyncToInstanceSummary{}, err
	}
	targetExisting := map[string]bool{}
	for _, s := range targetSnaps {
		targetExisting[s.id] = true
	}
	sourceByID := map[string]threadSnapshot{}
	for _, inst := range instances {
		if inst.ID == targetInst.ID {
			continue
		}
		snaps, err := loadThreadSnapshots(inst.DataDir)
		if err != nil {
			return SyncToInstanceSummary{}, err
		}
		for _, s := range snaps {
			if requested[s.id] {
				if _, ok := sourceByID[s.id]; !ok {
					sourceByID[s.id] = s
				}
			}
		}
	}

	targetProvider, err := readInstanceProvider(targetInst.DataDir)
	if err != nil {
		return SyncToInstanceSummary{}, err
	}

	// 按 id 排序保证确定性。
	ordered := make([]string, 0, len(requested))
	for id := range requested {
		ordered = append(ordered, id)
	}
	sort.Strings(ordered)

	synced, skipped, missing := 0, 0, 0
	for _, id := range ordered {
		if targetExisting[id] {
			skipped++
			continue
		}
		snap, ok := sourceByID[id]
		if !ok {
			missing++
			continue
		}
		if err := copySnapshotToInstance(snap, targetInst.DataDir, targetProvider); err != nil {
			return SyncToInstanceSummary{}, err
		}
		synced++
	}

	msg := ""
	switch {
	case synced > 0:
		msg = fmt.Sprintf("已恢复 %d 条会话到「%s」", synced, targetInst.Name)
	case skipped > 0 && missing == 0:
		msg = fmt.Sprintf("目标实例已存在所选 %d 条会话，无需恢复", skipped)
	default:
		msg = "所选会话在其他实例中不存在，无法恢复到目标实例"
	}
	return SyncToInstanceSummary{
		RequestedSessionCount: len(requested),
		TargetInstanceID:      targetInst.ID,
		TargetInstanceName:    targetInst.Name,
		SyncedSessionCount:    synced,
		SkippedExistingCount:  skipped,
		MissingSessionCount:   missing,
		Running:               targetInst.Running,
		Message:               msg,
	}, nil
}

// SyncThreadsAcrossInstances 跨实例去重线程:构建线程全集(每 id 取首见快照),再把每个
// 实例缺失的线程补齐(复制 rollout + 补 session_index)。要求 ≥ 2 个实例。
func SyncThreadsAcrossInstances(instances []Instance) (ThreadSyncSummary, error) {
	if len(instances) < 2 {
		return ThreadSyncSummary{}, errors.New("sessionsync: 至少需要两个实例才能同步线程")
	}

	// 线程全集 + 每实例已有的线程 id。
	universe := map[string]threadSnapshot{}
	universeOrder := []string{}
	existingByInstance := make([]map[string]bool, len(instances))
	for i, inst := range instances {
		snaps, err := loadThreadSnapshots(inst.DataDir)
		if err != nil {
			return ThreadSyncSummary{}, err
		}
		existing := map[string]bool{}
		for _, s := range snaps {
			existing[s.id] = true
			if _, ok := universe[s.id]; !ok {
				universe[s.id] = s
				universeOrder = append(universeOrder, s.id)
			}
		}
		existingByInstance[i] = existing
	}
	sort.Strings(universeOrder)

	items := make([]ThreadSyncItem, 0, len(instances))
	mutatedInstances, totalSynced, totalAdded := 0, 0, 0
	for i, inst := range instances {
		provider, err := readInstanceProvider(inst.DataDir)
		if err != nil {
			return ThreadSyncSummary{}, err
		}
		added := 0
		for _, id := range universeOrder {
			if existingByInstance[i][id] {
				continue
			}
			snap := universe[id]
			if err := copySnapshotToInstance(snap, inst.DataDir, provider); err != nil {
				return ThreadSyncSummary{}, err
			}
			added++
		}
		if added > 0 {
			mutatedInstances++
			totalSynced += added
			totalAdded += added
		}
		items = append(items, ThreadSyncItem{
			InstanceID:       inst.ID,
			InstanceName:     inst.Name,
			AddedThreadCount: added,
		})
	}

	msg := "所有实例会话已是最新，无需同步"
	if totalSynced > 0 {
		msg = fmt.Sprintf("已为 %d 个实例同步 %d 条会话(新增 %d 条)", mutatedInstances, totalSynced, totalAdded)
	}
	return ThreadSyncSummary{
		InstanceCount:          len(instances),
		ThreadUniverseCount:    len(universe),
		MutatedInstanceCount:   mutatedInstances,
		TotalSyncedThreadCount: totalSynced,
		TotalAddedThreadCount:  totalAdded,
		Items:                  items,
		Message:                msg,
	}, nil
}

// VisibilityRepair 重建/校正跨实例会话可见性:把每个实例下所有 rollout 的首条 session_meta
// 的 model_provider 校正为目标 provider(targetProvider 为空则各实例读自己的 config.toml)。
// 这是官方 Codex 侧边栏能正确显示历史会话的关键元数据。
func VisibilityRepair(instances []Instance, targetProvider string) (VisibilityRepairSummary, error) {
	if len(instances) == 0 {
		return VisibilityRepairSummary{}, errors.New("sessionsync: 未找到要修复的实例")
	}
	override := strings.TrimSpace(targetProvider)

	items := make([]VisibilityRepairItem, 0, len(instances))
	mutatedInstances, changedFiles := 0, 0
	for _, inst := range instances {
		provider := override
		if provider == "" {
			p, err := readInstanceProvider(inst.DataDir)
			if err != nil {
				return VisibilityRepairSummary{}, err
			}
			provider = p
		}
		changed, err := repairInstanceRolloutProviders(inst.DataDir, provider)
		if err != nil {
			return VisibilityRepairSummary{}, err
		}
		if changed > 0 {
			mutatedInstances++
			changedFiles += changed
		}
		items = append(items, VisibilityRepairItem{
			InstanceID:              inst.ID,
			InstanceName:            inst.Name,
			TargetProvider:          provider,
			ChangedRolloutFileCount: changed,
			Running:                 inst.Running,
		})
	}

	msg := "所有实例的会话可见性均一致"
	if changedFiles > 0 {
		msg = fmt.Sprintf("已为 %d 个实例修复会话可见性:校正 %d 个会话文件", mutatedInstances, changedFiles)
	}
	return VisibilityRepairSummary{
		InstanceCount:           len(instances),
		MutatedInstanceCount:    mutatedInstances,
		ChangedRolloutFileCount: changedFiles,
		Items:                   items,
		Message:                 msg,
	}, nil
}

// ListRepairInstances 列出可见性修复的候选实例(带当前 provider + 运行态)。
func ListRepairInstances(instances []Instance) ([]RepairInstanceOption, error) {
	out := make([]RepairInstanceOption, 0, len(instances))
	for _, inst := range instances {
		provider, err := readInstanceProvider(inst.DataDir)
		if err != nil {
			return nil, err
		}
		out = append(out, RepairInstanceOption{
			ID:              inst.ID,
			Name:            inst.Name,
			UserDataDir:     inst.DataDir,
			CurrentProvider: provider,
			Running:         inst.Running,
		})
	}
	return out, nil
}

// ListRepairProviders 收集所有实例的候选 provider(来源:config.toml + rollout session_meta)。
// 默认 provider 取第一个实例的 config provider。
func ListRepairProviders(instances []Instance) (RepairProviderList, error) {
	sources := map[string]map[string]bool{} // provider -> source set
	add := func(id, source string) {
		id = strings.TrimSpace(id)
		if id == "" {
			return
		}
		if sources[id] == nil {
			sources[id] = map[string]bool{}
		}
		sources[id][source] = true
	}

	defaultProvider := defaultProviderID
	for i, inst := range instances {
		p, err := readInstanceProvider(inst.DataDir)
		if err != nil {
			return RepairProviderList{}, err
		}
		if i == 0 {
			defaultProvider = p
		}
		add(p, "config")
		rolloutIDs, err := collectRolloutProviderIDs(inst.DataDir)
		if err != nil {
			return RepairProviderList{}, err
		}
		for _, id := range rolloutIDs {
			add(id, "rollout")
		}
	}
	if len(sources) == 0 {
		add(defaultProvider, "config")
	}

	providers := make([]RepairProviderOption, 0, len(sources))
	for id, set := range sources {
		srcs := make([]string, 0, len(set))
		for s := range set {
			srcs = append(srcs, s)
		}
		sort.Strings(srcs)
		providers = append(providers, RepairProviderOption{
			ID:        id,
			Sources:   srcs,
			IsDefault: id == defaultProvider,
		})
	}
	sort.SliceStable(providers, func(i, j int) bool {
		if providers[i].IsDefault != providers[j].IsDefault {
			return providers[i].IsDefault // 默认在前。
		}
		return providers[i].ID < providers[j].ID
	})
	return RepairProviderList{DefaultProvider: defaultProvider, Providers: providers}, nil
}

// ── 内部辅助 ──

// copySnapshotToInstance 把一条会话快照落到目标实例(保持相对路径),并按目标 provider
// 校正首条 session_meta,最后补齐 session_index。目标已存在同文件则跳过复制(幂等)。
func copySnapshotToInstance(snap threadSnapshot, targetDataDir, targetProvider string) error {
	rel, err := filepath.Rel(snap.sourceRoot, snap.rolloutPath)
	if err != nil {
		return fmt.Errorf("sessionsync: 无法计算 rollout 相对路径 (%s): %w", snap.rolloutPath, err)
	}
	targetPath := filepath.Join(targetDataDir, rel)
	if _, err := os.Stat(targetPath); err == nil {
		// 目标已有同路径文件:只校正 provider,不覆盖内容。
		if _, err := rewriteRolloutProvider(targetPath, targetProvider); err != nil {
			return err
		}
	} else {
		data, err := os.ReadFile(snap.rolloutPath)
		if err != nil {
			return fmt.Errorf("sessionsync: 读取源 rollout 失败 (%s): %w", snap.rolloutPath, err)
		}
		if err := writeFileAtomic(targetPath, data); err != nil {
			return fmt.Errorf("sessionsync: 写入目标 rollout 失败 (%s): %w", targetPath, err)
		}
		if _, err := rewriteRolloutProvider(targetPath, targetProvider); err != nil {
			return err
		}
	}
	entry := snap.indexEntry
	if len(entry) == 0 {
		entry, _ = json.Marshal(map[string]any{"id": snap.id, "thread_name": snap.title})
	}
	return upsertSessionIndexEntry(targetDataDir, snap.id, entry, snap.title)
}

// repairInstanceRolloutProviders 遍历实例下所有 rollout,把首条 session_meta 的 provider
// 校正为 target,返回实际改写的文件数。
func repairInstanceRolloutProviders(dataDir, targetProvider string) (int, error) {
	changed := 0
	for _, dirName := range sessionDirs {
		root := filepath.Join(dataDir, dirName)
		if _, err := os.Stat(root); err != nil {
			continue
		}
		paths, err := listRolloutFiles(root)
		if err != nil {
			return 0, err
		}
		for _, p := range paths {
			did, err := rewriteRolloutProvider(p, targetProvider)
			if err != nil {
				return 0, err
			}
			if did {
				changed++
			}
		}
	}
	return changed, nil
}

// rewriteRolloutProvider 把 rollout 首条 session_meta 的 payload.model_provider 改成 target。
// 已是目标值或首行非 session_meta 则不改;改动了返回 true。其余行原样保留。
func rewriteRolloutProvider(path, targetProvider string) (bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return false, fmt.Errorf("sessionsync: 读取 rollout 失败 (%s): %w", path, err)
	}
	nl := strings.IndexByte(string(data), '\n')
	var firstLine, rest string
	if nl < 0 {
		firstLine = string(data)
		rest = ""
	} else {
		firstLine = string(data[:nl])
		rest = string(data[nl:])
	}
	var record map[string]any
	if json.Unmarshal([]byte(strings.TrimSpace(firstLine)), &record) != nil {
		return false, nil
	}
	if t, _ := record["type"].(string); t != "session_meta" {
		return false, nil
	}
	payload, ok := record["payload"].(map[string]any)
	if !ok {
		return false, nil
	}
	if cur, _ := payload["model_provider"].(string); cur == targetProvider {
		return false, nil
	}
	payload["model_provider"] = targetProvider
	updated, err := json.Marshal(record)
	if err != nil {
		return false, fmt.Errorf("sessionsync: 序列化 session_meta 失败: %w", err)
	}
	if err := writeFileAtomic(path, []byte(string(updated)+rest)); err != nil {
		return false, fmt.Errorf("sessionsync: 写入 rollout 失败 (%s): %w", path, err)
	}
	return true, nil
}

// readInstanceProvider 读实例 config.toml 的 model_provider;缺失/未配置回落 openai。
// 只做一行 key = "value" 的极简解析(codex config.toml 的顶层键即此形态),不引 TOML 库。
func readInstanceProvider(dataDir string) (string, error) {
	path := filepath.Join(dataDir, configFileName)
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return defaultProviderID, nil
		}
		return "", fmt.Errorf("sessionsync: 读取 config.toml 失败 (%s): %w", path, err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "[") {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(key) != "model_provider" {
			continue
		}
		v := strings.TrimSpace(val)
		v = strings.Trim(v, "\"'")
		if v != "" {
			return v, nil
		}
	}
	if err := sc.Err(); err != nil {
		return "", err
	}
	return defaultProviderID, nil
}

// collectRolloutProviderIDs 从实例所有 rollout 的首条 session_meta 收集 model_provider 候选。
func collectRolloutProviderIDs(dataDir string) ([]string, error) {
	seen := map[string]bool{}
	for _, dirName := range sessionDirs {
		root := filepath.Join(dataDir, dirName)
		if _, err := os.Stat(root); err != nil {
			continue
		}
		paths, err := listRolloutFiles(root)
		if err != nil {
			return nil, err
		}
		for _, p := range paths {
			meta, err := readRolloutSessionMeta(p)
			if err != nil {
				return nil, err
			}
			if meta == nil {
				continue
			}
			if payload, ok := meta["payload"].(map[string]any); ok {
				if id, _ := payload["model_provider"].(string); strings.TrimSpace(id) != "" {
					seen[strings.TrimSpace(id)] = true
				}
			}
		}
	}
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	sort.Strings(out)
	return out, nil
}
