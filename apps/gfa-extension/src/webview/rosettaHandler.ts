/**
 * Rosetta message handler — processes rosetta:* messages from the Webview.
 * Maintains a polling loop that pushes updated state to the panel.
 */

import * as vscode from "vscode";
import { collectState, writeJsonFile, type RosettaState } from "./rosettaState.js";
import * as rosettaProcess from "./rosettaProcess.js";

// ─── Logging helper ─────────────────────────────────────────────────────
function log(msg: string): void {
  if (!outputChannel) return;
  const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  outputChannel.appendLine(`[${ts}] ${msg}`);
}

const REFRESH_INTERVAL_MS = 8000;

// ─── Operation status push (for loading indicators) ─────────────────────
function pushOperationStatus(op: string | null, status: string | null): void {
  if (!activeWebview) return;
  activeWebview.postMessage({
    type: "rosetta:operationStatus",
    payload: { operation: op, status },
  });
}

// ─── Auto-restart configuration ─────────────────────────────────────────
const AUTO_RESTART_MAX_ATTEMPTS = 3;
const AUTO_RESTART_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const AUTO_RESTART_COOLDOWN_MS = 5000; // wait 5s before restart attempt

let currentState: RosettaState | null = null;
let previousActiveEmail: string = "";
let previousTotalRequests: number = 0;
let previousProxyRunning: boolean = false;
let previousIdeConfigured: boolean = false;
let proxyLastSeenRunningAt: number = 0;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let activeWebview: vscode.Webview | null = null;
let extensionContext: vscode.ExtensionContext | null = null;
let outputChannel: vscode.OutputChannel | null = null;

// Auto-restart state
let autoRestartAttempts: { timestamp: number }[] = [];
let autoRestartInProgress = false;

// ─── Relay suppress flag ────────────────────────────────────────────────
// When the user explicitly turns relay OFF, we suppress autoRecoverTakeover
// from re-attaching IDE to the relay proxy for 30 seconds.
let relaySuppressAutoRecoverUntil = 0;

// ─── Relay Watchdog (续杯兜底看门狗) ───────────────────────────────────────
// After relay is turned ON, watches for 3 minutes. If no successful requests
// are made (or continuous errors), automatically falls back to takeover mode.
const RELAY_WATCHDOG_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
const RELAY_WATCHDOG_CHECK_INTERVAL_MS = 15 * 1000; // check every 15s
let relayWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
let relayWatchdogCheckTimer: ReturnType<typeof setInterval> | null = null;
let relayWatchdogBaselineRequests = 0; // relay totalRequests at watchdog start
let relayWatchdogBaselineErrors = 0;   // relay totalErrors at watchdog start
let relayWatchdogStartedAt = 0;

function startRelayWatchdog(): void {
  stopRelayWatchdog();
  relayWatchdogStartedAt = Date.now();
  relayWatchdogBaselineRequests = currentState?.relay.totalRequests || 0;
  relayWatchdogBaselineErrors = currentState?.relay.totalErrors || 0;
  log(`[续杯看门狗] 已启动 — 将在 ${RELAY_WATCHDOG_TIMEOUT_MS / 1000}s 内监测续杯健康状态`);
  log(`[续杯看门狗] 基线: requests=${relayWatchdogBaselineRequests} errors=${relayWatchdogBaselineErrors}`);

  // Periodic health checks every 15s
  relayWatchdogCheckTimer = setInterval(() => {
    if (!currentState?.relay.running) {
      log(`[续杯看门狗] 检测到续杯进程已停止，取消看门狗`);
      stopRelayWatchdog();
      return;
    }
    const elapsed = Math.round((Date.now() - relayWatchdogStartedAt) / 1000);
    const newRequests = (currentState?.relay.totalRequests || 0) - relayWatchdogBaselineRequests;
    const newErrors   = (currentState?.relay.totalErrors   || 0) - relayWatchdogBaselineErrors;
    log(`[续杯看门狗] ${elapsed}s elapsed | 新增请求: ${newRequests} 新增错误: ${newErrors}`);
  }, RELAY_WATCHDOG_CHECK_INTERVAL_MS);

  // Main timeout — if no new successful requests after 3min, fall back
  relayWatchdogTimer = setTimeout(async () => {
    stopRelayWatchdog();
    if (!extensionContext || !outputChannel) return;
    const state = await collectState(extensionContext, outputChannel);
    if (!state.relay.running) {
      log(`[续杯看门狗] ⏰ 超时但续杯已停止，无需兜底`);
      return;
    }
    const newRequests = state.relay.totalRequests - relayWatchdogBaselineRequests;
    const newErrors   = state.relay.totalErrors   - relayWatchdogBaselineErrors;
    const successRate = newRequests > 0 ? ((newRequests - newErrors) / newRequests * 100).toFixed(0) : 0;
    log(`[续杯看门狗] ⏰ 3分钟到期检查: 新增请求=${newRequests} 新增错误=${newErrors} 成功率=${successRate}%`);

    // If 0 successful requests in 3 minutes, fall back to takeover
    const hasSuccessfulRequests = newRequests > 0 && (newRequests - newErrors) > 0;
    if (!hasSuccessfulRequests) {
      log(`[续杯看门狗] ⚠️ 3分钟内续杯无有效响应，自动切回一键接管模式...`);
      void fallbackToTakeover(
        newRequests === 0
          ? `临时续杯 3 分钟内未收到任何请求，已自动切回一键接管。`
          : `临时续杯连续报错（${newErrors}/${newRequests} 次失败），已自动切回一键接管。`
      );
    } else {
      log(`[续杯看门狗] ✅ 续杯运行正常，成功率 ${successRate}%，无需兜底`);
    }
  }, RELAY_WATCHDOG_TIMEOUT_MS);
}

function stopRelayWatchdog(): void {
  if (relayWatchdogTimer) {
    clearTimeout(relayWatchdogTimer);
    relayWatchdogTimer = null;
  }
  if (relayWatchdogCheckTimer) {
    clearInterval(relayWatchdogCheckTimer);
    relayWatchdogCheckTimer = null;
  }
  if (relayWatchdogStartedAt > 0) {
    log(`[续杯看门狗] 已取消`);
    relayWatchdogStartedAt = 0;
  }
}

/**
 * Fallback: stop relay, start takeover proxy on the same port, notify user.
 * Since relay and token proxy share port 60670, no cloudCodeUrl changes needed.
 */
