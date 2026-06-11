package main

import (
	"reflect"
	"testing"
)

// certutil argv 构造 + 输出判定的纯逻辑单测。真实 certutil 仅 Windows 有、且会改证书库,
// 故把"命令长什么样""输出怎么解读"抽成纯函数,在任意平台(host/CI)都能锁住行为。

// 主路径子命令必须走【本机】根存储(不带 -user):CurrentUser 根在部分机器上不被 Claude 的
// Chromium 信任 → claude.ai 白屏,所以本机库永远是首选。带 -user 的 CurrentUser 命令是
// mitmInstallCA 在本机库(直接 + UAC 提权)全部失败后的【显式降级兜底】(certutilAddUserRootArgs),
// 不在本测试覆盖范围 —— 降级到用户库虽可能白屏,但「装上(可能白屏,有提示)」优于「装不上(必无 Max)」。
func TestCertutilArgs_PrimaryPathUsesLocalMachineStore(t *testing.T) {
	cases := map[string][]string{
		"add":   certutilAddRootArgs(`C:\ca.crt`),
		"del":   certutilDelRootArgs("BingchaAI Local Root"),
		"query": certutilQueryRootArgs("BingchaAI Local Root"),
	}
	for name, args := range cases {
		if containsArg(args, "-user") {
			t.Errorf("%s args %v 不应带 -user(主路径必须本机库;CurrentUser 仅作降级兜底)", name, args)
		}
		if !containsArg(args, "Root") {
			t.Errorf("%s args %v 未指向 Root 存储", name, args)
		}
	}
}

// 降级兜底:CurrentUser 安装/查询命令必须带 -user(否则会去操作本机库、走错存储)。
func TestCertutilUserRootArgs(t *testing.T) {
	add := certutilAddUserRootArgs(`C:\Users\me\.bcai\mitm\ca.crt`)
	wantAdd := []string{"-user", "-f", "-addstore", "Root", `C:\Users\me\.bcai\mitm\ca.crt`}
	if !reflect.DeepEqual(add, wantAdd) {
		t.Fatalf("add(user) args = %v, want %v", add, wantAdd)
	}
	query := certutilQueryUserRootArgs("BingchaAI Local Root")
	wantQuery := []string{"-user", "-store", "Root", "BingchaAI Local Root"}
	if !reflect.DeepEqual(query, wantQuery) {
		t.Fatalf("query(user) args = %v, want %v", query, wantQuery)
	}
}

func TestCertutilAddRootArgs(t *testing.T) {
	got := certutilAddRootArgs(`C:\Users\me\.bcai\mitm\ca.crt`)
	want := []string{"-f", "-addstore", "Root", `C:\Users\me\.bcai\mitm\ca.crt`}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("addstore args = %v, want %v", got, want)
	}
}

func TestCertutilDelRootArgs(t *testing.T) {
	got := certutilDelRootArgs("BingchaAI Local Root")
	want := []string{"-delstore", "Root", "BingchaAI Local Root"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("delstore args = %v, want %v", got, want)
	}
}

func TestCertutilQueryRootArgs(t *testing.T) {
	got := certutilQueryRootArgs("BingchaAI Local Root")
	want := []string{"-store", "Root", "BingchaAI Local Root"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("store args = %v, want %v", got, want)
	}
}

// 遗留清理删的是【当前用户】库(必须带 -user),否则会去删本机库、删错对象。
func TestCertutilDelUserRootArgs(t *testing.T) {
	got := certutilDelUserRootArgs("BingchaAI Local Root")
	want := []string{"-user", "-delstore", "Root", "BingchaAI Local Root"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("legacy del(user) args = %v, want %v", got, want)
	}
}

// delstore 找不到证书(CRYPT_E_NOT_FOUND)= 本就没装 = 卸载视作成功(幂等);其它失败照报。
func TestCertutilDeleteErrBenign(t *testing.T) {
	tests := []struct {
		name string
		out  string
		want bool
	}{
		{"crypt_e_not_found hex", "CertUtil: -delstore command FAILED: 0x80092004 (-2146885628)", true},
		{"cannot find text", "Cannot find the requested object.", true},
		{"access denied is real error", "CertUtil: -delstore command FAILED: 0x80070005 Access is denied.", false},
		{"empty output is not benign", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := certutilDeleteErrBenign([]byte(tt.out)); got != tt.want {
				t.Fatalf("certutilDeleteErrBenign(%q) = %v, want %v", tt.out, got, tt.want)
			}
		})
	}
}

func containsArg(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}
