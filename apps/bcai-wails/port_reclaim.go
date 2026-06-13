package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// errPortForeignHeld 表示端口被一个【非本程序】的进程占用 —— 我们绝不去杀它,
// 调用方据此决定是否退到备用端口(见 LocalHTTPProxy.Start 的端口兜底)。
var errPortForeignHeld = errors.New("port held by a foreign process")

// isAddrInUse 判断监听错误是否为"端口已被占用"。
func isAddrInUse(err error) bool {
	if errors.Is(err, syscall.EADDRINUSE) {
		return true
	}
	// 兜底:某些平台/包装错误下用文本匹配(Windows 的 WSAEADDRINUSE 文案)。
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "address already in use") ||
		strings.Contains(msg, "only one usage of each socket address")
}

func sleepMs(ms int) { time.Sleep(time.Duration(ms) * time.Millisecond) }

// listenWithReclaim 像 net.Listen("tcp", addr) 一样监听,但当端口被占用时
// (典型场景:上一次客户端没干净退出、残留实例还占着代理端口),会找到并杀掉
// 【确属本程序】的残留实例,然后重试。绝不杀别人的进程,也永远不杀自己。
//
// 若端口被一个【非本程序】的进程占着,返回 errPortForeignHeld —— 不动它,
// 交给上层(LocalHTTPProxy.Start)退到备用端口。
//
// 仅用于本地代理端口(127.0.0.1),不要拿去回收对外端口。
func listenWithReclaim(addr string) (net.Listener, error) {
	ln, err := net.Listen("tcp", addr)
	if err == nil {
		return ln, nil
	}

	// 仅在"地址被占用"时才尝试回收,其它错误(权限等)直接返回。
	if !isAddrInUse(err) {
		return nil, err
	}

	_, portStr, splitErr := net.SplitHostPort(addr)
	if splitErr != nil {
		return nil, err // 解析不出端口,放弃回收,返回原始错误
	}
	port, convErr := strconv.Atoi(portStr)
	if convErr != nil || port <= 0 {
		return nil, err
	}

	killed, foreign := reclaimPort(port)
	if killed == 0 {
		if foreign {
			// 被别人(非本程序)占着 → 绝不杀,交给上层做端口兜底。
			return nil, errPortForeignHeld
		}
		// 没找到可杀的进程(可能 lsof/tasklist 没解析出来),返回原始错误。
		return nil, err
	}

	// 给系统一点时间释放端口,然后重试(~5s,扛过 TIME_WAIT / 释放延迟)。
	for i := 0; i < 50; i++ {
		ln, err = net.Listen("tcp", addr)
		if err == nil {
			Log("[port] 端口 %d 被本程序残留实例占用,已回收 %d 个后成功监听", port, killed)
			return ln, nil
		}
		sleepMs(100)
	}
	return nil, fmt.Errorf("端口 %d 回收后仍无法监听: %w", port, err)
}

// reclaimPort 杀掉监听指定端口、且【确属本程序】的残留进程(跳过自身)。
// 返回 (杀掉的数量, 是否见到非本程序/无法判定的占用者)。
// 安全优先:不是本程序、或无法确认身份的进程,一律【不杀】,只标记 foreign=true。
func reclaimPort(port int) (killed int, foreign bool) {
	self := os.Getpid()
	for _, pid := range pidsOnPort(port) {
		if pid == self || pid <= 0 {
			continue
		}
		if !processMatchesSelf(pid) {
			Log("[port] 端口 %d 被外部进程 PID=%d 占用,不杀(交给端口兜底)", port, pid)
			foreign = true
			continue
		}
		if killPID(pid) {
			Log("[port] 已回收占用端口 %d 的本程序残留实例 PID=%d", port, pid)
			killed++
		}
	}
	return killed, foreign
}

