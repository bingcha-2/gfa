package main

import (
	"embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/http"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Codex 远端接管品牌注入。
//
// 与 Cockpit 的 codex_app_injection 一样，这里只通过 Electron 的本机 CDP 端口向
// renderer 注入幂等 DOM/CSS，不修改 Codex.app/app.asar。Provider ID 仍为 bingchaai，
// 所以改显示名、头像和额度条不会改变历史会话分桶。

const (
	codexRemoteProviderName      = "冰茶 AI"
	codexAppInjectionInterval    = 30 * time.Second
	codexAppInjectionHTTPTimeout = 2 * time.Second
)

//go:embed assets/codex-remote-avatar.png
var codexRemoteAvatarFS embed.FS

var (
	codexRemoteAvatarOnce sync.Once
	codexRemoteAvatarURL  string

	codexAppInjectionMu   sync.Mutex
	codexAppInjectionStop chan struct{}
)

type codexAppLaunchPlan struct {
	Args                []string
	CDPPort             int
	Branding            bool
	ElectronUserDataDir string
}

type codexAppQuotaView struct {
	Weekly *int
}

type codexCDPTarget struct {
	Type         string `json:"type"`
	WebSocketURL string `json:"webSocketDebuggerUrl"`
}

type codexCDPEvaluation struct {
	Evaluated bool
	Avatar    bool
	Quota     bool
}

func codexRemoteAvatarDataURL() string {
	codexRemoteAvatarOnce.Do(func() {
		data, err := codexRemoteAvatarFS.ReadFile("assets/codex-remote-avatar.png")
		if err != nil {
			Log("[codex-ui] 读取内置头像失败: %v", err)
			return
		}
		codexRemoteAvatarURL = "data:image/png;base64," + base64.StdEncoding.EncodeToString(data)
	})
	return codexRemoteAvatarURL
}

func reserveCodexAppInjectionPort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port, nil
}

// buildCodexAppLaunchPlan 是纯决策层，便于回归测试。手动皮肤通道优先复用约定端口；
// 仅远端品牌注入时使用临时回环端口，避免长期占用一个可预测的 CDP 端口。
func buildCodexAppLaunchPlan(skinEnabled, brandingEnabled bool, reserve func() (int, error)) (codexAppLaunchPlan, error) {
	if !skinEnabled && !brandingEnabled {
		return codexAppLaunchPlan{}, nil
	}
	port := codexSkinChannelPort
	if !skinEnabled {
		var err error
		port, err = reserve()
		if err != nil {
			return codexAppLaunchPlan{}, err
		}
	}
	return codexAppLaunchPlan{
		Args: []string{
			"--remote-debugging-address=127.0.0.1",
			fmt.Sprintf("--remote-debugging-port=%d", port),
		},
		CDPPort:  port,
		Branding: brandingEnabled,
	}, nil
}

// withCodexWindowsInjectionProfile 对齐 Cockpit 的 Windows managed instance:
// Chromium/Electron 新版在默认 user-data-dir 下可能忽略 remote-debugging-port。
// 远程接管使用 GFA 独立的 Electron 缓存目录；CODEX_HOME 仍指向用户原目录，
// 所以聊天、插件和 config 不会被隔离，取消接管后默认 Electron 目录也完全不动。
func withCodexWindowsInjectionProfile(plan codexAppLaunchPlan, appDataDir string) codexAppLaunchPlan {
	if !plan.Branding || strings.TrimSpace(appDataDir) == "" {
		return plan
	}
	plan.ElectronUserDataDir = filepath.Join(appDataDir, "codex-remote-electron")
	return plan
}

func codexAppLaunchArgs(plan codexAppLaunchPlan) []string {
	args := append([]string(nil), plan.Args...)
	if plan.ElectronUserDataDir != "" {
		args = append(args, "--user-data-dir="+plan.ElectronUserDataDir)
	}
	return args
}

func codexUpsertEnv(base []string, key, value string) []string {
	out := make([]string, 0, len(base)+1)
	for _, item := range base {
		current, _, ok := strings.Cut(item, "=")
		if ok && strings.EqualFold(strings.TrimSpace(current), key) {
			continue
		}
		out = append(out, item)
	}
	return append(out, key+"="+value)
}

