package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

// ── permHintFor:纯函数,四种属主/位置组合各自的措辞 ──────────────────────────

func TestPermHintForRootOwnedDirInsideHomeSuggestsChown(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".claude")

	hint := permHintFor(dir, "root", 0, 501, home)

	if !strings.Contains(hint, "chown") {
		t.Fatalf("家目录内的 root 属主目录应给出 chown 指引,得到: %q", hint)
	}
	if !strings.Contains(hint, "root") {
		t.Fatalf("应点名属主 root,得到: %q", hint)
	}
	if !strings.Contains(hint, dir) {
		t.Fatalf("chown 命令应带上出问题的绝对路径 %q,得到: %q", dir, hint)
	}
}

// 关键安全边界:/usr 这类系统目录属主是 root 属正常,对它 chown -R 是危险建议。
func TestPermHintForNeverSuggestsChownOutsideHome(t *testing.T) {
	home := t.TempDir()
	outside := t.TempDir() // 与 home 平级,不在 home 内

	hint := permHintFor(outside, "root", 0, 501, home)

	if strings.Contains(hint, "chown") {
		t.Fatalf("家目录之外不得建议 chown,得到: %q", hint)
	}
	if hint == "" {
		t.Fatal("仍应给出中性的排查指引,不能为空")
	}
}

// 同样危险:对家目录自身 chown -R 会翻掉用户整个 home。
func TestPermHintForNeverSuggestsChownOnHomeItself(t *testing.T) {
	home := t.TempDir()

	hint := permHintFor(home, "root", 0, 501, home)

	if strings.Contains(hint, "chown") {
		t.Fatalf("不得建议对家目录自身 chown,得到: %q", hint)
	}
}

// 用户会直接复制这条命令去跑:带空格的路径不加引号会被 shell 拆成两个参数,命令当场坏掉。
func TestPermHintForQuotesPathsWithSpaces(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "Application Support", ".claude")

	hint := permHintFor(dir, "root", 0, 501, home)

	if !strings.Contains(hint, "'"+dir+"'") {
		t.Fatalf("含空格的路径应被引用,否则复制出去的 chown 是坏的,得到: %q", hint)
	}
}

func TestPermHintForSameOwnerFallsBackToNeutralAdvice(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".claude")

	hint := permHintFor(dir, "tester", 501, 501, home)

	if strings.Contains(hint, "chown") {
		t.Fatalf("属主已经是当前用户时不该建议 chown,得到: %q", hint)
	}
	if !strings.Contains(hint, "ls -ld") {
		t.Fatalf("应引导用户自查权限位,得到: %q", hint)
	}
}

// ── takeoverPermissionHint:只认权限错误,其余一律放行 ────────────────────────

func TestTakeoverPermissionHintIgnoresNonPermissionErrors(t *testing.T) {
	cases := []struct {
		name string
		err  error
	}{
		{"nil", nil},
		{"普通错误", errors.New("boom")},
		{"文件不存在", &fs.PathError{Op: "open", Path: "/nope/x", Err: fs.ErrNotExist}},
	}
	for _, c := range cases {
		if hint := takeoverPermissionHint(c.err); hint != "" {
			t.Fatalf("%s 不该产生权限指引,得到: %q", c.name, hint)
		}
	}
}

// 无路径信息的权限错误无法诊断,应放行而不是瞎猜。
func TestTakeoverPermissionHintIgnoresPathlessPermissionError(t *testing.T) {
	if hint := takeoverPermissionHint(fs.ErrPermission); hint != "" {
		t.Fatalf("没有路径就无从诊断,应返回空,得到: %q", hint)
	}
}

// 真实构造一次 EACCES,验证 errors.Is / PathError 提取 / 最近存在祖先 整条链路。
func TestTakeoverPermissionHintFromRealPermissionError(t *testing.T) {
	skipIfCannotDenyWrite(t)
	dir := t.TempDir()
	lockDir(t, dir)

	_, err := os.CreateTemp(dir, ".bcai-codex-*.tmp")
	if err == nil {
		t.Fatal("期望 CreateTemp 因权限失败")
	}

	hint := takeoverPermissionHint(err)
	if hint == "" {
		t.Fatalf("真实权限错误应产生指引,原始错误: %v", err)
	}
	// 临时文件本身不存在,指引应落在它所在的目录上。
	if !strings.Contains(hint, dir) {
		t.Fatalf("指引应点名目录 %q,得到: %q", dir, hint)
	}
}

