package modelprovider

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

const testTimeout = 20 * time.Second

// ConnTestResult 是供应商连通测试结果(前端展示用),对齐 gateway.ConnTestResult 形状。
type ConnTestResult struct {
	OK        bool   `json:"ok"`        // 是否收到 2xx(/models 可用)
	Status    int    `json:"status"`    // HTTP 状态码(0=未收到响应)
	LatencyMs int64  `json:"latencyMs"` // 往返耗时(毫秒)
	Err       string `json:"err"`       // 错误信息(ok=true 时为空)
	Model     string `json:"model"`     // /models 里第一个模型 id(若有)
}

// Model 是动态目录里的一条模型。
type Model struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName,omitempty"`
}

// ListModelsResult 是 ListModels 的返回(目录 + 时延)。
type ListModelsResult struct {
	Models    []Model `json:"models"`
	LatencyMs int64   `json:"latencyMs"`
}

// httpDoer 抽象 http.Client,便于单测注入 mock。
type httpDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

func defaultClient() httpDoer { return &http.Client{Timeout: testTimeout} }

// TestConnection 对 provider 的 /models 端点发一个最小真请求,返回连通结果。
// client 为 nil 时用默认带超时的 http.Client(单测注入 mock)。
// 收到 2xx 即 ok=true;鉴权/路径/网络错误均在结果里描述,不返回 error(对齐 cockpit)。
func TestConnection(p Provider, client httpDoer) ConnTestResult {
	if client == nil {
		client = defaultClient()
	}
	key := strings.TrimSpace(p.APIKey)
	if key == "" {
		return ConnTestResult{Err: "MISSING_API_KEY"}
	}
	url, err := modelsURL(p.BaseURL)
	if err != nil {
		return ConnTestResult{Err: err.Error()}
	}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return ConnTestResult{Err: err.Error()}
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Accept", "application/json")

	start := time.Now()
	resp, err := client.Do(req)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return ConnTestResult{LatencyMs: latency, Err: err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ConnTestResult{Status: resp.StatusCode, LatencyMs: latency, Err: "HTTP_STATUS"}
	}
	models := parseModels(body)
	first := ""
	if len(models) > 0 {
		first = models[0].ID
	}
	return ConnTestResult{OK: true, Status: resp.StatusCode, LatencyMs: latency, Model: first}
}

// ListModels 拉 provider /models 的模型 id 列表(去重、保序)。
// client 为 nil 时用默认 http.Client。失败返回 error(供调用方优雅降级)。
func ListModels(p Provider, client httpDoer) (ListModelsResult, error) {
	if client == nil {
		client = defaultClient()
	}
	key := strings.TrimSpace(p.APIKey)
	if key == "" {
		return ListModelsResult{}, sentinelErr("MISSING_API_KEY")
	}
	url, err := modelsURL(p.BaseURL)
	if err != nil {
		return ListModelsResult{}, err
	}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return ListModelsResult{}, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Accept", "application/json")

	start := time.Now()
	resp, err := client.Do(req)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return ListModelsResult{}, sentinelErr("PROVIDER_MODELS_NETWORK_FAILED: " + err.Error())
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ListModelsResult{}, httpStatusErr(resp.StatusCode, body)
	}
	return ListModelsResult{Models: parseModels(body), LatencyMs: latency}, nil
}

// openAIModelsBody 是 OpenAI 兼容 /models 响应({"data":[{"id":...}]})。
type openAIModelsBody struct {
	Data []struct {
		ID          string `json:"id"`
		DisplayName string `json:"display_name"`
		DisplayAlt  string `json:"displayName"`
	} `json:"data"`
}

// parseModels 解析 OpenAI 兼容 /models 响应,去重保序(移植 cockpit list_model_provider_models)。
func parseModels(body []byte) []Model {
	var parsed openAIModelsBody
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil
	}
	seen := map[string]struct{}{}
	out := make([]Model, 0, len(parsed.Data))
	for _, item := range parsed.Data {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			continue
		}
		key := strings.ToLower(id)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		display := strings.TrimSpace(item.DisplayName)
		if display == "" {
			display = strings.TrimSpace(item.DisplayAlt)
		}
		out = append(out, Model{ID: id, DisplayName: display})
	}
	return out
}

func httpStatusErr(status int, body []byte) error {
	snippet := strings.TrimSpace(string(body))
	if len(snippet) > 300 {
		snippet = snippet[:300]
	}
	return sentinelErr("PROVIDER_MODELS_HTTP_" + itoa(status) + ": " + snippet)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [12]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
