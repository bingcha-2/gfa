package main

import "testing"

// 回归:go test 下绝不能真去 open/kill 用户本机的 Codex / Antigravity GUI。
// 集成测试用真实 localPlatform + 真实 app 探测(Spotlight/ /Applications,不受 HOME 沙箱),
// 若不拦,SetSource / 运行时控制会拉起/杀掉本机 app(app 被偷偷打开、退出登录观感、进程堆积)。
func TestAppActions_SuppressedUnderTest(t *testing.T) {
	if !appActionsSuppressed() {
		t.Fatal("go test 下 appActionsSuppressed() 必须为 true(否则测试会动本机 GUI)")
	}
	// LaunchApp 在测试下 no-op:返回哨兵 pid=-1,绝不 exec open。
	pid, err := localPlatform{}.LaunchApp("/Applications/Codex.app", "", nil)
	if err != nil || pid != -1 {
		t.Fatalf("测试下 LaunchApp 应 no-op(pid=-1,不 open),got pid=%d err=%v", pid, err)
	}
	// CodexRestartApp / Antigravity 运行时:即便本机装了 app,测试下也不得 open/kill。
	if err := (localPlatform{}).CodexRestartApp(); err != nil {
		t.Fatalf("测试下 CodexRestartApp 应 no-op,got %v", err)
	}
	if err := (localPlatform{}).AntigravityAppStart("standalone"); err != nil {
		t.Fatalf("测试下 AntigravityAppStart 应 no-op,got %v", err)
	}
	if err := (localPlatform{}).AntigravityAppStop("ide"); err != nil {
		t.Fatalf("测试下 AntigravityAppStop 应 no-op,got %v", err)
	}
}
