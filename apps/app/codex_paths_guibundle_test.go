package main

import (
	"os"
	"path/filepath"
	"testing"
)

// canonicalCaseApp 必须把大小写错误的 .app 叶子名修正回磁盘上的真实名。
// 场景:APFS 大小写不敏感,陈旧 config 里可能把 ChatGPT.app 存成 ChatGpt.app,
// os.Stat 照样通过,于是脏大小写会一路带到 UI 展示 / 日志 / 品牌反推。
// 用 ReadDir + EqualFold 归一,在大小写敏感与不敏感文件系统上都确定。
func TestCanonicalCaseApp(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "ChatGPT.app")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatal(err)
	}

	// 传入大小写错误的 ChatGpt.app → 修正回真实名 ChatGPT.app。
	if got := canonicalCaseApp(filepath.Join(dir, "ChatGpt.app")); got != real {
		t.Fatalf("canonicalCaseApp(ChatGpt.app) = %q, want %q", got, real)
	}
	// 已是真实名 → 原样返回。
	if got := canonicalCaseApp(real); got != real {
		t.Fatalf("canonicalCaseApp(真实名) = %q, want %q", got, real)
	}
	// 父目录读不到 / 无匹配项 → 原样返回,不报错。
	missing := filepath.Join(dir, "Nope.app")
	if got := canonicalCaseApp(missing); got != missing {
		t.Fatalf("canonicalCaseApp(无匹配) = %q, want 原样 %q", got, missing)
	}
}

// validatedCodexGUIBundle 收口不变式:只有"真实内含 Codex CLI"的 .app 才算 Codex 桌面端,
// 且返回磁盘真实大小写。据此把 config override 与品牌兜底统一防住两类误判:
//   - 与 Codex 无关的独立 ChatGPT 聊天 app(无 Contents/Resources/codex)
//   - 陈旧 / 大小写错误的路径
func TestValidatedCodexGUIBundle(t *testing.T) {
	dir := t.TempDir()

	// 内含 Codex CLI 的真桌面端 bundle。
	app := filepath.Join(dir, "ChatGPT.app")
	cli := filepath.Join(app, "Contents", "Resources", "codex")
	if err := os.MkdirAll(filepath.Dir(cli), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, cli, "codex")

	// 大小写错误的输入也应命中,并归一到真实名(先归一再验内容)。
	if got := validatedCodexGUIBundle(filepath.Join(dir, "ChatGpt.app")); got != app {
		t.Fatalf("validatedCodexGUIBundle(ChatGpt.app) = %q, want %q", got, app)
	}

	// 独立 ChatGPT 聊天 app:有 .app 但无 Resources/codex → 必须拒绝(不变式核心)。
	bare := filepath.Join(dir, "OnlyChat.app")
	if err := os.MkdirAll(bare, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := validatedCodexGUIBundle(bare); got != "" {
		t.Fatalf("独立 ChatGPT(无 Codex CLI)应被拒绝, got %q", got)
	}

	// 空串 / 非 .app → 空。
	if got := validatedCodexGUIBundle(""); got != "" {
		t.Fatalf("空串应返回空, got %q", got)
	}
	if got := validatedCodexGUIBundle(filepath.Join(dir, "codex")); got != "" {
		t.Fatalf("非 .app 应返回空, got %q", got)
	}
}