func codexAppLaunchEnvironment(plan codexAppLaunchPlan, base []string) []string {
	env := codexLaunchEnv(base)
	if plan.ElectronUserDataDir == "" {
		return env
	}
	env = codexUpsertEnv(env, "CODEX_HOME", codexHomeDir())
	env = codexUpsertEnv(env, "CODEX_ELECTRON_USER_DATA_PATH", plan.ElectronUserDataDir)
	return env
}

func prepareCodexAppLaunchPlan() codexAppLaunchPlan {
	brandingEnabled := currentCodexModelProvider() == codexProviderID
	plan, err := buildCodexAppLaunchPlan(
		codexSkinChannelEnabled(),
		brandingEnabled,
		reserveCodexAppInjectionPort,
	)
	if err != nil {
		// CDP 是视觉增强，失败不能阻断远端接管本身。
		Log("[codex-ui] 分配注入端口失败，跳过品牌界面注入: %v", err)
		return codexAppLaunchPlan{}
	}
	if runtime.GOOS == "windows" {
		plan = withCodexWindowsInjectionProfile(plan, getAppDataDir())
	}
	return plan
}

func stopCodexRemoteBrandingInjection() {
	codexAppInjectionMu.Lock()
	defer codexAppInjectionMu.Unlock()
	if codexAppInjectionStop != nil {
		close(codexAppInjectionStop)
		codexAppInjectionStop = nil
	}
}

func startCodexRemoteBrandingInjection(port int) {
	if port <= 0 {
		return
	}
	stopCodexRemoteBrandingInjection()
	stop := make(chan struct{})
	codexAppInjectionMu.Lock()
	codexAppInjectionStop = stop
	codexAppInjectionMu.Unlock()
	go runCodexRemoteBrandingInjection(port, stop)
}

func runCodexRemoteBrandingInjection(port int, stop <-chan struct{}) {
	ticker := time.NewTicker(codexAppInjectionInterval)
	defer ticker.Stop()
	client := &http.Client{Timeout: codexAppInjectionHTTPTimeout}
	startedAt := time.Now()
	var lastDiagnostic time.Time
	injectionReady := false
	lastRenderedAvatar := false
	lastRenderedQuota := false
	for {
		if currentCodexModelProvider() != codexProviderID {
			return
		}
		script := codexRemoteBrandingScript(currentCodexAppQuotaView())
		targets, queryErr := queryCodexCDPTargets(client, port)
		evaluated := 0
		renderedAvatar := false
		renderedQuota := false
		for _, target := range targets {
			if target.Type != "page" && target.Type != "webview" {
				continue
			}
			result := evaluateCodexCDPTarget(target.WebSocketURL, script)
			if result.Evaluated {
				evaluated++
			}
			renderedAvatar = renderedAvatar || result.Avatar
			renderedQuota = renderedQuota || result.Quota
		}
		if evaluated > 0 && (!injectionReady ||
			(renderedAvatar && !lastRenderedAvatar) ||
			(renderedQuota && !lastRenderedQuota)) {
			Log("[codex-ui] 界面注入已连接: cdp=%d targets=%d evaluated=%d avatar=%v quota=%v",
				port, len(targets), evaluated, renderedAvatar, renderedQuota)
			injectionReady = true
		} else if evaluated == 0 && time.Since(startedAt) >= 4*time.Second &&
			(lastDiagnostic.IsZero() || time.Since(lastDiagnostic) >= 15*time.Second) {
			Log("[codex-ui] 界面注入尚未就绪: cdp=%d targets=%d error=%v", port, len(targets), queryErr)
			lastDiagnostic = time.Now()
		}
		lastRenderedAvatar = lastRenderedAvatar || renderedAvatar
		lastRenderedQuota = lastRenderedQuota || renderedQuota
		select {
		case <-stop:
			return
		case <-ticker.C:
		}
	}
}

func queryCodexCDPTargets(client *http.Client, port int) ([]codexCDPTarget, error) {
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/json/list", port))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("CDP /json/list 返回 %d", resp.StatusCode)
	}
	var targets []codexCDPTarget
	if err := json.NewDecoder(resp.Body).Decode(&targets); err != nil {
		return nil, err
	}
	return targets, nil
}

