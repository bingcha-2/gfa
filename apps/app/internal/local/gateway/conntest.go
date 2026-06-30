package gateway

import (
	"fmt"
	"io"
	"net/http"
	"time"
)

// ConnTestResult 是连通测试结果(前端展示用)。
type ConnTestResult struct {
	OK        bool   `json:"ok"`        // 是否收到 HTTP 响应(数据面可达)
	Status    int    `json:"status"`    // HTTP 状态码(0=未收到响应)
	LatencyMs int64  `json:"latencyMs"` // 往返耗时(毫秒)
	Err       string `json:"err"`       // 错误信息(ok=true 时为空)
}

// ConnTest 对本地网关发一个最小真请求(GET /v1/models),验证数据面可达。
// 收到任何 HTTP 状态(含 401/404)即视为连通(ok=true)——证明网关在监听并应答;
// 仅当连接层失败(拒绝/超时)才 ok=false。带上一条已配置的访问 key(若有)。
func (g *Gateway) ConnTest() ConnTestResult {
	g.mu.Lock()
	running := g.svc != nil
	addr := fmt.Sprintf("%s:%d", g.host, g.port)
	var key string
	if len(g.apiKeys) > 0 {
		key = g.apiKeys[0]
	}
	g.mu.Unlock()

	if !running {
		return ConnTestResult{Err: "网关未启动"}
	}

	url := fmt.Sprintf("http://%s/v1/models", addr)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return ConnTestResult{Err: err.Error()}
	}
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}

	client := &http.Client{Timeout: 5 * time.Second}
	start := time.Now()
	resp, err := client.Do(req)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return ConnTestResult{LatencyMs: latency, Err: err.Error()}
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	return ConnTestResult{OK: true, Status: resp.StatusCode, LatencyMs: latency}
}
