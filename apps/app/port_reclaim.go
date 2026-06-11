package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

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
// (典型场景:上一次客户端没干净退出、残留实例还占着代理端口),会自动找到并
// 杀掉占用该端口的进程,然后重试一次。永远不会杀掉自己。
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

	killed := reclaimPort(port)
	if killed == 0 {
		// 没找到可杀的进程(可能是别的程序以更高权限占用),返回原始错误
		return nil, err
	}

	// 给系统一点时间释放端口,然后重试一次。
	for i := 0; i < 10; i++ {
		ln, err = net.Listen("tcp", addr)
		if err == nil {
			Log("[port] 端口 %d 被占用,已回收 %d 个进程后成功监听", port, killed)
			return ln, nil
		}
		sleepMs(100)
	}
	return nil, fmt.Errorf("端口 %d 回收后仍无法监听: %w", port, err)
}

// reclaimPort 找到监听指定端口的进程并杀掉(跳过自身),返回杀掉的进程数。
func reclaimPort(port int) int {
	self := os.Getpid()
	pids := pidsOnPort(port)
	killed := 0
	for _, pid := range pids {
		if pid == self || pid <= 0 {
			continue
		}
		if killPID(pid) {
			Log("[port] 已杀掉占用端口 %d 的进程 PID=%d", port, pid)
			killed++
		}
	}
	return killed
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