// pathOwnerUID 是「真实 EACCES」与「chown 指引」之间唯一没被覆盖的一环:纯函数测试喂的是
// 写死的 uid=0,而真实错误的用例里目录属主就是当前用户。用系统上必然存在且必然属于 root 的
// 目录把这一环钉住 —— 否则 root 属主(也就是用户实际会踩的那条)全程没人验过。
func TestPathOwnerUIDReadsRootOwnedSystemDir(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 无 POSIX uid")
	}
	uid, ok := pathOwnerUID("/usr")
	if !ok {
		t.Fatal("/usr 应该 stat 得到属主")
	}
	if uid != 0 {
		t.Fatalf("/usr 的属主应是 root(uid=0),得到 %d", uid)
	}
}

// ── takeoverErrorForUser:结构化前缀,供前端分派 ──────────────────────────────

func TestTakeoverErrorForUserTagsPermissionErrorWithPrefix(t *testing.T) {
	skipIfCannotDenyWrite(t)
	dir := t.TempDir()
	lockDir(t, dir)

	_, err := os.CreateTemp(dir, ".bcai-codex-*.tmp")
	if err == nil {
		t.Fatal("期望 CreateTemp 因权限失败")
	}

	out := takeoverErrorForUser(err)
	if !strings.HasPrefix(out.Error(), "FILE_PERM:") {
		t.Fatalf("权限错误应带 FILE_PERM: 前缀供前端分派,得到: %q", out.Error())
	}
}

func TestTakeoverErrorForUserPassesThroughOtherErrors(t *testing.T) {
	in := errors.New("MITM 代理未启动")
	if out := takeoverErrorForUser(in); out != in {
		t.Fatalf("非权限错误必须原样返回(否则会污染 CA_FAILED / STORE_CLAUDE 等既有前缀),得到: %v", out)
	}
	if takeoverErrorForUser(nil) != nil {
		t.Fatal("nil 必须返回 nil")
	}
}

// InjectSelected 把错误包成 "<产品>: 接管失败 (<err>)",前端按 FILE_PERM: 切分后再剥掉
// 结尾那个包装用的右括号。钉住这条往返契约:任一侧单独改动都不能把指引截坏。
func TestFilePermErrorSurvivesInjectSelectedWrapping(t *testing.T) {
	home := t.TempDir()
	hint := permHintFor(filepath.Join(home, ".claude"), "root", 0, 501, home)
	wire := fmt.Sprintf("%s: 接管失败 (%v)", "Claude Code", fmt.Errorf("FILE_PERM:%s", hint))

	// 前端的还原方式(与 STORE_CLAUDE: 分支同款)。
	tail := wire[strings.Index(wire, "FILE_PERM:")+len("FILE_PERM:"):]
	got := strings.TrimSpace(regexp.MustCompile(`\)\s*$`).ReplaceAllString(tail, ""))

	if got != hint {
		t.Fatalf("前端还原出的指引与后端原文不一致\n原文: %q\n还原: %q", hint, got)
	}
}

// ── 端到端:复现用户实际踩的那条路径(~/.claude 不可写 → 接管失败)──────────────

func TestInjectClaudeSettingsPermissionErrorSurfacesAsFilePerm(t *testing.T) {
	skipIfCannotDenyWrite(t)
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	lockDir(t, dir)

	err := InjectClaudeSettings(8123)
	if err == nil {
		t.Fatal("目录不可写时 InjectClaudeSettings 应报错")
	}
	out := takeoverErrorForUser(err)
	if !strings.HasPrefix(out.Error(), "FILE_PERM:") {
		t.Fatalf("~/.claude 不可写应被诊断为 FILE_PERM,得到: %q", out.Error())
	}
}

// ── helpers ────────────────────────────────────────────────────────────────

func skipIfCannotDenyWrite(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("Windows 无 POSIX 权限位,权限诊断不适用")
	}
	if os.Getuid() == 0 {
		t.Skip("以 root 运行时权限位不生效,无法构造 permission denied")
	}
}

// lockDir 把目录设为不可写(r-x),并在用例结束后恢复,否则 t.TempDir 清理会失败。
func lockDir(t *testing.T, dir string) {
	t.Helper()
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatalf("chmod %s: %v", dir, err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })
}