func evaluateCodexCDPTarget(websocketURL, script string) codexCDPEvaluation {
	if strings.TrimSpace(websocketURL) == "" {
		return codexCDPEvaluation{}
	}
	dialer := websocket.Dialer{HandshakeTimeout: codexAppInjectionHTTPTimeout}
	conn, _, err := dialer.Dial(websocketURL, nil)
	if err != nil {
		return codexCDPEvaluation{}
	}
	defer conn.Close()
	deadline := time.Now().Add(codexAppInjectionHTTPTimeout)
	_ = conn.SetWriteDeadline(deadline)
	_ = conn.SetReadDeadline(deadline)
	message := map[string]interface{}{
		"id":     1,
		"method": "Runtime.evaluate",
		"params": map[string]interface{}{
			"expression":    script,
			"returnByValue": true,
			"awaitPromise":  false,
		},
	}
	if conn.WriteJSON(message) != nil {
		return codexCDPEvaluation{}
	}
	for {
		var response map[string]interface{}
		if conn.ReadJSON(&response) != nil {
			return codexCDPEvaluation{}
		}
		if id, ok := response["id"].(float64); ok && id == 1 {
			_, failed := response["error"]
			result := codexCDPEvaluation{Evaluated: !failed}
			outer, _ := response["result"].(map[string]interface{})
			inner, _ := outer["result"].(map[string]interface{})
			value, _ := inner["value"].(map[string]interface{})
			result.Avatar, _ = value["avatar"].(bool)
			result.Quota, _ = value["quota"].(bool)
			return result
		}
	}
}

func currentCodexAppQuotaView() codexAppQuotaView {
	// report-result 会在每次生成后立即更新运行时 accessKeyStatus；它必须优先于
	// heartbeat 落盘的 subscriptions。旧逻辑反过来优先 subscriptions，只要里面
	// 有周额度就永远读不到运行时新值，表现为“接管时注入一次后不再变化”。
	// 注入循环每 30s 调用本函数，因此运行时额度更新后无需重启 Codex。
	return codexAppQuotaViewFromSources(
		GetLeaser().GetStatus()["accessKeyStatus"],
		LoadConfig().Subscriptions,
	)
}

func codexAppQuotaViewFromSources(runtimeStatus interface{}, subscriptions []SubscriptionSnapshot) codexAppQuotaView {
	if view := codexAppQuotaViewFromAccessKeyStatus(runtimeStatus); view.Weekly != nil {
		return view
	}
	return codexAppQuotaViewFromSubscriptions(subscriptions)
}

func codexAppQuotaViewFromSubscriptions(subscriptions []SubscriptionSnapshot) codexAppQuotaView {
	subscriptions = append([]SubscriptionSnapshot(nil), subscriptions...)
	sort.SliceStable(subscriptions, func(i, j int) bool { return subscriptions[i].Priority < subscriptions[j].Priority })
	for _, subscription := range subscriptions {
		quota, ok := subscription.UsdQuotaByProduct["codex"]
		if !ok || quota.Weekly == nil {
			continue
		}
		return codexAppQuotaView{Weekly: remainingPercentFromQuotaWindow(quota.Weekly)}
	}
	return codexAppQuotaView{}
}

func codexAppQuotaViewFromAccessKeyStatus(raw interface{}) codexAppQuotaView {
	status, ok := raw.(map[string]interface{})
	if !ok {
		return codexAppQuotaView{}
	}
	products, ok := status["usdQuotaByProduct"].(map[string]interface{})
	if !ok {
		return codexAppQuotaView{}
	}
	quota, ok := parseSubscriptionUsdQuotaByProduct(products)["codex"]
	if !ok || quota.Weekly == nil {
		return codexAppQuotaView{}
	}
	return codexAppQuotaView{Weekly: remainingPercentFromQuotaWindow(quota.Weekly)}
}

func remainingPercentFromQuotaWindow(window *SubscriptionUsdQuotaWindow) *int {
	if window == nil {
		return nil
	}
	return quotaRemainingPercent(window.Used, window.Limit)
}

func quotaRemainingPercent(used, limit float64) *int {
	if math.IsNaN(limit) || math.IsInf(limit, 0) || limit < 0 {
		limit = 0
	}
	if math.IsNaN(used) || math.IsInf(used, 0) || used < 0 {
		used = 0
	}
	remaining := 100
	if limit > 0 {
		remaining = int((1-used/limit)*100 + 0.5)
	}
	if remaining < 0 {
		remaining = 0
	}
	if remaining > 100 {
		remaining = 100
	}
	return &remaining
}

