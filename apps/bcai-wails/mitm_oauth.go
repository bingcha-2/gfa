package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

// ─── 伪造 Code/Cowork 的 OAuth(授权码+PKCE)流程 → 把免费号的 Code 授权换成号池 Pro token ──
//
// 抓包(Max 号)确认的真实流程:
//   ① POST /v1/oauth/{org}/authorize {response_type,client_id,redirect_uri,state,code_challenge,...}
//        → {"redirect_uri":"<redirect_uri>?code=<授权码>&state=<state>"}
//   ② POST /v1/oauth/token {grant_type:authorization_code,code,code_verifier,redirect_uri,...}
//        → {"token_type":"Bearer","access_token":"sk-ant-oat01-...","refresh_token":"sk-ant-ort01-...",
//           "expires_in":...,"scope":...,"organization":{...},"account":{...}}
//
// 关键:token 端点返回的 access_token 就是 oat01 token —— 跟号池给的同款。所以免费号走这两步时:
//   - authorize:我们合成一个带 code 的 redirect_uri(code 随便给,后面不校验);
//   - token:返回【号池真 Pro token】。
// 之后客户端拿这个真 token 调 /api/oauth/profile(→真返回 Max)、/v1/messages(→真能跑),
// Code/Cowork 付费墙自然消失。PKCE 两端都由我们伪造,服务端不参与,客户端只要拿到 token 即满足。
//
// 免费号自己的 org 没订阅也无所谓 —— Cowork 实际是以【号池账号】在干活,这正是"免费号当壳 + 号池出活"。

// mitmShouldFakeOAuth 命中 Code OAuth 的两步(authorize / token)。
func mitmShouldFakeOAuth(path string) bool {
	if !strings.HasPrefix(path, "/v1/oauth/") {
		return false
	}
	return strings.HasSuffix(path, "/authorize") || strings.HasSuffix(path, "/token")
}

// mitmOAuthFakeHandler 伪造 authorize/token。leaseToken 返回号池当前的真 access token。
func mitmOAuthFakeHandler(leaseToken func() (string, error)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = r.Body.Close()
		var req map[string]interface{}
		_ = json.Unmarshal(body, &req)

		writeJSON := func(v interface{}) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(v)
		}

		switch {
		case strings.HasSuffix(r.URL.Path, "/authorize"):
			redirectURI, _ := req["redirect_uri"].(string)
			state, _ := req["state"].(string)
			code := "bcai_" + randToken(48)
			sep := "?"
			if strings.Contains(redirectURI, "?") {
				sep = "&"
			}
			writeJSON(map[string]interface{}{
				"redirect_uri": redirectURI + sep + "code=" + code + "&state=" + state,
			})

		case strings.HasSuffix(r.URL.Path, "/token"):
			tok, err := leaseToken()
			if err != nil || tok == "" {
				Log("[mitm-oauth] 租号池 token 失败,无法伪造 token: %v", err)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadGateway)
				_, _ = w.Write([]byte(`{"error":"server_error","error_description":"pool lease failed"}`))
				return
			}
			scope, _ := req["scope"].(string)
			if scope == "" {
				scope = "user:inference user:file_upload user:profile user:sessions:claude_code"
			}
			writeJSON(map[string]interface{}{
				"token_type":    "Bearer",
				"access_token":  tok,
				"refresh_token": "sk-ant-ort01-" + randToken(100), // 占位:客户端短期不用;真刷新走 /v1/messages 兜底
				"expires_in":    2592000,
				"scope":         scope,
				"token_uuid":    generateUUID(),
			})
		}
	})
}
