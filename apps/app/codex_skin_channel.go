package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ─── Codex 皮肤调试通道 ────────────────────────────────────────────────────
//
// 冰茶只做「通道」:开关开启后,冰茶拉起 Codex 时附加 --remote-debugging-port,
// 并维护 ~/.bingchaai/codex-skin/ 下的发现文件(state.json + skill/)。皮肤的设计、
// 注入、迭代、还原全部由用户自己的 AI Agent 按 skill/SKILL.md 完成 —— 冰茶不出
// 预设、不做编辑器、不介入设计,也绝不写入任何 Agent 的配置目录。
//
// 目录布局(路径对外承诺,写进 SKILL.md,不可随意变更):
//
//	~/.bingchaai/codex-skin/
//	  state.json   # {"enabled":bool,"port":int,"updatedAt":RFC3339} 供任何工具发现
//	  skill/       # SKILL.md + inject.mjs,随开关落盘(每次覆盖,与客户端版本同步)
//	  themes/      # 用户 Agent 的皮肤产物,冰茶只建目录不写内容
//
// 安全边界:端口只绑回环(CDP 自身行为);功能默认关闭;UI 明示「通道开启期间本机
// 任何程序都可控制 Codex 界面」。关闭开关后下次启动不再附加参数,零残留。

//go:embed skillassets/codex-skin
var codexSkinSkillFS embed.FS

// codexSkinChannelPort 固定用 Dream-Skin 生态的惯例端口,便于社区脚本兼容。
const codexSkinChannelPort = 9335

// codexSkinHomeDir 允许测试覆写 HOME 定位(生产恒走 os.UserHomeDir)。
var codexSkinHomeDir = func() string {
	home, _ := os.UserHomeDir()
	return home
}

func codexSkinRootDir() string {
	return filepath.Join(codexSkinHomeDir(), ".bingchaai", "codex-skin")
}
func codexSkinStatePath() string { return filepath.Join(codexSkinRootDir(), "state.json") }
func codexSkinSkillDir() string  { return filepath.Join(codexSkinRootDir(), "skill") }
func codexSkinThemesDir() string { return filepath.Join(codexSkinRootDir(), "themes") }

// codexSkinState 是 state.json 的落盘形态 —— 对外发现协议,字段名不可变。
type codexSkinState struct {
	Enabled   bool   `json:"enabled"`
	Port      int    `json:"port"`
	UpdatedAt string `json:"updatedAt"`
}

// writeCodexSkinState 原子写 state.json(临时文件 + rename,避免 Agent 读到半截)。
func writeCodexSkinState(enabled bool) error {
	if err := os.MkdirAll(codexSkinRootDir(), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(codexSkinState{
		Enabled:   enabled,
		Port:      codexSkinChannelPort,
		UpdatedAt: time.Now().Format(time.RFC3339),
	}, "", "  ")
	if err != nil {
		return err
	}
	tmp := codexSkinStatePath() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, codexSkinStatePath()); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// readCodexSkinState 读 state.json;不存在/损坏视为未开启(与 SKILL.md 的约定一致)。
func readCodexSkinState() codexSkinState {
	out := codexSkinState{Port: codexSkinChannelPort}
	data, err := os.ReadFile(codexSkinStatePath())
	if err != nil {
		return out
	}
	_ = json.Unmarshal(data, &out)
	if out.Port <= 0 {
		out.Port = codexSkinChannelPort
	}
	return out
}

// materializeCodexSkinSkill 把内嵌 skill 文件落盘到 skill/(整目录覆盖,保证与客户端
// 版本一致;用户不应改这里的文件,自己的产物放 themes/)。顺带确保 themes/ 存在。
func materializeCodexSkinSkill() error {
	if err := os.MkdirAll(codexSkinSkillDir(), 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(codexSkinThemesDir(), 0o755); err != nil {
		return err
	}
	const embedRoot = "skillassets/codex-skin"
	return fs.WalkDir(codexSkinSkillFS, embedRoot, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(embedRoot, filepath.FromSlash(p))
		if err != nil {
			return err
		}
		data, err := codexSkinSkillFS.ReadFile(p)
		if err != nil {
			return err
		}
		dst := filepath.Join(codexSkinSkillDir(), rel)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		return os.WriteFile(dst, data, 0o644)
	})
}

var codexSkinMaterializeOnce sync.Once

// ensureCodexSkinSkillMaterialized 进程内首次访问时落盘一次(Get 路径用,幂等且便宜;
// Set 路径总是强制重落,见 LocalSetCodexSkinChannel)。
func ensureCodexSkinSkillMaterialized() {
	codexSkinMaterializeOnce.Do(func() {
		if err := materializeCodexSkinSkill(); err != nil {
			Log("[codex-skin] skill 落盘失败(不致命): %v", err)
		}
	})
}

// codexSkinChannelEnabled 报告通道开关是否开启(读 Codex 设置;hub 不可用时视为关)。
func codexSkinChannelEnabled() bool {
	if err := ensureLocal(); err != nil {
		return false
	}
	return localHub.GetCodexSettings().SkinChannelEnabled
}

// codexSkinLaunchArgs 返回拉起 Codex GUI 时需附加的启动参数;通道关闭时为 nil。
// 只对 GUI 有意义:调用方(LaunchCodexApp)已保证仅在 GUI 分支使用。
func codexSkinLaunchArgs() []string {
	if !codexSkinChannelEnabled() {
		return nil
	}
	return []string{fmt.Sprintf("--remote-debugging-port=%d", codexSkinChannelPort)}
}

// probeCodexSkinChannel 探测通道当前是否可达(Codex 是否带调试端口在跑)。
// 短超时:这是 UI 状态行的同步查询,不能拖慢设置页。
func probeCodexSkinChannel() bool { return probeCodexSkinChannelAt(codexSkinChannelPort) }

func probeCodexSkinChannelAt(port int) bool {
	client := &http.Client{Timeout: 600 * time.Millisecond}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/json/version", port))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}
