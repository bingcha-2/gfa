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
		req.Header.Set("x-token-server-secret", secret)
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()

	respBody, readErr := io.ReadAll(resp.Body)
	return respBody, resp.StatusCode, readErr
}

func postJsonWithSecret(client *http.Client, path string, payload interface{}, secret string) ([]byte, int, error) {
	return postJSONWithSecretToBase(API_BASE, client, path, payload, secret)
}

func postBcaiBaseWithFallback(baseURL string, path string, payload interface{}, card string, upstreamProxy string) ([]byte, int, error) {
	// 依次尝试主域名 → 备域名（bcai_hosts.go）；每个域名内部再做 直连 → 代理 回退。
	// 注意：只有传输层失败（err != nil）才切换；服务器返回了 HTTP 响应（即使 4xx/5xx）
	// 视为该域名可用，直接返回，不再切换域名。
	var lastErr error
	for _, base := range bcaiURLCandidates(baseURL) {
		body, status, err := postJSONWithSecretToBase(base, createBcaiClient(), path, payload, card)
		if err == nil {
			return body, status, nil
		}
		Log("[bcai] Direct connection failed for %s (%v), retrying via proxy", base, err)

		body, status, err = postJSONWithSecretToBase(base, createHttpClient(upstreamProxy), path, payload, card)
		if err == nil {
			return body, status, nil
		}
		Log("[bcai] Proxy connection failed for %s (%v)", base, err)
		lastErr = err
	}
	return nil, 0, lastErr
}