// processMatchesSelf 判断 pid 是否在运行与【本程序相同的可执行文件】(按文件名比对)。
// 用于回收端口时只杀自己的残留实例,绝不误伤别人的程序。无法判定时返回 false(安全优先)。
func processMatchesSelf(pid int) bool {
	selfExe, err := os.Executable()
	if err != nil {
		return false
	}
	other := processImageName(pid)
	if other == "" {
		return false
	}
	return sameExeName(filepath.Base(selfExe), other)
}

// processImageName 返回 pid 进程的可执行文件名(basename),取不到返回空。
func processImageName(pid int) string {
	if runtime.GOOS == "windows" {
		// tasklist /FI "PID eq N" /NH /FO CSV → "Image.exe","PID",... ;无匹配时输出"信息:..."。
		out, err := hideCmd("tasklist", "/FI", fmt.Sprintf("PID eq %d", pid), "/NH", "/FO", "CSV").Output()
		if err != nil {
			return ""
		}
		line := strings.TrimSpace(string(out))
		if !strings.HasPrefix(line, "\"") {
			return ""
		}
		if end := strings.Index(line[1:], "\""); end >= 0 {
			return filepath.Base(line[1 : 1+end])
		}
		return ""
	}
	// macOS / Linux: ps -p N -o comm=
	out, err := hideCmd("ps", "-p", strconv.Itoa(pid), "-o", "comm=").Output()
	if err != nil {
		return ""
	}
	return filepath.Base(strings.TrimSpace(string(out)))
}

// sameExeName 比较两个可执行文件名是否同一程序(大小写不敏感)。
// Linux 的 ps comm 会把名字截断到 15 字符,仅在确实达到截断长度时才放宽到前缀匹配,
// 避免把不同程序误判成同一个。
func sameExeName(a, b string) bool {
	a = strings.ToLower(strings.TrimSpace(a))
	b = strings.ToLower(strings.TrimSpace(b))
	if a == "" || b == "" {
		return false
	}
	if a == b {
		return true
	}
	const linuxCommMax = 15
	if len(a) >= linuxCommMax || len(b) >= linuxCommMax {
		return strings.HasPrefix(a, b) || strings.HasPrefix(b, a)
	}
	return false
}

// pidsOnPort 返回正在 LISTEN 指定端口的进程 PID 列表(跨平台)。
func pidsOnPort(port int) []int {
	if runtime.GOOS == "windows" {
		return pidsOnPortWindows(port)
	}
	return pidsOnPortUnix(port)
}

// macOS / Linux: lsof -ti tcp:PORT -sTCP:LISTEN
func pidsOnPortUnix(port int) []int {
	out, err := hideCmd("lsof", "-ti", fmt.Sprintf("tcp:%d", port), "-sTCP:LISTEN").Output()
	if err != nil {
		return nil
	}
	var pids []int
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if pid, e := strconv.Atoi(line); e == nil {
			pids = append(pids, pid)
		}
	}
	return pids
}

// Windows: netstat -ano | findstr :PORT  → 取 LISTENING 行最后一列的 PID
func pidsOnPortWindows(port int) []int {
	out, err := hideCmd("netstat", "-ano", "-p", "tcp").Output()
	if err != nil {
		return nil
	}
	needle := fmt.Sprintf(":%d", port)
	seen := map[int]bool{}
	var pids []int
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(line, "LISTENING") || !strings.Contains(line, needle) {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		// 进一步确认是本地地址列(第二列)恰好以 :port 结尾,避免误伤 :48800x 之类
		local := fields[1]
		if !strings.HasSuffix(local, needle) {
			continue
		}
		if pid, e := strconv.Atoi(fields[len(fields)-1]); e == nil && !seen[pid] {
			seen[pid] = true
			pids = append(pids, pid)
		}
	}
	return pids
}

// killPID 强杀指定进程(跨平台)。
func killPID(pid int) bool {
	if runtime.GOOS == "windows" {
		return hideCmd("taskkill", "/F", "/PID", strconv.Itoa(pid)).Run() == nil
	}
	if proc, err := os.FindProcess(pid); err == nil {
		return proc.Kill() == nil
	}
	return false
}