async function fallbackToTakeover(reason: string): Promise<void> {
  if (!extensionContext || !outputChannel) return;
  log(`[续杯兜底] 开始切回一键接管 — 原因: ${reason}`);

  try {
    const state = await collectState(extensionContext, outputChannel);
    if (!state.ready) {
      log(`[续杯兜底] state not ready, abort`);
      return;
    }

    // Step 1: Stop relay proxy (frees port 60670)
    log(`[续杯兜底] Step 1: 停止续杯代理...`);
    try { await rosettaProcess.stopRelayProxy(state); } catch (e: any) { log(`[续杯兜底] stopRelayProxy err: ${e.message}`); }
    await new Promise(r => setTimeout(r, 1500));

    // Step 2: Start token proxy on the same port
    log(`[续杯兜底] Step 2: 启动 Token Proxy...`);
    const freshState = await collectState(extensionContext, outputChannel);
    if (!freshState.proxy.running) {
      try { await rosettaProcess.startProxy(freshState); } catch (e: any) { log(`[续杯兜底] startProxy err: ${e.message}`); }
      await new Promise(r => setTimeout(r, 2000));
    }

    // Step 3: Ensure IDE is attached to token proxy
    log(`[续杯兜底] Step 3: 确保 IDE 接管...`);
    const state3 = await collectState(extensionContext, outputChannel);
    if (state3.proxy.running && !state3.ide.isConfigured) {
      try { await rosettaProcess.attachIde(state3); } catch (e: any) { log(`[续杯兜底] attachIde err: ${e.message}`); }
    }

    await new Promise(r => setTimeout(r, 1000));
    await refreshAndPush(true);
    const verify = currentState;
    log(`[续杯兜底] 完成: proxy.running=${verify?.proxy.running} ide.isConfigured=${verify?.ide.isConfigured}`);

    // Notify user — no reload needed since port didn't change
    vscode.window.showWarningMessage(`⚠️ ${reason}`);
  } catch (err: any) {
    log(`[续杯兜底] 异常: ${err.message}`);
  }
}

export function initRosettaHandler(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel
): void {
  extensionContext = context;
  outputChannel = channel;

  // Wire up the process module's diagnostic logging to the same output channel
  rosettaProcess.setOutputChannel(channel);

  // Auto-recover: if proxy was left running from a previous session, auto-attach IDE
  setTimeout(() => void autoRecoverTakeover(), 3000);
}

/**
 * Startup auto-recovery: detect a running proxy from a previous IDE session
 * and automatically re-attach the IDE so AI works immediately.
 */
async function autoRecoverTakeover(): Promise<void> {
  if (!extensionContext || !outputChannel) return;
  try {
    const state = await collectState(extensionContext, outputChannel);
    if (!state.ready) return;

    // If relay proxy is running, don't auto-attach IDE to token proxy
    // — the user is in "续杯" mode, shouldn't be hijacked
    if (state.relay.running) {
      log(`[自动恢复] Relay 代理运行中，跳过自动接管`);
      // Check suppress flag — if user just turned relay off, don't re-attach
      if (Date.now() < relaySuppressAutoRecoverUntil) {
        log(`[自动恢复] ⚠️ relay suppress 生效中(距解除还有 ${Math.round((relaySuppressAutoRecoverUntil - Date.now()) / 1000)}s)，跳过自动指向续杯`);
        return;
      }
      // Only re-attach to relay if IDE was ALREADY pointing to relay
      // (i.e., user had relay active before IDE restart). Don't auto-attach
      // just because process is running — it could be an orphan.
      const ideAlreadyPointsToRelay = state.ide.configuredUrl === state.relay.url;
      if (ideAlreadyPointsToRelay) {
        log(`[自动恢复] IDE 已指向续杯代理，无需操作`);
      } else if (!state.ide.isConfigured) {
        // IDE has no config at all — check if configuredUrl was cleared
        // but relay is legitimately running. Don't auto-attach to relay
        // since the user may have deliberately turned it off.
        log(`[自动恢复] IDE 未配置且续杯进程在运行，但不自动指向续杯（需用户手动开启）`);
      }
      return;
    }

    if (state.proxy.running && !state.ide.isConfigured) {
      log(`[自动恢复] 检测到代理运行中但 IDE 未接管，正在自动接管...`);
      await rosettaProcess.attachIde(state);
      log(`[自动恢复] ✅ IDE 已自动接管代理`);
      vscode.window.showInformationMessage("检测到代理运行中，已自动接管。");
      void refreshAndPush(true);
    } else if (state.proxy.running && state.ide.isConfigured) {
      log(`[自动恢复] 代理运行中且 IDE 已接管，无需操作`);
    }
  } catch (err: any) {
    log(`[自动恢复] 检测失败: ${err.message}`);
  }
}

