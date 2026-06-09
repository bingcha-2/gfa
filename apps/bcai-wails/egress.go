package main

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strings"
)

// EgressInfo 是服务端随每条租约下发的"出口策略",客户端据此决定打官方上游那一跳走哪个出口。
// 它把三家(anthropic/codex/antigravity)的差异收敛成纯数据,客户端无需写死 provider 名:
//   - ProxyURL:       该账号绑定的粘性出口代理(住宅/移动 IP),空=未绑定。
//   - EgressRequired: true(anthropic)=必须经绑定代理出站,无代理则拒连(绝不从本机 IP 直连官方);
//                     false(codex/antigravity)=绑了就走代理,没绑就本地直连(fail-open)。
type EgressInfo struct {
	ProxyURL       string `json:"accountProxyUrl"`
	EgressRequired bool   `json:"egressRequired"`
}

// errEgressRequired:策略为 required 但该号未下发出口代理 → 拒绝从本机直连官方。
var errEgressRequired = errors.New("egress proxy required but not configured; refusing direct connection from local IP")

// resolveEgress 解析"首选出口"。账号绑定代理永远优先(运营者为该号钉死的住宅出口);
// 无绑定时由策略决定:required → 拒绝(blocked=true);optional → 回落到本地解析
// (userProxy 为空时下游 client 工厂会继续走系统代理 → 直连)。
func resolveEgress(e EgressInfo, userProxy string) (proxy string, blocked bool) {
	if p := strings.TrimSpace(e.ProxyURL); p != "" {
		return p, false
	}
	if e.EgressRequired {
		return "", true
	}
	return userProxy, false
}

// doUpstreamWithFallback 用 egress 解析出的出口发一次上游请求;若该出口是"账号绑定代理"
// 且策略为 optional,则在【传输层失败】(代理拨不通/超时/TLS,即 client.Do 返回 err)时降级
// 本地直连重试一次,再不行才把错误抛回让上层切号。
//
// 只在传输层失败时降级:拿到了响应(哪怕 4xx/5xx)= 代理通了、上游真实作答,绝不降级
// (换出口 IP 会改变请求语义、且可能对已落地的生成重复计费)。流式响应在写出首字节前失败
// 才会走到这里(client.Do 在收到响应头前返回 err),故重试是安全的。
//
// newClient(proxy) 由各 provider 传入自己的 client 工厂(codex 的 uTLS streaming client 等),
// 工厂内部对空 proxy 仍会做"系统代理 → 直连"的本地解析,故 optional 无绑定路径天然 fail-open。
func doUpstreamWithFallback(
	e EgressInfo,
	userProxy string,
	body []byte,
	req *http.Request,
	newClient func(proxy string) *http.Client,
) (*http.Response, error) {
	proxy, blocked := resolveEgress(e, userProxy)
	if blocked {
		return nil, errEgressRequired
	}
	resp, err := newClient(proxy).Do(req)
	if err == nil {
		return resp, nil
	}
	// 账号绑定代理 + optional → 降级本地直连重试一次(req body 已被消费,用缓冲的 body 重建)。
	if strings.TrimSpace(e.ProxyURL) != "" && !e.EgressRequired {
		retry := req.Clone(req.Context())
		retry.Body = io.NopCloser(bytes.NewReader(body))
		retry.ContentLength = int64(len(body))
		if resp2, err2 := newClient(userProxy).Do(retry); err2 == nil {
			return resp2, nil
		}
	}
	return nil, err
}
