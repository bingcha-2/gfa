package main

import (
	"bytes"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// ─── claude.ai 桌面端 UI 改写：隐藏 Chat、只留 Code/Cowork ────────────────────
//
// 桌面端把 claude.ai 网页加载进 WebContentsView —— chat 与 code 的 UI 都来自 claude.ai
// （本机 asar 的 main_window/index.html 注释明写「everything else gets loaded from
// claude.ai」；主进程用 webContents.loadURL('https://claude.ai...')）。这些顶层 HTML
// 文档经 Chromium --proxy-server 走本地 MITM，因此可在文档里注入一段守卫脚本。
//
// 为什么是「隐藏」而不是「接管」chat：chat 走 claude.ai 网页对话端点、用用户【真实(免费号)
// 会话】，我们对 claude.ai 会话端点一律字节级透传（一旦改写会触发 account_session_invalid、
// 踢回登录页），无法像 Code 那样换号池 Pro token。故 chat 在接管态下注定不可用 —— 隐藏入口
// 避免用户点进去撞 503/付费墙而困惑。
//
// 安全边界：只注入【顶层 HTML 文档】(Content-Type: text/html)；JSON/API 响应一律不碰，
// 会话/bootstrap 完整性不受影响（与 mitmModifyClaudeAiResponse 的字节级透传约定一致）。

// bcaiHideChatMarker 注入幂等标记：已注入过的文档不再二次注入。
const bcaiHideChatMarker = "__bcai_hide_chat__"

// bcaiHideChatSnippet 注入进 claude.ai 文档 <head> 的 <style>+<script>。
//
// ⚠ 选择器是「最佳猜测 + 多兜底」：chat 入口的真实 DOM 需在桌面端开 DevTools 实测精修。
// 不依赖选择器的硬保险是 redirectIfChat()（命中 chat 路由直接跳 /code），即便 CSS/observer
// 没命中具体元素，用户也会被导回 code。CHAT_ROUTES / CODE_HOME 集中在脚本顶部便于调整。
const bcaiHideChatSnippet = `<style id="__bcai_hide_chat_css__">
/* ── 隐藏 Chat 模式入口 ──
   DOM 诊断确认:chat/cowork/code 是 button[aria-label],不是 a[href]。
   「New chat」「Recents」「Pinned」也是 button。 */

/* 1. Chat 模式切换按钮 */
button[aria-label="Chat"] { display: none !important; }

/* 2. 新对话按钮 */
button[aria-label="New chat"] { display: none !important; }

/* 3. 链接兜底(旧版/未来版) */
a[href^="/new"], a[href^="/chat"], a[href^="/recents"],
a[href="/"], a[href^="/epitaxy"],
[data-testid="new-chat-button"], [data-testid*="new-conversation"] {
  display: none !important;
}
</style>
<script id="__bcai_hide_chat_js__">
(function(){
  if (window.__bcaiHideChat) return;
  window.__bcaiHideChat = true;

  // ── 按 aria-label 隐藏 chat 入口 ──
  var HIDE_ARIA = ["Chat", "New chat"];

  function hideChatButtons() {
    try {
      HIDE_ARIA.forEach(function(label) {
        document.querySelectorAll('button[aria-label="' + label + '"]').forEach(function(btn) {
          btn.style.setProperty("display", "none", "important");
        });
      });
      document.querySelectorAll("a[href]").forEach(function(a) {
        var href = a.getAttribute("href") || "";
        if (/^\/(new|chat|recents)/.test(href) || href === "/") {
          a.style.setProperty("display", "none", "important");
        }
      });
    } catch (e) {}
  }

  // 自动点击 Code 按钮(只做一次)
  var codeClicked = false;
  function clickCodeButton() {
    if (codeClicked) return;
    try {
      var btn = document.querySelector('button[aria-label="Code"]');
      if (btn) { btn.click(); codeClicked = true; }
    } catch (e) {}
  }

  function tick() { hideChatButtons(); clickCodeButton(); }

  // MutationObserver:SPA 重渲染后持续隐藏
  function startObserver() {
    try {
      var target = document.documentElement || document.body;
      if (!target) return;
      var mo = new MutationObserver(function() { hideChatButtons(); });
      mo.observe(target, { childList: true, subtree: true });
    } catch (e) {}
  }

  // 首屏 + DOM 变化持续生效
  if (document.readyState !== "loading") { tick(); startObserver(); }
  else document.addEventListener("DOMContentLoaded", function(){ tick(); startObserver(); });
  // 延迟再跑一次(等 SPA 完全渲染)
  setTimeout(tick, 500);
  setTimeout(tick, 1500);
})();
</script>
<!--` + bcaiHideChatMarker + `-->`

// mitmIsClaudeAiHTMLDocument 判断该响应是否 claude.ai 的顶层 HTML 文档（可注入对象）。
// 只认 text/html；JSON/二进制/事件流一律否决。
func mitmIsClaudeAiHTMLDocument(resp *http.Response) bool {
	if resp == nil {
		return false
	}
	return strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "text/html")
}

