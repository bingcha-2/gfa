/**
 * Rosetta message handler — processes rosetta:* messages from the Webview.
 * Maintains a polling loop that pushes updated state to the panel.
 */

import * as vscode from "vscode";
import { collectState, type RosettaState } from "./rosettaState.js";
import * as rosettaProcess from "./rosettaProcess.js";

// ─── Logging helper ─────────────────────────────────────────────────────
function log(msg: string): void {
  if (!outputChannel) return;
  const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  outputChannel.appendLine(`[${ts}] ${msg}`);
}

const REFRESH_INTERVAL_MS = 8000;

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

export function initRosettaHandler(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel
): void {
  extensionContext = context;
  outputChannel = channel;

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
      if (nowIdeConfigured) {
        log(`[🔴 代理离线] IDE 仍指向代理地址 — 会话将中断！`);
        // Trigger auto-restart if in takeover mode
        void attemptAutoRestart();
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
        const isTakeoverOn = state.proxy.running && state.ide.isConfigured;
        if (isTakeoverOn) {
          // Turn off: clear IDE first, then stop proxy
          log(`[一键接管] 正在关闭接管...`);
          await rosettaProcess.clearIde(state);
          await rosettaProcess.stopProxy(state);
          // Wait for OS to fully release ports (avoid EADDRINUSE on next start)
          await new Promise((r) => setTimeout(r, 1500));
          log(`[一键接管] 已关闭`);
        } else {
          // Turn on: start proxy, then force IDE reconnection
          log(`[一键接管] 正在开启接管...`);
          let proxyStartError: string | null = null;
          if (!state.proxy.running) {
            try {
              await rosettaProcess.startProxy(state);
            } catch (err: any) {
              proxyStartError = err.message || String(err);
              log(`[一键接管] startProxy 异常: ${proxyStartError}（将检查代理是否实际运行）`);
            }
            // Wait for proxy to fully initialize
            await new Promise((r) => setTimeout(r, 2000));
          }
          // Re-collect REAL state (not stale cache) after proxy start
          await refreshAndPush(true);
          const freshState = currentState;
          // ALWAYS force IDE reconnection: clear URL → wait → set URL
          // This ensures the IDE detects a configuration change and creates
          // a fresh connection to the (possibly new) proxy process.
          if (freshState) {
            // Step 1: Always clear first (even if already empty) to force a change event
            log(`[一键接管] 强制刷新 IDE 连接（先清除再重连）...`);
            await rosettaProcess.clearIde(freshState);
            // Step 2: Wait long enough for IDE to detect disconnection
            await new Promise((r) => setTimeout(r, 2000));
            // Step 3: Set the proxy URL
            await rosettaProcess.attachIde(freshState);
            log(`[一键接管] IDE 已写入代理地址`);
          }
          if (proxyStartError && !(freshState?.proxy.running)) {
            vscode.window.showErrorMessage(`代理启动异常: ${proxyStartError}`);
          }
          // Step 4: Verify connection after a delay
          await new Promise((r) => setTimeout(r, 3000));
          await refreshAndPush(true);
          const verifyState = currentState;
          if (verifyState?.proxy.running && verifyState?.ide.isConfigured) {
            log(`[一键接管] ✅ 已开启，代理运行中，IDE 已配置`);
          } else {
            log(`[一键接管] ⚠️ 开启完成但状态异常: proxy=${verifyState?.proxy.running} ide=${verifyState?.ide.isConfigured}`);
            // Suggest window reload if IDE doesn't seem to pick up the change
            const action = await vscode.window.showWarningMessage(
              "接管已开启，但 AI 可能需要重载窗口才能生效。",
              "重载窗口",
              "忽略"
            );
            if (action === "重载窗口") {
              await vscode.commands.executeCommand("workbench.action.reloadWindow");
            }
          }
          log(`[一键接管] 已开启`);
        }
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
    vscode.window.showErrorMessage(errMsg);
    await refreshAndPush(true);
  }
}

export function disposeRosettaHandler(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  activeWebview = null;
  currentState = null;
}
