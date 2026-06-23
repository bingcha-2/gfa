package main

import (
	"encoding/json"
	"net/http"
	"strings"
)

// 上报请求头时必须丢弃的凭证头 —— 存它们等于把客户的卡密/会话落到服务端库里。
var reportHeaderDenylist = map[string]bool{
	"authorization":       true,
	"x-api-key":           true,
	"cookie":              true,
	"set-cookie":          true,
	"proxy-authorization": true,
}

// 单个头值超过这个长度就跳过("特别大的不存")。
const reportHeaderValueMax = 1024

// filterReportHeaders 采集请求头用于审计/封号分析上报:
//   - 去掉凭证头(authorization / x-api-key / cookie / proxy-authorization 等);
//   - 跳过特别大的值(> reportHeaderValueMax);
//   - 其余按 name→value 收成 JSON。绝不含 body、绝不含密钥。
func filterReportHeaders(h http.Header) string {
	m := make(map[string]string, len(h))
	for k, vs := range h {
		if reportHeaderDenylist[strings.ToLower(k)] {
			continue
		}
		if len(vs) == 0 {
			continue
		}
		v := vs[0]
		if len(v) > reportHeaderValueMax {
			continue
		}
		m[k] = v
	}
	if len(m) == 0 {
		return ""
	}
	b, err := json.Marshal(m)
	if err != nil {
		return ""
	}
	return string(b)
}