export function setRosettaWebview(webview: vscode.Webview | null): void {
  activeWebview = webview;

  // Start/stop polling based on whether we have an active webview
  if (webview && !refreshTimer) {
    refreshTimer = setInterval(() => {
      void refreshAndPush(true);
    }, REFRESH_INTERVAL_MS);
    // Initial push
    void refreshAndPush(true);
  } else if (webview && refreshTimer) {
    // Webview was re-created (e.g. panel hidden then shown again)
    // Push current state immediately so the new webview doesn't hang on "正在连接…"
    void refreshAndPush(true);
  }

  if (!webview && refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

async function refreshAndPush(silent = true): Promise<void> {
  if (!extensionContext || !outputChannel) return;
  try {
    currentState = await collectState(extensionContext, outputChannel);
    const nowRunning = currentState.proxy.running;
    const nowIdeConfigured = currentState.ide.isConfigured;

    // ─── Detect proxy status transitions ────────────────────────────
    if (previousProxyRunning && !nowRunning) {
      // Proxy went from running → offline
      const downDuration = proxyLastSeenRunningAt
        ? `${Math.round((Date.now() - proxyLastSeenRunningAt) / 1000)}s ago`
        : "unknown";
      log(`[🔴 代理离线] 代理从运行变为离线！上次在线: ${downDuration}`);
      if (nowIdeConfigured && !currentState.relay.running) {
        log(`[🔴 代理离线] IDE 仍指向代理地址 — 会话将中断！`);
        // Trigger auto-restart if in takeover mode (not relay mode)
        void attemptAutoRestart();
      } else if (currentState.relay.running) {
        log(`[🔴 代理离线] 续杯模式中，跳过自动重启`);
      }
    } else if (!previousProxyRunning && nowRunning) {
      // Proxy came back online
      log(`[🟢 代理上线] 代理已恢复运行`);
      autoRestartInProgress = false;
    }

    if (previousIdeConfigured && !nowIdeConfigured) {
      log(`[⚠️ IDE 断开] IDE 代理配置被清除 — 会话已断开`);
    } else if (!previousIdeConfigured && nowIdeConfigured) {
      log(`[🟢 IDE 接管] IDE 已配置代理地址: ${currentState.ide.configuredUrl}`);
    }

    previousProxyRunning = nowRunning;
    previousIdeConfigured = nowIdeConfigured;

    // Log active account info on each refresh
    if (currentState.proxy.running) {
      proxyLastSeenRunningAt = Date.now();
      const active = currentState.accounts.find(a => a.isActive);
      const activeEmail = active?.email || currentState.proxy.activeEmail || "(无)";
      const deltaReqs = currentState.proxy.totalRequests - previousTotalRequests;

      // Detect unexpected active account change (possible session interruption)
      if (previousActiveEmail && activeEmail !== previousActiveEmail && activeEmail !== "(无)") {
        log(`[⚠️ 账号切换] 活跃账号从 ${previousActiveEmail} 变为 ${activeEmail}（可能因额度耗尽或错误自动轮换）`);
      }

      // Log account health summary (with quota details for debugging)
      const enabledCount = currentState.accounts.filter(a => a.enabled).length;
      const noProjectCount = currentState.accounts.filter(a => a.enabled && !a.projectId).length;
      const blockedCount = currentState.accounts.filter(a => a.enabled && a.quotaLiveBlockedCount > 0).length;
      const exhaustedEmails = currentState.accounts
        .filter(a => a.enabled && a.quotaLiveBlockedCount > 0)
        .map(a => `${a.email.split('@')[0]}(${a.quotaLiveBlockedCount}blocked)`)
        .join(', ');
      log(`[状态刷新] 代理运行中 | 活跃: ${activeEmail} | 请求: ${currentState.proxy.totalRequests}(+${deltaReqs}) | 轮换: ${currentState.proxy.totalRotations} | 可用: ${currentState.proxy.rotatableAccounts}/${currentState.proxy.totalAccounts} | 启用: ${enabledCount} | 无项目号: ${noProjectCount} | 受限: ${blockedCount}${exhaustedEmails ? ` [${exhaustedEmails}]` : ''}`);

      // Detect when ALL accounts are exhausted — imminent session interruption
      if (enabledCount > 0 && currentState.proxy.rotatableAccounts === 0) {
        log(`[🚨 全部耗尽] 所有启用的账号均无法使用！新请求将失败`);
      } else if (blockedCount > 0 && blockedCount >= enabledCount - noProjectCount) {
        log(`[⚠️ 额度告警] 所有有项目号的账号均受限，请求可能失败`);
      }

      previousActiveEmail = activeEmail;
      previousTotalRequests = currentState.proxy.totalRequests;
    }
    if (activeWebview) {
      await activeWebview.postMessage({
        type: "rosetta:state",
        payload: currentState,
      });
    }
  } catch (error: any) {
    log(`[状态刷新] 出错: ${error.message}${error.stack ? '\n' + error.stack : ''}`);
    if (!silent) {
      vscode.window.showErrorMessage(`Rosetta: ${error.message}`);
    }
  }
}

// ─── Auto-restart logic ─────────────────────────────────────────────────

async function attemptAutoRestart(): Promise<void> {
  if (autoRestartInProgress || !extensionContext || !outputChannel) return;

  // Clean up old attempts outside the window
  const now = Date.now();
  autoRestartAttempts = autoRestartAttempts.filter(
    a => now - a.timestamp < AUTO_RESTART_WINDOW_MS
  );

  if (autoRestartAttempts.length >= AUTO_RESTART_MAX_ATTEMPTS) {
    log(`[自动重启] 已达到最大重试次数 (${AUTO_RESTART_MAX_ATTEMPTS}次/${AUTO_RESTART_WINDOW_MS / 60000}分钟内)，放弃自动重启`);
    vscode.window.showWarningMessage(
      `代理频繁崩溃（${AUTO_RESTART_WINDOW_MS / 60000}分钟内已重启${AUTO_RESTART_MAX_ATTEMPTS}次），请手动检查日志。`
    );
    return;
  }

  autoRestartInProgress = true;
  autoRestartAttempts.push({ timestamp: now });
  const attemptNum = autoRestartAttempts.length;

  log(`[自动重启] 检测到代理离线，正在尝试自动重启... (第${attemptNum}次)`);
  vscode.window.showWarningMessage(`代理已离线，正在自动重启... (第${attemptNum}次)`);

  // Wait a bit before restarting to avoid port conflicts
  await new Promise(r => setTimeout(r, AUTO_RESTART_COOLDOWN_MS));

  try {
    // Re-collect state to get fresh paths
    const freshState = await collectState(extensionContext, outputChannel);
    if (freshState.proxy.running) {
      log(`[自动重启] 代理已自行恢复，无需重启`);
      autoRestartInProgress = false;
      return;
    }

    if (!freshState.ready) {
      log(`[自动重启] Rosetta 目录不可用，无法重启: ${freshState.problem}`);
      autoRestartInProgress = false;
      return;
    }

    // Import and call startProxy
    const rosettaProcess = await import("./rosettaProcess.js");
    await rosettaProcess.startProxy(freshState);
    log(`[自动重启] 代理已重新启动`);

    // Verify it's actually running
    await new Promise(r => setTimeout(r, 2000));
    await refreshAndPush(true);

    if (currentState?.proxy.running) {
      log(`[自动重启] ✅ 代理重启成功，会话已恢复`);
      vscode.window.showInformationMessage(`代理已自动重启成功。`);
    } else {
      log(`[自动重启] ❌ 代理重启后仍未运行`);
    }
  } catch (err: any) {
    log(`[自动重启] 重启失败: ${err.message}${err.stack ? '\n' + err.stack : ''}`);
  } finally {
    autoRestartInProgress = false;
  }
}

function getState(): RosettaState {
  if (!currentState || !currentState.ready) {
    throw new Error(currentState?.problem || "Rosetta 代理目录不可用。");
  }
  return currentState;
}

/**
 * Handle an incoming Rosetta message from the webview.
 */
export async function handleRosettaMessage(
  message: { type: string; payload?: any },
  webview: vscode.Webview,
  context: vscode.ExtensionContext
): Promise<void> {
  const type = message.type;

  try {
    switch (type) {
      case "rosetta:getState":
      case "rosetta:refresh": {
        await refreshAndPush(false);
        return;
      }

      case "rosetta:toggleProxy": {
        const state = getState();
        if (state.proxy.running) {
          log(`[操作] 正在停止代理... 当前活跃: ${state.proxy.activeEmail || "(无)"}, 总请求: ${state.proxy.totalRequests}`);
          await rosettaProcess.stopProxy(state);
          log(`[操作] 代理已停止`);
        } else {
          const enabledAccounts = state.accounts.filter(a => a.enabled);
          const withProject = enabledAccounts.filter(a => a.projectId);
          log(`[操作] 正在启动代理... 共 ${enabledAccounts.length} 个启用账号, ${withProject.length} 个有项目号`);
          await rosettaProcess.startProxy(state);
          log(`[操作] 代理已启动`);
        }
        await refreshAndPush();
        return;
      }

      case "rosetta:toggleIde": {
        const state = getState();
        if (state.ide.isConfigured) {
          await rosettaProcess.clearIde(state);
        } else {
          await rosettaProcess.attachIde(state);
        }
        await refreshAndPush();
        return;
      }

      case "rosetta:toggleTakeover": {
        const state = getState();
        // Check if IDE is pointed at the TOKEN proxy (not relay)
        const idePointsToProxy = state.ide.configuredUrl === state.proxy.url;
        const isTakeoverOn = state.proxy.running && idePointsToProxy && !state.relay.running;
        log(`[一键接管-TOGGLE] ▶ 收到 toggleTakeover | proxy.running=${state.proxy.running} idePointsToProxy=${idePointsToProxy} isTakeoverOn=${isTakeoverOn}`);
        log(`[一键接管-TOGGLE] ide.configuredUrl=${state.ide.configuredUrl || '(empty)'} proxy.url=${state.proxy.url} relay.url=${state.relay.url}`);

        if (isTakeoverOn) {
          // Turn off: clear IDE first, then stop proxy
          log(`[一键接管-OFF] ▶ 开始关闭接管...`);
          pushOperationStatus("takeover", "stopping");

          // Step 1: Clear IDE config
          log(`[一键接管-OFF] Step 1: 清除 IDE 配置...`);
          try {
            await rosettaProcess.clearIde(state);
            log(`[一键接管-OFF] Step 1: ✅ clearIde 完成`);
          } catch (err: any) {
            log(`[一键接管-OFF] Step 1: ❌ clearIde 异常: ${err.message}`);
          }
          // Verify IDE cleared
          await refreshAndPush(true);
          log(`[一键接管-OFF] Step 1 验证: ide.configuredUrl=${currentState?.ide.configuredUrl || '(empty)'} ide.isConfigured=${currentState?.ide.isConfigured}`);

          // Step 2: Stop proxy
          log(`[一键接管-OFF] Step 2: 停止代理...`);
          try {
            await rosettaProcess.stopProxy(state);
            log(`[一键接管-OFF] Step 2: ✅ stopProxy 完成`);
          } catch (err: any) {
            log(`[一键接管-OFF] Step 2: ❌ stopProxy 异常: ${err.message}`);
          }

          // Wait for OS to fully release ports (avoid EADDRINUSE on next start)
          log(`[一键接管-OFF] 等待端口释放 (1.5s)...`);
          await new Promise((r) => setTimeout(r, 1500));

          // Step 3: Final verify
          await refreshAndPush(true);
          log(`[一键接管-OFF] Step 3 最终验证: proxy.running=${currentState?.proxy.running} ide.isConfigured=${currentState?.ide.isConfigured} ide.configuredUrl=${currentState?.ide.configuredUrl || '(empty)'}`);
          // NOTE: Do NOT auto-redirect IDE to relay here.
          // If user wants relay, they should explicitly toggle it on.
          log(`[一键接管-OFF] ✅ 关闭流程完成`);
        } else {
          // Turn on: stop relay first if running (mutual exclusion), then start proxy
          log(`[一键接管-ON] ▶ 开始开启接管...`);
          pushOperationStatus("takeover", "starting");

          // Mutual exclusion: stop relay proxy if active (shares same port)
          if (state.relay.running) {
            log(`[一键接管-ON] 续杯代理运行中，先关闭...`);
            stopRelayWatchdog();
            await rosettaProcess.stopRelayProxy(state);
            log(`[takeover:on] relay stop: waiting 1500ms for port release`);
            await new Promise((r) => setTimeout(r, 1500));
            try {
              const postWaitState = await collectState(extensionContext!, outputChannel!);
              log(`[takeover:on] relay stop post-wait state: proxy.running=${postWaitState.proxy.running} relay.running=${postWaitState.relay.running} relay.status=${postWaitState.relay.statusUrl || "(empty)"}`);
            } catch (collectErr: any) {
              log(`[takeover:on] relay stop post-wait collect failed: ${collectErr?.message || String(collectErr)}`);
            }
            log(`[一键接管-ON] 续杯代理已关闭`);
          }

          let proxyStartError: string | null = null;
          if (!state.proxy.running) {
            log(`[一键接管-ON] 启动 Token Proxy ...`);
            try {
              await rosettaProcess.startProxy(state);
              log(`[一键接管-ON] startProxy() 返回`);
            } catch (err: any) {
              proxyStartError = err.message || String(err);
              log(`[一键接管-ON] startProxy 异常: ${proxyStartError}（将检查代理是否实际运行）`);
            }
            // Wait for proxy to fully initialize
            log(`[一键接管-ON] 等待代理初始化 (2s)...`);
            await new Promise((r) => setTimeout(r, 2000));
          } else {
            log(`[一键接管-ON] Token Proxy 已在运行，跳过启动`);
          }
          // Re-collect REAL state (not stale cache) after proxy start
          await refreshAndPush(true);
          const freshState = currentState;
          log(`[一键接管-ON] 刷新后状态: proxy.running=${freshState?.proxy.running} ide.configuredUrl=${freshState?.ide.configuredUrl || '(empty)'}`);
          if (freshState) {
            log(`[一键接管-ON] 강制刷新 IDE 连接（先清除再重连）...`);
            await rosettaProcess.clearIde(freshState);
            log(`[一键接管-ON] clearIde 完成，等待 2s...`);
            await new Promise((r) => setTimeout(r, 2000));
            await rosettaProcess.attachIde(freshState);
            log(`[一键接管-ON] IDE 已写入代理地址: ${freshState.proxy.url}`);
          } else {
            log(`[一键接管-ON] ⚠️ freshState 为空，跳过 IDE 绑定`);
          }
          if (proxyStartError && !(freshState?.proxy.running)) {
            log(`[一键接管-ON] ❌ 代理启动失败: ${proxyStartError}`);
            vscode.window.showErrorMessage(`代理启动异常: ${proxyStartError}`);
          }
          log(`[一键接管-ON] 等待 IDE 稳定 (3s)...`);
          await new Promise((r) => setTimeout(r, 3000));
          await refreshAndPush(true);
          const verifyState = currentState;
          log(`[一键接管-ON] 最终验证: proxy.running=${verifyState?.proxy.running} ide.isConfigured=${verifyState?.ide.isConfigured} ide.configuredUrl=${verifyState?.ide.configuredUrl || '(empty)'}`);
          if (verifyState?.proxy.running && verifyState?.ide.isConfigured) {
            log(`[一键接管-ON] ✅ 已开启，代理运行中，IDE 已配置`);
          } else {
            log(`[一键接管-ON] ⚠️ 开启完成但状态异常: proxy=${verifyState?.proxy.running} ide=${verifyState?.ide.isConfigured}`);
            const action = await vscode.window.showWarningMessage(
              "接管已开启，但 AI 可能需要重载窗口才能生效。",
              "重载窗口",
              "忽略"
            );
            if (action === "重载窗口") {
              await vscode.commands.executeCommand("workbench.action.reloadWindow");
            }
          }
          log(`[一键接管-ON] ✅ 流程完成`);
        }
        pushOperationStatus(null, null);
        await refreshAndPush();
        return;
      }

      case "rosetta:ensureIde": {
        const state = getState();
        if (!state.ide.isConfigured) {
          await rosettaProcess.attachIde(state);
          await refreshAndPush();
        }
        return;
      }

      case "rosetta:toggleReverse": {
        const state = getState();
        if (state.reverseProxy.running) {
          await rosettaProcess.stopReverseProxy(state);
        } else {
          await rosettaProcess.startReverseProxy(state);
        }
        await refreshAndPush();
        return;
      }

      case "rosetta:toggleRelay": {
        const state = getState();
        // Relay proxy now shares the token proxy port (60670).
        // "Active" simply means the relay status endpoint reports running.
        const isRelayActive = state.relay.running;
        log(`[relay:toggle] begin at ${new Date().toISOString()}`);
        log(`[relay:toggle] snapshot ready=${state.ready} problem=${state.problem || "(none)"}`);
        log(`[relay:toggle] paths root=${state.workspace?.rootPath || "(empty)"}`);
        log(`[relay:toggle] paths tokenScript=${state.workspace?.paths?.startScriptPath || "(empty)"}`);
        log(`[relay:toggle] paths relayScript=${state.workspace?.paths?.relayProxyScriptPath || "(empty)"}`);
        log(`[relay:toggle] config tokenProxyPort=${state.config?.tokenProxyPort || 60670} relayPort=${state.config?.relayProxy?.port || 60680}`);
        log(`[relay:toggle] proxy running=${state.proxy.running} url=${state.proxy.url} statusUrl=${state.proxy.statusUrl || "(empty)"} requests=${state.proxy.totalRequests}`);
        log(`[relay:toggle] relay running=${state.relay.running} url=${state.relay.url} statusUrl=${state.relay.statusUrl || "(empty)"} hasApiKey=${state.relay.hasApiKey} upstream=${state.relay.upstream || "(empty)"}`);
        log(`[relay:toggle] ide configuredUrl=${state.ide.configuredUrl || "(empty)"} expected=${state.ide.expectedUrl || "(empty)"} isConfigured=${state.ide.isConfigured}`);
        log(`[续杯-TOGGLE] ▶ 收到 toggleRelay 消息`);
        log(`[续杯-TOGGLE] relay.running=${state.relay.running} proxy.running=${state.proxy.running} ide.configuredUrl=${state.ide.configuredUrl || '(empty)'}`);

        if (isRelayActive) {
          // ─── Turn OFF relay ───────────────────────────────────
          log(`[续杯-OFF] ▶ 开始关闭续杯代理`);
          pushOperationStatus("relay", "stopping");

          // Cancel watchdog immediately when user turns relay OFF
          stopRelayWatchdog();
          log(`[续杯-OFF] 看门狗已取消`);

          // Set suppress flag to prevent autoRecover from re-attaching
          relaySuppressAutoRecoverUntil = Date.now() + 30_000;
          log(`[续杯-OFF] 已设置 relaySuppressAutoRecover (30s)`);

          // Step 1: Stop relay proxy process (frees port 60670)
          log(`[续杯-OFF] Step 1: 停止续杯代理进程...`);
          try {
            await rosettaProcess.stopRelayProxy(state);
            log(`[续杯-OFF] Step 1: ✅ stopRelayProxy 完成`);
          } catch (err: any) {
            log(`[续杯-OFF] Step 1: ❌ stopRelayProxy 失败: ${err.message}`);
          }

          // Wait for port to fully release
          await new Promise((r) => setTimeout(r, 1500));

          // Step 2: Verify relay is stopped
          await refreshAndPush(true);
          const afterState = currentState;
          log(`[续杯-OFF] Step 2 验证: relay.running=${afterState?.relay.running}`);

          if (afterState?.relay.running) {
            log(`[续杯-OFF] ⚠️ 续杯代理仍在运行！尝试再次强制停止...`);
            try {
              await rosettaProcess.stopRelayProxy(afterState);
              await new Promise((r) => setTimeout(r, 2000));
              await refreshAndPush(true);
              log(`[续杯-OFF] 强制停止后: relay.running=${currentState?.relay.running}`);
            } catch (err: any) {
              log(`[续杯-OFF] 强制停止异常: ${err.message}`);
            }
          }

          // Step 3: Start token proxy back on the same port
          log(`[续杯-OFF] Step 3: 启动 Token Proxy...`);
          const freshState3 = await collectState(extensionContext!, outputChannel!);
          if (!freshState3.proxy.running) {
            try {
              await rosettaProcess.startProxy(freshState3);
              log(`[续杯-OFF] Step 3: ✅ Token Proxy 已启动`);
            } catch (err: any) {
              log(`[续杯-OFF] Step 3: ❌ startProxy 失败: ${err.message}`);
            }
            await new Promise((r) => setTimeout(r, 2000));
          } else {
            log(`[续杯-OFF] Step 3: Token Proxy 已在运行，跳过`);
          }

          // Step 4: Ensure IDE is attached (cloudCodeUrl → 60670)
          const freshState4 = await collectState(extensionContext!, outputChannel!);
          if (freshState4.proxy.running && !freshState4.ide.isConfigured) {
            try {
              await rosettaProcess.attachIde(freshState4);
              log(`[续杯-OFF] Step 4: ✅ IDE 已接管 Token Proxy`);
            } catch (err: any) {
              log(`[续杯-OFF] Step 4: ❌ attachIde 失败: ${err.message}`);
            }
          }

          await refreshAndPush(true);
          log(`[续杯-OFF] ✅ 关闭流程完成 — proxy.running=${currentState?.proxy.running} relay.running=${currentState?.relay.running}`);
        } else {
          // ─── Turn ON relay ────────────────────────────────────
          // Clear suppress flag since user is turning ON
          relaySuppressAutoRecoverUntil = 0;

          if (!state.relay.hasApiKey) {
            log(`[relay:on] abort: missing relay api key. relayProxy keys=${JSON.stringify(Object.keys(state.config?.relayProxy || {}))}`);
            log(`[续杯-ON] ❌ 未配置 API Key，中止`);
            vscode.window.showWarningMessage("请先配置续杯 API Key（点击「设置卡密」按钮）。");
            return;
          }

          log(`[续杯-ON] ▶ 开始开启续杯代理`);
          pushOperationStatus("relay", "starting");
          log(`[续杯-ON] 当前状态: proxy.running=${state.proxy.running} ide.configuredUrl=${state.ide.configuredUrl || '(empty)'}`);

          // Step 1: Stop token proxy (free port 60670)
          if (state.proxy.running) {
            log(`[relay:on] Step 1 stop token proxy: before proxy.running=${state.proxy.running} statusUrl=${state.proxy.statusUrl}`);
            log(`[续杯-ON] Step 1: 停止 Token Proxy 以释放端口...`);
            try {
              await rosettaProcess.stopProxy(state);
              const afterStopState = await collectState(extensionContext!, outputChannel!);
              log(`[relay:on] Step 1 stop token proxy: after proxy.running=${afterStopState.proxy.running} relay.running=${afterStopState.relay.running} ide=${afterStopState.ide.configuredUrl || "(empty)"}`);
              log(`[续杯-ON] Step 1: ✅ Token Proxy 已停止`);
            } catch (err: any) {
              log(`[续杯-ON] Step 1: ❌ stopProxy 失败: ${err.message}`);
            }
            await new Promise((r) => setTimeout(r, 1500));
          } else {
            log(`[续杯-ON] Step 1: Token Proxy 未运行，跳过`);
          }

          try {
            const afterTokenStopStep = await collectState(extensionContext!, outputChannel!);
            log(`[relay:on] Step 1 final state before orphan cleanup: proxy.running=${afterTokenStopStep.proxy.running} relay.running=${afterTokenStopStep.relay.running} ide=${afterTokenStopStep.ide.configuredUrl || "(empty)"}`);
          } catch (collectErr: any) {
            log(`[relay:on] Step 1 final collect failed: ${collectErr?.message || String(collectErr)}`);
          }

          // Stop orphan relay process if one exists
          if (state.relay.running) {
            log(`[续杯-ON] 检测到残留续杯进程，先停止...`);
            try {
              await rosettaProcess.stopRelayProxy(state);
              await new Promise((r) => setTimeout(r, 1000));
              log(`[续杯-ON] 残留进程已清理`);
            } catch (err: any) {
              log(`[续杯-ON] 停止残留进程失败: ${err.message}`);
            }
          }

          // Step 2: Start relay proxy on port 60670
          log(`[relay:on] Step 2 start relay: using relayScript=${state.workspace.paths.relayProxyScriptPath}`);
          log(`[续杯-ON] Step 2: 启动续杯代理（共享端口 60670）...`);
          try {
            await rosettaProcess.startRelayProxy(state);
            const afterRelayStart = await collectState(extensionContext!, outputChannel!);
            log(`[relay:on] Step 2 start relay: after relay.running=${afterRelayStart.relay.running} proxy.running=${afterRelayStart.proxy.running} relay.lastError=${afterRelayStart.relay.lastError || "(none)"} relay.requests=${afterRelayStart.relay.totalRequests}`);
            log(`[续杯-ON] Step 2: ✅ startRelayProxy() 返回成功`);
          } catch (err: any) {
            log(`[续杯-ON] Step 2: ❌ startRelayProxy() 失败: ${err.message}`);
            log(`[relay:on] Step 2 start relay ERROR: ${err?.message || String(err)}`);
            if (err?.stack) log(`[relay:on] Step 2 start relay stack:\n${err.stack}`);
            try {
              const failedRelayState = await collectState(extensionContext!, outputChannel!);
              log(`[relay:on] Step 2 failed state: proxy.running=${failedRelayState.proxy.running} relay.running=${failedRelayState.relay.running} relay.lastError=${failedRelayState.relay.lastError || "(none)"} ide=${failedRelayState.ide.configuredUrl || "(empty)"}`);
            } catch (collectErr: any) {
              log(`[relay:on] Step 2 collect failed: ${collectErr?.message || String(collectErr)}`);
            }
            // Try to restart token proxy as fallback
            log(`[续杯-ON] 尝试恢复 Token Proxy...`);
            try {
              const fallbackState = await collectState(extensionContext!, outputChannel!);
              log(`[relay:on] fallback before startProxy: proxy.running=${fallbackState.proxy.running} relay.running=${fallbackState.relay.running}`);
              await rosettaProcess.startProxy(fallbackState);
              const fallbackAfter = await collectState(extensionContext!, outputChannel!);
              log(`[relay:on] fallback after startProxy: proxy.running=${fallbackAfter.proxy.running} relay.running=${fallbackAfter.relay.running}`);
            } catch { /* best effort */ }
            pushOperationStatus(null, null);
            throw err;
          }

          // Step 3: Ensure IDE cloudCodeUrl points to :60670 (should already be set)
          await refreshAndPush(true);
          const freshState = currentState;
          log(`[relay:on] Step 3 refreshed state: ready=${freshState?.ready} proxy.running=${freshState?.proxy.running} relay.running=${freshState?.relay.running} relay.statusUrl=${freshState?.relay.statusUrl || "(empty)"} relay.hasApiKey=${freshState?.relay.hasApiKey} ide=${freshState?.ide.configuredUrl || "(empty)"}`);
          log(`[续杯-ON] Step 3: relay.running=${freshState?.relay.running} ide.configuredUrl=${freshState?.ide.configuredUrl || '(empty)'}`);

          if (!freshState?.relay.running) {
            log(`[relay:on] Step 3 abort: relay not running after start. proxy.running=${freshState?.proxy.running} relay.lastError=${freshState?.relay.lastError || "(none)"}`);
            log(`[续杯-ON] ❌ 续杯代理未能启动`);
            vscode.window.showErrorMessage("续杯代理启动失败，请查看输出面板日志。");
            // Try to restart token proxy
            try {
              const fallbackState = await collectState(extensionContext!, outputChannel!);
              log(`[relay:on] Step 3 fallback before: proxy.running=${fallbackState.proxy.running} relay.running=${fallbackState.relay.running}`);
              await rosettaProcess.startProxy(fallbackState);
              await rosettaProcess.attachIde(fallbackState);
              const fallbackAfter = await collectState(extensionContext!, outputChannel!);
              log(`[relay:on] Step 3 fallback after: proxy.running=${fallbackAfter.proxy.running} relay.running=${fallbackAfter.relay.running} ide=${fallbackAfter.ide.configuredUrl || "(empty)"}`);
            } catch { /* best effort */ }
            pushOperationStatus(null, null);
            return;
          }

          // Ensure IDE points to :60670 (the shared port)
          if (freshState && !freshState.ide.isConfigured) {
            log(`[relay:on] Step 4 IDE not configured, attaching to shared proxy url=${freshState.proxy.url}`);
            log(`[续杯-ON] IDE 未配置，写入 cloudCodeUrl → ${freshState.proxy.url}`);
            await rosettaProcess.attachIde(freshState);
          } else {
            log(`[relay:on] Step 4 IDE already configured=${freshState?.ide.isConfigured} url=${freshState?.ide.configuredUrl || "(empty)"}`);
          }

          // Start watchdog
          log(`[relay:on] success: relay running, starting watchdog`);
          log(`[续杯-ON] ✅ 续杯已开启（共享端口，无需重载窗口）`);
          startRelayWatchdog();
          log(`[续杯-ON] 看门狗已启动，3分钟后验证续杯健康状态`);
          vscode.window.showInformationMessage("续杯代理已启动，AI 连接即时生效。");
        }
        pushOperationStatus(null, null);
        await refreshAndPush();
        return;
      }

      case "rosetta:setRelayKey": {
        const state = getState();
        const secret = await vscode.window.showInputBox({
          title: "设置续杯密钥",
          prompt: "输入 Token Server 密钥",
          password: true,
          placeHolder: "your-secret-key...",
          value: String(state.config?.relayProxy?.tokenServerSecret || state.config?.relayProxy?.apiKey || ""),
        });
        if (secret === undefined) return; // cancelled

        // Update config
        const fs = require("fs");
        const configPath = state.workspace.paths.configPath;
        let config: any = {};
        try {
          const raw = fs.readFileSync(configPath, "utf8");
          config = JSON.parse(raw);
        } catch { config = { ...state.config }; }
        if (!config.relayProxy) config.relayProxy = {};
        config.relayProxy.tokenServerSecret = secret.trim();
        // Keep apiKey for backward compat
        config.relayProxy.apiKey = secret.trim();

        writeJsonFile(configPath, config);
        vscode.window.showInformationMessage(secret.trim() ? "续杯密钥已保存。" : "续杯密钥已清除。");

        // Restart relay if it's running to pick up new key
        if (state.relay.running) {
          await rosettaProcess.stopRelayProxy(state);
          await new Promise((r) => setTimeout(r, 1000));
          await refreshAndPush(true);
          const fresh = currentState;
          if (fresh) await rosettaProcess.startRelayProxy(fresh);
        }
        await refreshAndPush();
        return;
      }

      case "rosetta:setRpKey": {
        const state = getState();
        await rosettaProcess.setReverseProxyKey(state);
        await refreshAndPush();
        return;
      }

      case "rosetta:refreshQuota": {
        const state = getState();
        const quotaAccounts = state.accounts.filter(a => a.enabled).map(a => `${a.email}(${a.planType || '?'})`);
        log(`[刷新额度] 开始刷新，当前活跃: ${state.proxy.activeEmail || "(无)"}，将刷新: [${quotaAccounts.join(', ')}]`);
        try {
          await rosettaProcess.refreshQuota(state);
          await refreshAndPush();
          // Log post-refresh quota summary
          if (currentState) {
            const summary = currentState.accounts
              .filter(a => a.enabled && a.quotaGroups.length > 0)
              .map(a => {
                const avgPercent = a.quotaGroups.length > 0
                  ? Math.round(a.quotaGroups.reduce((s, g) => s + g.percent, 0) / a.quotaGroups.length)
                  : -1;
                return `${a.email.split('@')[0]}:${avgPercent}%`;
              });
            log(`[刷新额度] 完成，额度概览: [${summary.join(', ')}]`);
          }
        } catch (err: any) {
          log(`[刷新额度] 失败: ${err.message}`);
          throw err;
        }
        return;
      }

      case "rosetta:switchAccount": {
        const state = getState();
        const switchId = Number(message.payload?.accountId);
        const targetAcc = state.accounts.find(a => a.id === switchId);
        const prevActive = state.accounts.find(a => a.isActive);
        log(`[切换账号] 请求: ${prevActive?.email || "(无)"} → ${targetAcc?.email || `#${switchId}`} | 目标状态: enabled=${targetAcc?.enabled}, projectId=${targetAcc?.projectId || '无'}, plan=${targetAcc?.planType || '?'}, blocked=${targetAcc?.quotaLiveBlockedCount || 0}`);
        try {
          await rosettaProcess.switchAccount(state, switchId);
          await refreshAndPush();
          const newActive = currentState?.accounts.find(a => a.isActive);
          log(`[切换账号] 成功 → 当前活跃: ${newActive?.email || currentState?.proxy.activeEmail || "(未知)"}`);
        } catch (err: any) {
          log(`[切换账号] 失败: ${err.message} | 目标: ${targetAcc?.email || `#${switchId}`}`);
          throw err;
        }
        return;
      }

      case "rosetta:toggleAccount": {
        const state = getState();
        const toggleId = Number(message.payload?.accountId);
        const toggleAcc = state.accounts.find(a => a.id === toggleId);
        const action = toggleAcc?.enabled ? "启用→停用" : "停用→启用";
        log(`[启停账号] ${toggleAcc?.email || `#${toggleId}`} : ${action} | isActive=${toggleAcc?.isActive}, plan=${toggleAcc?.planType || '?'}, projectId=${toggleAcc?.projectId || '无'}`);
        await rosettaProcess.toggleAccount(state, toggleId);
        await refreshAndPush();
        const remainEnabled = currentState?.accounts.filter(a => a.enabled).length || 0;
        const remainRotatable = currentState?.proxy.rotatableAccounts || 0;
        log(`[启停账号] 完成 | 当前启用: ${remainEnabled}, 可轮换: ${remainRotatable}`);
        return;
      }

      case "rosetta:editAlias": {
        const state = getState();
        await rosettaProcess.editAlias(state, Number(message.payload?.accountId));
        await refreshAndPush();
        return;
      }

      case "rosetta:editCredentials": {
        const state = getState();
        const credId = Number(message.payload?.accountId);
        const credAcc = state.accounts.find(a => a.id === credId);
        log(`[编辑凭据] 账号: ${credAcc?.email || `#${credId}`}`);
        await rosettaProcess.editCredentials(state, credId);
        await refreshAndPush();
        log(`[编辑凭据] 完成`);
        return;
      }

      case "rosetta:getCredentials": {
        const state = getState();
        const getCredId = Number(message.payload?.accountId);
        try {
          const credLine = rosettaProcess.getStoredCredentialLine(state, getCredId);
          webview.postMessage({
            type: "rosetta:credentialsResult",
            payload: { accountId: getCredId, credentialLine: credLine },
          });
        } catch (err: any) {
          webview.postMessage({
            type: "rosetta:credentialsResult",
            payload: { accountId: getCredId, error: err.message },
          });
        }
        return;
      }

      case "rosetta:deleteAccount": {
        const state = getState();
        const deleteId = Number(message.payload?.accountId);
        const deleteAcc = state.accounts.find(a => a.id === deleteId);
        log(`[删除账号] 请求删除: ${deleteAcc?.email || `#${deleteId}`}`);
        await rosettaProcess.deleteAccount(state, deleteId);
        await refreshAndPush();
        log(`[删除账号] 完成，剩余 ${currentState?.accounts.length || 0} 个账号`);
        return;
      }

      case "rosetta:addAccountToken": {
        const state = getState();
        log(`[添加账号] 通过 Token 方式添加，别名: ${message.payload?.alias || "(无)"}`);
        try {
          const result = await rosettaProcess.addAccountByToken(
            state,
            String(message.payload?.refreshToken || ""),
            String(message.payload?.alias || "")
          );
          log(`[添加账号] Token 添加成功: ${result.email}`);
          webview.postMessage({
            type: "rosetta:addAccountResult",
            payload: { email: result.email },
          });
          // Refresh state then trigger quota refresh
          await refreshAndPush();
          try {
            const freshState = getState();
            await rosettaProcess.refreshQuota(freshState);
          } catch { /* non-fatal */ }
          await refreshAndPush();
        } catch (err: any) {
          log(`[添加账号] Token 添加失败: ${err.message}`);
          webview.postMessage({
            type: "rosetta:addAccountResult",
            payload: { error: err.message || String(err) },
          });
        }
        return;
      }

      case "rosetta:addAccount": {
        const state = getState();
        log(`[添加账号] 通过浏览器 OAuth 方式添加...`);
        try {
          const result = await rosettaProcess.addAccountBrowser(state);
          log(`[添加账号] 浏览器添加成功: ${result.email}`);
          webview.postMessage({
            type: "rosetta:addAccountResult",
            payload: { email: result.email },
          });
          // Refresh state first so the new account appears in the list
          await refreshAndPush();
          // Then trigger a quota refresh so the new account gets its quota snapshot
          try {
            const freshState = getState();
            await rosettaProcess.refreshQuota(freshState);
          } catch { /* non-fatal: proxy might not be running */ }
          await refreshAndPush();
        } catch (err: any) {
          log(`[添加账号] 浏览器添加失败: ${err.message}`);
          webview.postMessage({
            type: "rosetta:addAccountResult",
            payload: { error: err.message || String(err) },
          });
        }
        return;
      }

      case "rosetta:warmupAccount": {
        const state = getState();
        const warmupId = Number(message.payload?.accountId);
        const warmupAcc = state.accounts.find(a => a.id === warmupId);
        log(`[预热] 开始预热账号: ${warmupAcc?.email || `#${warmupId}`}`);
        try {
          const result = await rosettaProcess.warmupAccount(state, warmupId);
          if (result.ok) {
            log(`[预热] 成功: ${result.email} → projectId=${result.projectId}`);
            vscode.window.showInformationMessage(`✅ 预热成功: ${result.email} (项目号: ${result.projectId})`);
          } else {
            log(`[预热] 失败: ${result.email} → ${result.error}`);
            // If verification URL is found, auto-open in browser
            if (result.verificationUrl) {
              log(`[预热] 检测到验证链接: ${result.verificationUrl}`);
              vscode.env.openExternal(vscode.Uri.parse(result.verificationUrl));
              vscode.window.showWarningMessage(
                `⚠️ 账号 ${result.email} 需要验证，已在浏览器中打开验证链接。完成后请重新预热。`
              );
            } else {
              vscode.window.showErrorMessage(`❌ 预热失败: ${result.error}`);
            }
          }
          webview.postMessage({
            type: "rosetta:warmupResult",
            payload: result,
          });
        } catch (err: any) {
          log(`[预热] 异常: ${err.message}`);
          vscode.window.showErrorMessage(`预热异常: ${err.message}`);
          webview.postMessage({
            type: "rosetta:warmupResult",
            payload: { ok: false, email: warmupAcc?.email || "", error: err.message },
          });
        }
        await refreshAndPush();
        return;
      }

      case "rosetta:openExternal": {
        const url = String(message.payload?.url || "").trim();
        if (url) {
          log(`[打开链接] ${url}`);
          vscode.env.openExternal(vscode.Uri.parse(url));
        }
        return;
      }

      case "rosetta:diagnose": {
        const state = getState();
        await rosettaProcess.runDiagnose(state);
        return;
      }

      case "rosetta:openFile": {
        const state = getState();
        await rosettaProcess.openFile(state, message.payload?.kind || "log");
        return;
      }
    }
  } catch (error: any) {
    const errMsg = error.message || String(error);
    log(`[全局异常] 操作 ${type} 失败: ${errMsg}${error.stack ? '\n' + error.stack : ''}`);
    // ⚠️ 关键：全局异常必须清除 opStatus，否则 UI loading 状态永远不会结束（按钮一直转圈）
    pushOperationStatus(null, null);
    vscode.window.showErrorMessage(errMsg);
    await refreshAndPush(true);
  }
}

export function disposeRosettaHandler(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  // Clean up relay watchdog timers to prevent orphan callbacks
  stopRelayWatchdog();
  activeWebview = null;
  currentState = null;
}
