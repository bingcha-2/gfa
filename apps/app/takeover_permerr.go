package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
)

// ─── 接管的文件权限诊断 ──────────────────────────────────────────────────────
//
// 背景:Claude Code / Codex 的接管只写家目录下的配置(~/.claude/settings.json、
// ~/.codex/config.toml)。这类写失败几乎都是【属主不对】—— 用户之前 sudo 跑过
// npm install / CLI,目录被 root 占了,之后普通身份再写就是 EACCES。
//
// 这跟 macOS 的隐私权限(App 管理 / 完全磁盘访问)【毫无关系】:家目录下的隐藏目录
// 不归 TCC 管。但前端旧逻辑把 mac 上的任何接管失败都引导去开「App 管理」,用户照着做
// 也修不好。故在这里把 EACCES 翻成能直接执行的修复指引,并打上 FILE_PERM: 前缀,让前端
// 走专门分支(与既有的 CA_FAILED: / STORE_CLAUDE: / EGRESS_BLOCKED: 同一套约定)。

// takeoverErrorForUser 把接管过程中的底层错误翻成前端能分派的结构化错误。
// 只处理文件权限错误(打 FILE_PERM: 前缀),其余原样返回 —— 绝不能包装 CA_FAILED:、
// STORE_CLAUDE: 等既有前缀错误,否则前端的 includes 分派会错位。
func takeoverErrorForUser(err error) error {
	if hint := takeoverPermissionHint(err); hint != "" {
		return fmt.Errorf("FILE_PERM:%s", hint)
	}
	return err
}

// takeoverPermissionHint 在 err 是「带路径的权限错误」时,返回面向用户的修复指引;
// 其余情况(含 nil、非权限错误、拿不到路径或属主)返回空串,由调用方回落到原始错误。
func takeoverPermissionHint(err error) string {
	if err == nil || !errors.Is(err, fs.ErrPermission) {
		return ""
	}
	var pe *fs.PathError
	if !errors.As(err, &pe) || pe.Path == "" {
		return "" // 没有路径就无从诊断属主,不瞎猜
	}
	dir := nearestExistingDir(pe.Path)
	if dir == "" {
		return ""
	}
	ownerUID, ok := pathOwnerUID(dir)
	if !ok {
		return "" // 拿不到属主(如 Windows)
	}
	ownerName := ""
	if u, e := user.LookupId(strconv.Itoa(ownerUID)); e == nil {
		ownerName = u.Username
	}
	home, _ := os.UserHomeDir()
	return permHintFor(dir, ownerName, ownerUID, os.Getuid(), home)
}

// permHintFor 由「目录 + 属主 + 当前用户 + 家目录」拼出修复指引。纯函数,便于覆盖各种组合。
//
// ⚠ 只在目录位于家目录【内部且不是家目录本身】时才建议 chown:/usr 这类系统目录属主是 root
// 属正常,家目录自身 chown -R 会翻掉用户的一切 —— 对它们建议 chown 是危险的。这两种情况一律
// 回落到中性的排查指引。
func permHintFor(dir, ownerName string, ownerUID, currentUID int, home string) string {
	shown := abbrevHome(dir, home)
	if ownerUID != currentUID && isStrictlyInside(dir, home) {
		owner := ownerName
		if owner == "" {
			owner = fmt.Sprintf("uid=%d", ownerUID)
		}
		return fmt.Sprintf(
			"%s 的属主是 %s,当前用户没有写权限,接管无法写入配置。\n\n"+
				"这通常是之前用 sudo 跑过 npm install / CLI 留下的 —— 以 root 跑过一次,它新建的文件就归 root 了。与 macOS 的隐私权限无关,不用去开「App 管理」。\n\n"+
				"请在终端执行下面这条,然后回来重新接管:\n\n    sudo chown -R \"$(whoami)\" %s",
			shown, owner, shellQuote(dir))
	}
	return fmt.Sprintf(
		"%s 当前用户没有写权限,接管无法写入配置。与 macOS 的隐私权限无关,不用去开「App 管理」。\n\n"+
			"请在终端执行下面这条,确认它的属主和权限位;把属主改回当前用户、或补上写权限后重新接管:\n\n    ls -ld %s",
		shown, shellQuote(dir))
}

// nearestExistingDir 返回 path 自身(若它是已存在的目录)或其最近的已存在祖先目录。
// 写失败时出问题的通常是【临时文件所在的目录】而非临时文件本身(它压根没建成)。
func nearestExistingDir(path string) string {
	p := filepath.Clean(path)
	for {
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			return p
		}
		parent := filepath.Dir(p)
		if parent == p { // 走到根还没找到
			return ""
		}
		p = parent
	}
}

// isStrictlyInside 判断 dir 是否位于 home 内部(且不等于 home 本身)。
func isStrictlyInside(dir, home string) bool {
	if home == "" {
		return false
	}
	rel, err := filepath.Rel(filepath.Clean(home), filepath.Clean(dir))
	if err != nil {
		return false
	}
	return rel != "." && !strings.HasPrefix(rel, "..")
}

// abbrevHome 把家目录前缀缩成 ~,仅用于展示(命令里仍用绝对路径,避免空格/展开歧义)。
func abbrevHome(path, home string) string {
	if home == "" {
		return path
	}
	if path == home {
		return "~"
	}
	if isStrictlyInside(path, home) {
		rel, err := filepath.Rel(filepath.Clean(home), filepath.Clean(path))
		if err == nil {
			return "~/" + filepath.ToSlash(rel)
		}
	}
	return path
}
