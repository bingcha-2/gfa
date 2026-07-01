// Package oauthcb 解析 OAuth 回调 URL(手动粘贴场景),提取 code/state/error。
//
// 语义与 CLIProxyAPI SDK 内部的 misc.ParseOAuthCallback 逐字段对齐(该函数在
// internal/misc 包,不可直接 import),这样「手动粘贴回调 URL」在本地侧做的早期
// 校验与 SDK 最终喂入 Prompt 后的解析结果一致,不会出现「本地放行、SDK 拒绝」。
package oauthcb

import (
	"errors"
	"net/url"
	"strings"
)

// Callback 是从回调 URL 解析出的 OAuth 参数。
type Callback struct {
	Code             string
	State            string
	Error            string
	ErrorDescription string
}

// ErrEmpty 表示输入为空(既非成功也非失败,调用方应当继续等待)。
var ErrEmpty = errors.New("oauthcb: empty input")

// Parse 从一段用户粘贴的文本(可能是完整 URL、裸 query、或 key=value 片段)中提取
// OAuth 回调参数。空输入返回 (Callback{}, ErrEmpty)。既无 code 又无 error 视为无效。
//
// 兼容形态(对齐 SDK):
//   - 完整 URL:http://localhost:1455/auth/callback?code=X&state=Y
//   - 以 ? 开头的 query:?code=X&state=Y
//   - 含 / ? # : 的相对形态:localhost/cb?code=X
//   - 裸 key=value:code=X&state=Y
//   - code 里内嵌 #state(部分 provider 把 state 拼到 fragment)
//   - fragment 里带参数(#code=..&state=..)
func Parse(input string) (Callback, error) {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return Callback{}, ErrEmpty
	}

	candidate := trimmed
	if !strings.Contains(candidate, "://") {
		switch {
		case strings.HasPrefix(candidate, "?"):
			candidate = "http://localhost" + candidate
		case strings.ContainsAny(candidate, "/?#") || strings.Contains(candidate, ":"):
			candidate = "http://" + candidate
		case strings.Contains(candidate, "="):
			candidate = "http://localhost/?" + candidate
		default:
			return Callback{}, errors.New("oauthcb: invalid callback URL")
		}
	}

	parsed, err := url.Parse(candidate)
	if err != nil {
		return Callback{}, err
	}

	query := parsed.Query()
	code := strings.TrimSpace(query.Get("code"))
	state := strings.TrimSpace(query.Get("state"))
	errCode := strings.TrimSpace(query.Get("error"))
	errDesc := strings.TrimSpace(query.Get("error_description"))

	// 部分 provider 把参数放在 fragment 里。
	if parsed.Fragment != "" {
		if fragQuery, errFrag := url.ParseQuery(parsed.Fragment); errFrag == nil {
			if code == "" {
				code = strings.TrimSpace(fragQuery.Get("code"))
			}
			if state == "" {
				state = strings.TrimSpace(fragQuery.Get("state"))
			}
			if errCode == "" {
				errCode = strings.TrimSpace(fragQuery.Get("error"))
			}
			if errDesc == "" {
				errDesc = strings.TrimSpace(fragQuery.Get("error_description"))
			}
		}
	}

	// code 里内嵌 #state:code#state。
	if code != "" && state == "" && strings.Contains(code, "#") {
		parts := strings.SplitN(code, "#", 2)
		code = parts[0]
		state = parts[1]
	}

	// 只有 error_description 没有 error 时,把描述提升为 error 码。
	if errCode == "" && errDesc != "" {
		errCode = errDesc
		errDesc = ""
	}

	if code == "" && errCode == "" {
		return Callback{}, errors.New("oauthcb: callback URL missing code")
	}

	return Callback{Code: code, State: state, Error: errCode, ErrorDescription: errDesc}, nil
}
