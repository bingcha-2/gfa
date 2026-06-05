package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
)

// ─── 伪造付费资格(entitlement upgrade):保留真登录，只把订阅等级改写成 pro ──────
//
// 与"伪造整个登录"不同：这里不碰身份。把鉴权/资格端点(/api/hello、claude_code/settings、
// policy_limits 等)带着用户【真实账号的 Authorization】转发到上游，拿到真响应后，只把
// billing_type/subscription 等"付费资格"字段改写成 pro，再回给客户端 —— 让免费真账号也能
// 通过 Code/Cowork 的"是不是付费用户"那道闸；推理 /v1/messages 仍走号池付费 token。
//
// 这是 macOS 上唯一可行的"便宜用号池"路径：登录态(safeStorage/IPC)原生工作、一行不伪造，
// 只伪造"付费资格"这几个走 HTTP 的判定字段。
//
// 兜底：若上游返回 401/403(完全未登录)，退回 canned 假 pro 身份(mitmMockBody)——兼顾
// Windows/Linux 的"零账号"场景(那边登录态是文件式、可彻底伪造)。
//
// 实测辅助：每条经此 handler 的响应都打印真实 body(截断)，方便抓准确 schema 后精修字段。

// entitlementOverrides 是要改写成"付费"的字段白名单(键名 → 目标值)。
// 递归套用到响应 JSON 的任意层级；只动这些已知字段，不碰其它内容。
var entitlementOverrides = map[string]interface{}{
	"billing_type":         "pro",
	"billingType":          "pro",
	"subscription_type":    "pro",
	"subscriptionType":     "pro",
	"has_assigned_account": true,
	"hasAssignedAccount":   true,
	"has_claude_pro":       true,
	"hasClaudePro":         true,
	"has_claude_max":       true,
	"hasClaudeMax":         true,
}

// mitmEntitlementHandler 转发到上游(保留真 Authorization)，再把响应里的付费资格字段改写成 pro。
// transport 可注入(测试用)；nil 时用默认。
func mitmEntitlementHandler(upstreamBase string, transport http.RoundTripper) http.Handler {
	target, err := url.Parse(upstreamBase)
	if err != nil || target.Host == "" {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "mitm: bad upstream base", http.StatusBadGateway)
		})
	}
	rp := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host
			req.Host = target.Host
			// 让上游返回未压缩响应，便于改写(兜底仍处理 gzip)。
			req.Header.Del("Accept-Encoding")
		},
		ModifyResponse: mitmModifyEntitlementResponse,
	}
	if transport != nil {
		rp.Transport = transport
	}
	return rp
}

// mitmModifyEntitlementResponse 读响应体 → 打印真实内容(实测抓 schema)→ 改写付费字段 / 401 兜底。
func mitmModifyEntitlementResponse(resp *http.Response) error {
	path := ""
	if resp.Request != nil && resp.Request.URL != nil {
		path = resp.Request.URL.Path
	}

	body, err := readMaybeGzip(resp)
	if err != nil {
		return nil // 读失败就放过，不破坏原响应链路
	}

	var newBody []byte
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		// 完全未登录 → 退回 canned 假 pro 身份(零账号兜底，主要给 Windows/Linux)。
		newBody = []byte(mitmMockBody(path))
		resp.StatusCode = http.StatusOK
		resp.Status = "200 OK"
		resp.Header.Set("Content-Type", "application/json")
	case strings.Contains(resp.Header.Get("Content-Type"), "json") && len(body) > 0:
		newBody = mitmPatchEntitlement(body)
	default:
		newBody = body
	}

	resp.Body = io.NopCloser(bytes.NewReader(newBody))
	resp.ContentLength = int64(len(newBody))
	resp.Header.Set("Content-Length", strconv.Itoa(len(newBody)))
	resp.Header.Del("Content-Encoding") // 已解压并以明文回写
	return nil
}

// readMaybeGzip 读取响应体，必要时解 gzip。
func readMaybeGzip(resp *http.Response) ([]byte, error) {
	defer resp.Body.Close()
	if strings.EqualFold(resp.Header.Get("Content-Encoding"), "gzip") {
		zr, err := gzip.NewReader(resp.Body)
		if err != nil {
			return nil, err
		}
		defer zr.Close()
		return io.ReadAll(zr)
	}
	return io.ReadAll(resp.Body)
}

// mitmPatchEntitlement 把响应 JSON 里白名单字段改写成"付费"值；无可改字段则原样返回。
func mitmPatchEntitlement(body []byte) []byte {
	var v interface{}
	if json.Unmarshal(body, &v) != nil {
		return body // 非 JSON，不动
	}
	if !patchEntitlementValue(v) {
		return body
	}
	out, err := json.Marshal(v)
	if err != nil {
		return body
	}
	return out
}

// patchEntitlementValue 递归改写：命中白名单键就置为目标值。返回是否有改动。
func patchEntitlementValue(v interface{}) bool {
	changed := false
	switch t := v.(type) {
	case map[string]interface{}:
		for k := range t {
			if ov, ok := entitlementOverrides[k]; ok {
				t[k] = ov
				changed = true
			} else if patchEntitlementValue(t[k]) {
				changed = true
			}
		}
	case []interface{}:
		for _, e := range t {
			if patchEntitlementValue(e) {
				changed = true
			}
		}
	}
	return changed
}
