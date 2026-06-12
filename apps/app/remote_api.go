package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

func postJSONWithSecretToBase(baseURL string, client *http.Client, path string, payload interface{}, secret string) ([]byte, int, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, 0, err
	}

	req, err := http.NewRequest("POST", strings.TrimRight(baseURL, "/")+path, bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	if secret != "" {
		req.Header.Set("Authorization", "Bearer "+secret)
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()

	// 限制响应体读取上限(1 MiB):lease/auth 响应都是小 JSON,防止异常/恶意上游
	// 用超大响应把客户端内存打爆。doAuthPost / doAuthPostWithBearer 也经这里。
	respBody, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return respBody, resp.StatusCode, readErr
}

func postJsonWithSecret(client *http.Client, path string, payload interface{}, secret string) ([]byte, int, error) {
	return postJSONWithSecretToBase(API_BASE, client, path, payload, secret)
}

func postBcaiBaseWithFallback(baseURL string, path string, payload interface{}, card string, upstreamProxy string) ([]byte, int, error) {
	// 单域名(api.bcai.lol);传输层做 直连 → 代理 回退。客户端 9.5.0 起强制升级,
	// 不再有 bcai.space 备域名(host fallback 已随强升移除,见 docs/NAMING.md 子域规划)。
	// 注意:只有传输层失败(err != nil)才回退;服务器返回了 HTTP 响应(即使 4xx/5xx)
	// 视为成功,直接返回。
	body, status, err := postJSONWithSecretToBase(baseURL, createBcaiClient(), path, payload, card)
	if err == nil {
		return body, status, nil
	}
	Log("[bcai] Direct connection failed for %s (%v), retrying via proxy", baseURL, err)

	body, status, err = postJSONWithSecretToBase(baseURL, createHttpClient(upstreamProxy), path, payload, card)
	if err == nil {
		return body, status, nil
	}
	Log("[bcai] Proxy connection failed for %s (%v)", baseURL, err)
	return nil, 0, err
}