// mitmInjectHideChat 读 HTML 文档、放开 CSP、注入守卫脚本、回填响应。
// 编码非 identity/gzip（如 brotli）无法解 → 原样透传不注入（Director 已删 Accept-Encoding，
// 正常应是明文）。注入失败/无锚点 → 原样写回，绝不破坏文档。
func mitmInjectHideChat(resp *http.Response) error {
	enc := strings.ToLower(strings.TrimSpace(resp.Header.Get("Content-Encoding")))
	if enc != "" && enc != "gzip" {
		return nil // 未知压缩，不动（避免写出乱码文档）
	}
	body, err := readMaybeGzip(resp)
	if err != nil {
		return nil
	}

	newBody, injected := injectHideChatHTML(body)
	if injected {
		// 注入即解开 CSP，否则内联 <script> 会被 claude.ai 的 CSP 拦掉。仅对本文档生效。
		stripCSPHeaders(resp.Header)
	}

	resp.Body = io.NopCloser(bytes.NewReader(newBody))
	resp.ContentLength = int64(len(newBody))
	resp.Header.Set("Content-Length", strconv.Itoa(len(newBody)))
	resp.Header.Del("Content-Encoding")
	return nil
}

// stripCSPHeaders 删除 CSP 响应头，放行注入的内联脚本/样式。
func stripCSPHeaders(h http.Header) {
	h.Del("Content-Security-Policy")
	h.Del("Content-Security-Policy-Report-Only")
}

// injectHideChatHTML 把守卫脚本插进 HTML 的 </head> 前（退而求其次：</body> 前 / 文首）。
// 已含标记则跳过（幂等）。非 HTML 文档（无 <head>/<html>）原样返回，不注入。
// 返回 (新文档, 是否注入)。纯函数，便于单测。
func injectHideChatHTML(body []byte) ([]byte, bool) {
	html := string(body)
	if strings.Contains(html, bcaiHideChatMarker) {
		return body, false // 已注入过
	}
	lower := strings.ToLower(html)
	if !strings.Contains(lower, "<head") && !strings.Contains(lower, "<html") {
		return body, false // 不像完整文档，不碰
	}
	// 删响应头 CSP 还不够：文档内 <meta http-equiv="Content-Security-Policy"> 同样会拦内联脚本，
	// 一并中和（把 http-equiv 值改成无意义值，标签变惰性）。
	html = neutralizeMetaCSP(html)
	if out, ok := insertBeforeTagCI(html, "</head>", bcaiHideChatSnippet); ok {
		return []byte(out), true
	}
	if out, ok := insertBeforeTagCI(html, "</body>", bcaiHideChatSnippet); ok {
		return []byte(out), true
	}
	// 兜底：插到文首（极少走到；CSS/JS 仍会执行）。
	return []byte(bcaiHideChatSnippet + html), true
}

// metaCSPRe 匹配文档内的 CSP meta 标签（含 -report-only 变体），只捕获 http-equiv 的值用于替换。
var metaCSPRe = regexp.MustCompile(`(?i)(<meta[^>]*http-equiv\s*=\s*["'])content-security-policy(?:-report-only)?(["'][^>]*>)`)

// neutralizeMetaCSP 把文档内的 CSP meta 标签改成惰性（http-equiv 值置为无意义），放行内联注入。
func neutralizeMetaCSP(html string) string {
	return metaCSPRe.ReplaceAllString(html, "${1}x-bcai-disabled-csp${2}")
}

// insertBeforeTagCI 在 tag（大小写不敏感）首次出现处之前插入 insertion。找不到返回 (原文, false)。
func insertBeforeTagCI(html, tag, insertion string) (string, bool) {
	idx := strings.Index(strings.ToLower(html), strings.ToLower(tag))
	if idx < 0 {
		return html, false
	}
	return html[:idx] + insertion + html[idx:], true
}
