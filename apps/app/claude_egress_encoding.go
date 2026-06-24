package main

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"io"
	"strings"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
)

// ─── 出站响应解压 ───────────────────────────────────────────────────────────────
//
// 我们对 api.anthropic.com 原样转发真客户端的 Accept-Encoding(gzip,deflate,br,zstd),
// 以消除「裸奔无 Accept-Encoding」这一反代破绽。代价是上游可能回压缩 body,而下游一律按
// 明文处理(token 解析 / SSE 解析 / 写回本地客户端)。所以在转发层就地解压、还原明文,
// 下游解析逻辑一律不动。本地客户端这一跳是 localhost,解压开销可忽略。
//
// identity / 空编码 = 绝大多数情况,调用方据 Content-Encoding 是否存在短路,零额外开销。

// decompressReader 按 Content-Encoding 给 r 包一层解压 reader。未知或 identity 原样返回。
// 返回的 ReadCloser 关闭只释放解压器自身;底层源(resp.Body)仍由调用方各自 defer 关闭。
func decompressReader(enc string, r io.Reader) (io.ReadCloser, error) {
	switch strings.ToLower(strings.TrimSpace(enc)) {
	case "", "identity":
		return io.NopCloser(r), nil
	case "gzip", "x-gzip":
		zr, err := gzip.NewReader(r)
		if err != nil {
			return nil, err
		}
		return zr, nil
	case "deflate":
		return flate.NewReader(r), nil
	case "br":
		return io.NopCloser(brotli.NewReader(r)), nil
	case "zstd":
		zr, err := zstd.NewReader(r)
		if err != nil {
			return nil, err
		}
		return zr.IOReadCloser(), nil
	default:
		// 未知编码:不动,原样透传(由客户端按其 Content-Encoding 自行处理)。
		return io.NopCloser(r), nil
	}
}

// decodeUpstreamBytes 解压一段完整响应体(非流式路径)。
// ok=true 表示成功还原明文,调用方应随后删除 Content-Encoding 头;
// ok=false(未知编码/损坏)则回退原始字节并保留头,继续按原编码透传给客户端。
func decodeUpstreamBytes(enc string, raw []byte) (out []byte, ok bool) {
	rc, err := decompressReader(enc, bytes.NewReader(raw))
	if err != nil {
		return raw, false
	}
	defer rc.Close()
	decoded, err := io.ReadAll(rc)
	if err != nil {
		return raw, false
	}
	return decoded, true
}
