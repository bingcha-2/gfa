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
	body, status, err := postJSONWithSecretToBase(baseURL, createBcaiClient(), path, payload, card)
	if err == nil {
		return body, status, nil
	}

	Log("[bcai] Direct connection failed (%v), retrying via proxy", err)
	return postJSONWithSecretToBase(baseURL, createHttpClient(upstreamProxy), path, payload, card)
}
