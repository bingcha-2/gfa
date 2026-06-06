package main

import (
	"errors"
	"reflect"
	"testing"
)

// certutil argv 构造 + 输出判定的纯逻辑单测。真实 certutil 仅 Windows 有、且会改证书库,
// 故把"命令长什么样""输出怎么解读"抽成纯函数,在任意平台(host/CI)都能锁住行为。

// 全部子命令必须走 CurrentUser 根存储(-user):这是"免管理员/UAC"承诺的关键。
// 漏掉 -user 会变成写 LocalMachine、要求提权 —— 在这台 Mac 上跑不到真机,只能靠该测试守住。
func TestCertutilArgs_AllUseCurrentUserStore(t *testing.T) {
	cases := map[string][]string{
		"add":   certutilAddRootArgs(`C:\ca.crt`),
		"del":   certutilDelRootArgs("BingchaAI Local Root"),
		"query": certutilQueryRootArgs("BingchaAI Local Root"),
	}
	for name, args := range cases {
		if !containsArg(args, "-user") {
			t.Errorf("%s args %v 缺少 -user(会退化为 LocalMachine、要求管理员)", name, args)
		}
		if !containsArg(args, "Root") {
			t.Errorf("%s args %v 未指向 Root 存储", name, args)
		}
	}
}

func TestCertutilAddRootArgs(t *testing.T) {
	got := certutilAddRootArgs(`C:\Users\me\.bcai\mitm\ca.crt`)
	want := []string{"-user", "-f", "-addstore", "Root", `C:\Users\me\.bcai\mitm\ca.crt`}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("addstore args = %v, want %v", got, want)
	}
}

func TestCertutilDelRootArgs(t *testing.T) {
	got := certutilDelRootArgs("BingchaAI Local Root")
	want := []string{"-user", "-delstore", "Root", "BingchaAI Local Root"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("delstore args = %v, want %v", got, want)
	}
}

func TestCertutilQueryRootArgs(t *testing.T) {
	got := certutilQueryRootArgs("BingchaAI Local Root")
	want := []string{"-user", "-store", "Root", "BingchaAI Local Root"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("store args = %v, want %v", got, want)
	}
}

// 已安装 = 退出码 0 且输出含目标 CN。非 0 退出(找不到)或输出无 CN 都算"未装"。
func TestCertutilQueryShowsCA(t *testing.T) {
	const cn = "BingchaAI Local Root"
	tests := []struct {
		name string
		out  string
		err  error
		want bool
	}{
		{"found", "================ Certificate 0 ================\nSubject: CN=BingchaAI Local Root\n", nil, true},
		{"not found (non-zero exit)", "CertUtil: -store command FAILED: 0x80092004", errors.New("exit status 1"), false},
		{"exit 0 but other cert only", "Subject: CN=Some Other Root\n", nil, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := certutilQueryShowsCA([]byte(tt.out), tt.err, cn); got != tt.want {
				t.Fatalf("certutilQueryShowsCA(%q, %v) = %v, want %v", tt.out, tt.err, got, tt.want)
			}
		})
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