func jsonScriptValue(value interface{}) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "null"
	}
	return string(encoded)
}

func codexRemoteBrandingScript(quota codexAppQuotaView) string {
	avatarURL := codexRemoteAvatarDataURL()
	template := `(() => {
  const brandName = __BRAND_NAME__;
  const avatarUrl = __AVATAR_URL__;
  const weeklyPercent = __WEEKLY__;
  const root = window.__BCAI_REMOTE_BRAND__ || (window.__BCAI_REMOTE_BRAND__ = {});
  root.brandName = brandName;
  root.avatarUrl = avatarUrl;
  root.weeklyPercent = weeklyPercent;

  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const normalized = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const compact = (value) => normalized(value).replace(/\s+/g, '');
  const brandKey = compact(brandName);
  const matchesBrand = (element) => {
    if (!element) return false;
    const values = [
      element.textContent,
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('title')
    ].map(compact).filter(Boolean);
    return values.some((value) => value === brandKey || value.startsWith(brandKey));
  };
  const findBrandTarget = () => Array.from(document.querySelectorAll('button,[role="button"]'))
    .filter((element) => visible(element) && matchesBrand(element))
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return br.bottom - ar.bottom || ar.left - br.left;
    })[0];

  const renderAvatar = () => {
    // v1 把 SVG 的父节点当成图标槽；某些 Codex 版本中该父节点就是整行按钮，
    // 结果头像被绝对定位到按钮中央。先清理旧标记，再让头像直接占用齿轮 SVG 的布局槽。
    if (root.avatarLayoutVersion !== 2) {
      document.querySelectorAll('[data-bcai-remote-avatar-host]').forEach((host) => {
        host.querySelectorAll('svg').forEach((icon) => { icon.style.visibility = ''; });
        if (host.style.position === 'relative') host.style.removeProperty('position');
        host.removeAttribute('data-bcai-remote-avatar-host');
      });
      document.querySelectorAll('[data-bcai-remote-avatar]').forEach((avatar) => avatar.remove());
      root.avatarLayoutVersion = 2;
    }
    const target = findBrandTarget();
    if (!target || !avatarUrl) return;
    let avatar = target.querySelector('[data-bcai-remote-avatar]');
    if (avatar) {
      if (avatar.src !== avatarUrl) avatar.src = avatarUrl;
      return;
    }
    const targetRect = target.getBoundingClientRect();
    const icons = Array.from(target.querySelectorAll('svg'))
      .filter(visible)
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    const icon = icons.find((item) => item.getBoundingClientRect().left < targetRect.left + targetRect.width / 2) || icons[0];
    avatar = document.createElement('img');
    avatar.setAttribute('data-bcai-remote-avatar', 'true');
    avatar.alt = '';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.src = avatarUrl;
    avatar.style.cssText = 'display:block;width:24px;height:24px;flex:0 0 24px;border-radius:999px;object-fit:cover;object-position:center;border:1px solid var(--color-token-border-subtle,rgba(127,127,127,.24));box-sizing:border-box;pointer-events:none;';
    if (icon) {
      icon.setAttribute('data-bcai-remote-avatar-icon', 'true');
      icon.style.display = 'none';
      icon.parentNode?.insertBefore(avatar, icon);
    } else {
      // Windows 新版侧栏的默认账号图标可能不是 SVG；没有图标槽时直接放到按钮首位。
      target.insertBefore(avatar, target.firstChild);
    }
  };

  const renderQuota = () => {
    let host = document.querySelector('[data-bcai-remote-quota]');
    const permissions = document.querySelector('[data-composer-navigation-target="permissions"]');
    const footer = permissions?.closest('._footer_1qb5a_2') || permissions?.parentElement?.parentElement?.parentElement;
    const brandTarget = findBrandTarget();
    if ((!footer || !permissions) && !brandTarget) {
      if (host) host.style.display = 'none';
      if (root.layoutObserver) root.layoutObserver.disconnect();
      root.layoutFooter = null;
      root.layoutPermissions = null;
      return;
    }
    if (!host) {
      host = document.createElement('div');
      host.setAttribute('data-bcai-remote-quota', 'true');
    }
    if (footer && permissions && host.parentElement !== document.body) document.body.appendChild(host);
    if (footer && permissions && 'ResizeObserver' in window) {
      if (!root.layoutObserver) root.layoutObserver = new ResizeObserver(() => root.scheduleRender());
      if (root.layoutFooter !== footer || root.layoutPermissions !== permissions) {
        root.layoutObserver.disconnect();
        root.layoutObserver.observe(footer);
        if (permissions !== footer) root.layoutObserver.observe(permissions);
        root.layoutFooter = footer;
        root.layoutPermissions = permissions;
      }
    }
    if (footer && permissions) {
      const footerRect = footer.getBoundingClientRect();
      const permissionsRect = permissions.getBoundingClientRect();
      host.style.cssText = 'position:fixed;transform:translate(-50%,-50%);z-index:2;display:flex;align-items:center;justify-content:center;gap:6px;color:var(--color-token-text-secondary,#737373);font-size:12px;line-height:1;white-space:nowrap;pointer-events:none;';
      host.style.left = Math.round(footerRect.left + footerRect.width / 2) + 'px';
      host.style.top = Math.round(permissionsRect.top + permissionsRect.height / 2) + 'px';
    } else if (brandTarget) {
      // 没打开 composer 或 Windows DOM 没有 permissions 锚点时，退回侧栏 provider 按钮。
      if (host.parentElement !== brandTarget) brandTarget.appendChild(host);
      host.style.cssText = 'position:static;transform:none;z-index:auto;display:flex;align-items:center;justify-content:flex-end;gap:6px;margin-left:auto;color:var(--color-token-text-secondary,#737373);font-size:12px;line-height:1;white-space:nowrap;pointer-events:none;';
      host.style.removeProperty('left');
      host.style.removeProperty('top');
    }
    const badgeStyle = 'display:inline-flex;align-items:center;gap:6px;height:24px;border:1px solid var(--color-token-border-subtle,rgba(127,127,127,.20));border-radius:999px;padding:0 9px;background:var(--color-token-main-surface-primary,rgba(127,127,127,.10));box-shadow:0 1px 2px rgba(0,0,0,.08);backdrop-filter:blur(8px);font-weight:500;';
    const fields = [];
    if (Number.isFinite(weeklyPercent)) fields.push('<span style="' + badgeStyle + '"><span style="width:6px;height:6px;border-radius:999px;background:#10b981;box-shadow:0 0 0 2px rgba(16,185,129,.14)"></span>本周 ' + Math.round(weeklyPercent) + '%</span>');
    const nextHtml = fields.join('');
    if (host.innerHTML !== nextHtml) host.innerHTML = nextHtml;
    host.style.display = fields.length ? 'flex' : 'none';
  };

  root.render = () => { renderAvatar(); renderQuota(); };
  root.scheduleRender = () => {
    if (root.renderScheduled) return;
    root.renderScheduled = true;
    requestAnimationFrame(() => { root.renderScheduled = false; root.render(); });
  };
  if (root.observerVersion !== 2) {
    if (root.observer) root.observer.disconnect();
    root.observer = null;
    root.observerVersion = 2;
  }
  if (!root.observer) {
    root.observer = new MutationObserver((mutations) => {
      const quotaHost = document.querySelector('[data-bcai-remote-quota]');
      if (quotaHost && mutations.every((mutation) => mutation.target === quotaHost || quotaHost.contains(mutation.target))) return;
      root.scheduleRender();
    });
    root.observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  if (!root.resizeHandler) {
    root.resizeHandler = () => root.scheduleRender();
    window.addEventListener('resize', root.resizeHandler, { passive: true });
  }
  root.render();
  return {
    installed: true,
    avatar: Boolean(document.querySelector('[data-bcai-remote-avatar]')),
    quota: Boolean(document.querySelector('[data-bcai-remote-quota]:not([style*="display: none"])'))
  };
})()`

	return strings.NewReplacer(
		"__BRAND_NAME__", jsonScriptValue(codexRemoteProviderName),
		"__AVATAR_URL__", jsonScriptValue(avatarURL),
		"__WEEKLY__", jsonScriptValue(quota.Weekly),
	).Replace(template)
}
