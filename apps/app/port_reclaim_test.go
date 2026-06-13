package main

import (
	"net"
	"os"
	"testing"
)

// sameExeName:同名(大小写不敏感)算同一程序;不同名不算;短名不做前缀匹配避免误判;
// 仅在达到 Linux comm 截断长度(15)时才放宽到前缀匹配。
func TestSameExeName(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"BingchaAI", "BingchaAI", true},
		{"BingchaAI", "bingchaai", true},
		{"BingchaAI.exe", "bingchaai.exe", true},
		{"BingchaAI", "Chrome", false},
		{"BingchaAI", "", false},
		{"", "", false},
		{"BingchaAI", "Bing", false},                    // 短名:不前缀匹配,绝不误判成同一程序
		{"verylongprocessname", "verylongproces", true}, // ≥15 触发截断前缀匹配
	}
	for _, c := range cases {
		if got := sameExeName(c.a, c.b); got != c.want {
			t.Errorf("sameExeName(%q,%q)=%v want %v", c.a, c.b, got, c.want)
		}
	}
}

// processMatchesSelf:本进程必判为「是本程序」(真);一个几乎不可能存在的 PID 取不到镜像名 →
// 判为「非本程序」(假)。后者是关键:回收端口时无法确认身份就绝不杀。
func TestProcessMatchesSelf(t *testing.T) {
	if !processMatchesSelf(os.Getpid()) {
		t.Error("processMatchesSelf(self) = false, want true")
	}
	if processMatchesSelf(2147483646) {
		t.Error("processMatchesSelf(bogus pid) = true, want false(无法确认身份必须不杀)")
	}
}

// bindProxyListener:首选端口被(自己)占住、回收不到 → 退到候选端口,仍能成功监听。
func TestBindProxyListenerFallback(t *testing.T) {
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("setup listen: %v", err)
	}
	defer occupied.Close()
	preferred := occupied.Addr().(*net.TCPAddr).Port

	ln, actual, err := bindProxyListener(preferred)
	if err != nil {
		t.Fatalf("bindProxyListener(%d) err: %v", preferred, err)
	}
	defer ln.Close()
	if actual == preferred {
		t.Errorf("actual=%d 等于被占的首选端口,应退到备用端口", actual)
	}
	if actual <= 0 {
		t.Errorf("actual=%d, want >0", actual)
	}
}
