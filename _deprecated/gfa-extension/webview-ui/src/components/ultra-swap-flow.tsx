import React, { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest, getErrorMessage } from "../lib/vscode-api";
import { normalizeRedeemCode } from "../lib/public-orders";
import type { RosettaState, RosettaAccount } from "../lib/rosetta-types";
import { onRosettaState, sendRosettaAction, requestRosettaState, requestCredentialLine } from "../lib/rosetta-api";
import { Spinner } from "./spinner";
import type { PublicOrder } from "../lib/types";

/* ── Types ── */
type SwapResponse = { orderNo: string; status: string; message: string; taskId?: string };

type FlowStep = "idle" | "submitting" | "polling" | "accepting" | "switching" | "ide" | "done" | "error";

interface StepInfo {
  key: FlowStep;
  label: string;
  index: number;
}

interface TaskLog { level: string; message: string; createdAt: string }
interface TaskStatus { taskId: string; type: string; status: string; logs: TaskLog[] }

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 300_000; // 5 minutes
const ACCEPT_TIMEOUT_MS = 300_000; // 5 minutes for accept-invite
const TERMINAL = ["SUCCESS", "FAILED_FINAL", "FAILED_RETRYABLE", "CANCELLED", "MANUAL_REVIEW"];

/* ── Helpers ── */
function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

const MANUAL_JOIN_URL = "https://myaccount.google.com/u/4/people-and-sharing";

/* ── localStorage helpers ── */
const LS_SWAP_CODE_KEY = "gfa:ultra-swap-code";
const LS_ORIG_ID_KEY = "gfa:ultra-orig-id";
const LS_NEW_ID_KEY = "gfa:ultra-new-id";

function loadSavedSwapCode(): string {
  try { return window.localStorage.getItem(LS_SWAP_CODE_KEY) || ""; } catch { return ""; }
}
function saveSavedSwapCode(v: string): void {
  try { window.localStorage.setItem(LS_SWAP_CODE_KEY, v); } catch { /* */ }
}
function clearSavedSwapCode(): void {
  try { window.localStorage.removeItem(LS_SWAP_CODE_KEY); } catch { /* */ }
}

function loadSavedId(key: string): number | null {
  try { const v = window.localStorage.getItem(key); return v ? Number(v) : null; } catch { return null; }
}
function saveId(key: string, v: number | null): void {
  try { if (v !== null) window.localStorage.setItem(key, String(v)); else window.localStorage.removeItem(key); } catch { /* */ }
}

/* ── Component ── */
export function UltraSwapFlow() {
  // Form state — swap code persisted to localStorage
  const [swapCode, setSwapCode] = useState(loadSavedSwapCode);
  const [selectedOriginalId, _setSelectedOriginalId] = useState<number | null>(() => loadSavedId(LS_ORIG_ID_KEY));
  const [selectedNewId, _setSelectedNewId] = useState<number | null>(() => loadSavedId(LS_NEW_ID_KEY));

  // Wrapped setters that also persist to localStorage
  const setSelectedOriginalId = useCallback((v: number | null) => { _setSelectedOriginalId(v); saveId(LS_ORIG_ID_KEY, v); }, []);
  const setSelectedNewId = useCallback((v: number | null) => { _setSelectedNewId(v); saveId(LS_NEW_ID_KEY, v); }, []);

  const [autoAccept, setAutoAccept] = useState(false);

  // Rosetta state
  const [rosettaState, setRosettaState] = useState<RosettaState | null>(null);

  // Flow state
  const [currentStep, setCurrentStep] = useState<FlowStep>("idle");
  const [stepMessage, setStepMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [orderNo, setOrderNo] = useState<string | null>(null);
  const [acceptLogs, setAcceptLogs] = useState<TaskLog[]>([]);
  const abortRef = useRef(false);

  // Subscribe to Rosetta state
  useEffect(() => {
    const unsub = onRosettaState(setRosettaState);
    requestRosettaState();
    return unsub;
  }, []);

  const accounts = rosettaState?.accounts ?? [];
  const selectedOriginal = accounts.find(a => a.id === selectedOriginalId) ?? null;
  const selectedNew = accounts.find(a => a.id === selectedNewId) ?? null;

  // Dynamic steps based on autoAccept
  const STEPS: StepInfo[] = autoAccept
    ? [
        { key: "submitting", label: "提交换号", index: 0 },
        { key: "polling", label: "等待进组完成", index: 1 },
        { key: "accepting", label: "自动接受邀请", index: 2 },
        { key: "switching", label: "切换代理", index: 3 },
        { key: "ide", label: "IDE 接管", index: 4 },
      ]
    : [
        { key: "submitting", label: "提交换号", index: 0 },
        { key: "polling", label: "等待进组完成", index: 1 },
        { key: "switching", label: "切换代理", index: 2 },
        { key: "ide", label: "IDE 接管", index: 3 },
      ];

  function getStepIndex(step: FlowStep): number {
    const found = STEPS.find(s => s.key === step);
    return found ? found.index : -1;
  }

  // ── The pipeline ──
  const startFlow = useCallback(async () => {
    if (!selectedNew || !selectedOriginal) return;
    const normalizedCode = normalizeRedeemCode(swapCode);
    const originalEmail = selectedOriginal.email.trim().toLowerCase();
    const newEmail = selectedNew.email;

    if (originalEmail === newEmail.toLowerCase()) {
      setErrorMessage("新账号不能与原账号相同。");
      return;
    }

    abortRef.current = false;
    setErrorMessage(null);
    setOrderNo(null);
    setAcceptLogs([]);

    try {
      // ── Step 1: Submit swap ──
      setCurrentStep("submitting");
      setStepMessage("正在提交换号请求…");

      const swapResult = await apiRequest<SwapResponse>("public/swap-by-email", {
        method: "POST",
        body: { swapCode: normalizedCode, originalEmail, newEmail },
      });

      setOrderNo(swapResult.orderNo);
      setStepMessage(`换号任务已排队 (${swapResult.orderNo})`);

      if (abortRef.current) return;

      // ── Step 2: Poll until invite sent (or completed) ──
      setCurrentStep("polling");
      setStepMessage("等待服务器完成替换和发送邀请…");

      const startTime = Date.now();
      // After REPLACE_MEMBER, order status goes to INVITE_SENT (not COMPLETED).
      // COMPLETED only happens after user accepts. For auto-accept flow, we
      // should proceed once the invite is sent.
      const SWAP_DONE_STATES = ["COMPLETED", "INVITE_SENT", "WAIT_USER_ACCEPT"];
      let completed = SWAP_DONE_STATES.includes(swapResult.status);

      while (!completed && !abortRef.current) {
        if (Date.now() - startTime > POLL_TIMEOUT_MS) {
          throw new Error("换号超时 (5分钟)，请在查询进度中手动检查。");
        }
        await sleep(POLL_INTERVAL_MS);

        const order = await apiRequest<PublicOrder>(`public/orders/${swapResult.orderNo}`);
        setStepMessage(`状态: ${order.status}，已等待 ${Math.round((Date.now() - startTime) / 1000)}s`);

        if (SWAP_DONE_STATES.includes(order.status)) {
          completed = true;
        } else if (["FAILED", "FAILED_FINAL", "CANCELLED", "MANUAL_REVIEW"].includes(order.status)) {
          throw new Error(`换号失败: ${order.status}${order.resultMessage ? ` — ${order.resultMessage}` : ""}`);
        }
      }

      if (abortRef.current) return;

      // ── Step 2.5 (optional): Auto-accept invite ──
      if (autoAccept && selectedNew.hasCredentials) {
        setCurrentStep("accepting");
        setStepMessage("正在自动接受邀请…");

        let actualCredentialText: string;
        try {
          actualCredentialText = await requestCredentialLine(selectedNew.id);
        } catch (err: any) {
          throw new Error(`获取存储凭据失败: ${err.message}`);
        }

        // Parse credential line (smart detection)
        const sep = actualCredentialText.includes("----") ? "----" : actualCredentialText.includes("---") ? "---" : "|";
        const credParts = actualCredentialText.split(sep).map(s => s.trim());
        const credEmail = credParts[0] || "";
        const credPassword = credParts[1] || "";
        let credRecovery = credParts[2] || "";
        let credTotp = credParts[3] || "";

        // Fallback: if no 4th part but 3rd part exists, it might be the TOTP
        if (!credTotp && credRecovery && !credRecovery.includes("@")) {
          credTotp = credRecovery;
          credRecovery = "";
        }

        // Smart swap if recoveryEmail looks like a TOTP (no '@') and totpSecret looks like an email (has '@')
        if (credRecovery && !credRecovery.includes("@") && credTotp && credTotp.includes("@")) {
          const temp = credRecovery;
          credRecovery = credTotp;
          credTotp = temp;
        }

        if (!credEmail || !credPassword) {
          throw new Error("凭据格式不正确，需要至少包含 邮箱----密码");
        }

        // Call automation/start directly (public endpoint, no JWT needed)
        const taskResult = await apiRequest<{ taskId: string; status: string }>(
          "automation/start",
          {
            method: "POST",
            body: {
              action: "accept-invite",
              email: credEmail,
              password: credPassword,
              totpSecret: credTotp || undefined,
            },
          }
        );

        setStepMessage(`接受邀请任务已启动 (${taskResult.taskId.slice(-6)})…`);

        // Poll accept-invite task until complete
        const acceptStart = Date.now();
        let acceptDone = false;

        while (!acceptDone && !abortRef.current) {
          if (Date.now() - acceptStart > ACCEPT_TIMEOUT_MS) {
            throw new Error("接受邀请超时 (5分钟)。");
          }
          await sleep(3000);

          const status = await apiRequest<TaskStatus>(`automation/status/${taskResult.taskId}`);
          setAcceptLogs(status.logs);
          setStepMessage(`接受邀请: ${status.status}，已等待 ${Math.round((Date.now() - acceptStart) / 1000)}s`);

          if (TERMINAL.includes(status.status)) {
            acceptDone = true;
            if (status.status !== "SUCCESS") {
              throw new Error(`接受邀请失败: ${status.status}`);
            }
          }
        }

        if (abortRef.current) return;
      }

      // ── Step 3: Switch Rosetta proxy to new account ──
      setCurrentStep("switching");
      setStepMessage(`正在切换代理到 ${newEmail}…`);

      sendRosettaAction("rosetta:refresh");
      await sleep(2000);

      sendRosettaAction("rosetta:switchAccount", { accountId: selectedNew.id });
      await sleep(1500);

      if (abortRef.current) return;



      // ── Step 5: Ensure IDE is attached ──
      setCurrentStep("ide");
      setStepMessage("正在确认 IDE 接管…");

      sendRosettaAction("rosetta:refresh");
      await sleep(2000);

      sendRosettaAction("rosetta:ensureIde");
      await sleep(1000);

      // ── Done ──
      setCurrentStep("done");
      setStepMessage(`🎉 Ultra 接续完成！已切换到 ${newEmail}`);
    } catch (err) {
      setCurrentStep("error");
      setErrorMessage(getErrorMessage(err));
      setAcceptLogs([]);  // clear logs on error — only show error message
    }
  }, [swapCode, selectedOriginal, selectedNew, accounts, autoAccept]);

  function cancelFlow() {
    abortRef.current = true;
    setCurrentStep("idle");
    setStepMessage("");
    setErrorMessage("已取消操作。");
  }

  function resetFlow() {
    abortRef.current = true;
    setCurrentStep("idle");
    setStepMessage("");
    setErrorMessage(null);
    setOrderNo(null);
    setAcceptLogs([]);
    setSwapCode("");
    clearSavedSwapCode();
    setSelectedOriginalId(null);
    setSelectedNewId(null);
  }

  const isRunning = !["idle", "done", "error"].includes(currentStep);
  const activeStepIndex = getStepIndex(currentStep);
  const rosettaReady = rosettaState?.ready === true;

  // Auto-reset countdown: 10 seconds after reaching "done" or "error"
  const [countdown, setCountdown] = useState<number | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (currentStep === "done" || currentStep === "error") {
      setCountdown(10);
      countdownRef.current = setInterval(() => {
        setCountdown(prev => {
          if (prev === null || prev <= 1) {
            if (countdownRef.current) clearInterval(countdownRef.current);
            countdownRef.current = null;
            // Auto reset — only clear transient state, keep credentials
            abortRef.current = true;
            setCurrentStep("idle");
            setStepMessage("");
            setErrorMessage(null);
            setOrderNo(null);
            setAcceptLogs([]);
            // NOTE: Do NOT clear swapCode, selectedOriginalId, selectedNewId
            // The user wants credentials to persist across task runs.
            return null;
          }
          return prev - 1;
        });
      }, 1000);
    } else {
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
      setCountdown(null);
    }
    return () => {
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
    };
  }, [currentStep]);

  // Never show detailed logs during execution or after — only show summary when done
  const visibleLogs: TaskLog[] = [];

  return (
    <section className="form-card">
      <div className="panel-stack">
        {/* Form inputs */}
        {currentStep === "idle" && (
          <form
            className="field-grid"
            onSubmit={e => { e.preventDefault(); startFlow(); }}
          >
            <div className="field">
              <label htmlFor="ultra-swap-code">换号卡密</label>
              <input
                id="ultra-swap-code"
                autoComplete="off"
                className="mono"
                placeholder="例如 HH1234... 或 CX5678..."
                required
                value={swapCode}
                onChange={e => {
                  const v = e.target.value.toUpperCase();
                  setSwapCode(v);
                  saveSavedSwapCode(v);
                }}
              />
            </div>

            {/* Original account selection */}
            <div className="field">
              <label>原账号（已进组的成员）</label>
              {!rosettaReady ? (
                <div className="ultra-notice subtle">
                  <span>⚠️</span> Rosetta 未就绪，请先确认代理目录已安装。
                </div>
              ) : accounts.length === 0 ? (
                <div className="ultra-notice subtle">
                  <span>📭</span> 账号池为空，请先通过账号管理的「新增账号」登录。
                </div>
              ) : (
                <select
                  className="mono"
                  value={selectedOriginalId ?? ""}
                  onChange={e => setSelectedOriginalId(e.target.value ? Number(e.target.value) : null)}
                  style={{ width: "100%" }}
                >
                  <option value="">-- 请选择原账号 --</option>
                  {accounts.map(acc => (
                    <option key={acc.id} value={acc.id}>
                      {acc.email}{acc.planType ? ` [${acc.planType.toUpperCase()}]` : ""}{acc.isActive ? " (使用中)" : ""}{!acc.enabled ? " (已禁用)" : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* New account selection */}
            <div className="field">
              <label>新账号（将替换进组）</label>
              {rosettaReady && accounts.length > 0 ? (
                <select
                  className="mono"
                  value={selectedNewId ?? ""}
                  onChange={e => setSelectedNewId(e.target.value ? Number(e.target.value) : null)}
                  style={{ width: "100%" }}
                >
                  <option value="">-- 请选择新账号 --</option>
                  {accounts
                    .filter(a => a.id !== selectedOriginalId)
                    .map(acc => (
                      <option key={acc.id} value={acc.id}>
                        {acc.email}{acc.planType ? ` [${acc.planType.toUpperCase()}]` : ""}{!acc.enabled ? " (已禁用)" : ""}
                      </option>
                    ))}
                </select>
              ) : null}
            </div>

            {/* Auto-accept toggle — SwitchCard style (matches 一键接管) */}
            <div className="rosetta-switches rosetta-switches-single" style={{ marginTop: 4 }}>
              <button
                type="button"
                className={`rosetta-switch ${autoAccept ? "on" : "off"}`}
                onClick={() => {
                  setAutoAccept(!autoAccept);
                  setErrorMessage(null);
                }}
              >
                <span className="rosetta-switch-copy">
                  <span className="rosetta-switch-label">自动接受邀请</span>
                  <span className="rosetta-switch-hint">
                    {autoAccept
                      ? (selectedNew?.hasCredentials
                          ? `✅ 将使用 ${selectedNew.email} 的已存凭据`
                          : "⚠️ 所选账号未录入凭据")
                      : "关闭"}
                  </span>
                </span>
                <span className="rosetta-switch-track">
                  <span className="rosetta-switch-thumb" />
                </span>
              </button>
            </div>
            {autoAccept && selectedNew && !selectedNew.hasCredentials && (
              <div style={{
                marginTop: 6,
                padding: "10px 12px",
                borderRadius: 8,
                background: "rgba(239, 68, 68, 0.08)",
                border: "1px solid rgba(239, 68, 68, 0.2)",
                fontSize: 12,
                lineHeight: 1.6,
                color: "#b91c1c",
              }}>
                ⚠️ <strong>{selectedNew.email}</strong> 尚未录入凭据，无法自动接受邀请。
                <br />
                请前往「账号管理」→ 点击该账号的「🔑 凭据」按钮 → 录入密码和 TOTP 密钥后再试。
              </div>
            )}

            <div className="field-actions" style={{ marginTop: 12 }}>
              <button
                className="button ultra-start-btn"
                disabled={!swapCode || !selectedOriginal || !selectedNew || !rosettaReady || (autoAccept && !selectedNew?.hasCredentials)}
                type="submit"
              >
                🚀 一键接续
              </button>
            </div>
          </form>
        )}

        {/* Progress display */}
        {currentStep !== "idle" && (
          <div className="ultra-progress">
            <div className="ultra-steps">
              {STEPS.map(step => {
                const si = step.index;
                let status: "pending" | "active" | "done" | "error" = "pending";
                if (currentStep === "error" && si === activeStepIndex) status = "error";
                else if (currentStep === "done" || si < activeStepIndex) status = "done";
                else if (si === activeStepIndex) status = "active";

                return (
                  <div key={step.key} className={`ultra-step ${status}`}>
                    <div className="ultra-step-indicator">
                      {status === "done" ? (
                        <span className="ultra-step-check">✓</span>
                      ) : status === "active" ? (
                        <Spinner size={14} />
                      ) : status === "error" ? (
                        <span className="ultra-step-x">✕</span>
                      ) : (
                        <span className="ultra-step-num">{si + 1}</span>
                      )}
                    </div>
                    <div className="ultra-step-label">{step.label}</div>
                  </div>
                );
              })}
            </div>

            <div className="ultra-status-message">
              {stepMessage}
            </div>

            {orderNo && (
              <div className="ultra-order-badge">
                <span className="muted">订单号</span>
                <span className="mono">{orderNo}</span>
              </div>
            )}

            {/* Accept-invite logs — only show summary line when done, never detail logs */}
            {currentStep === "done" && acceptLogs.length > 0 && (
              <div className="ultra-log-summary" style={{ marginTop: 8, fontSize: 12, color: "rgba(31,26,23,0.55)" }}>
                ✅ 自动接受邀请完成（共 {acceptLogs.length} 条日志）
              </div>
            )}

            {errorMessage && (
              <div className="notice error">{errorMessage}</div>
            )}

            <div className="ultra-flow-actions">
              {isRunning && (
                <button className="button secondary" onClick={cancelFlow} type="button">
                  取消
                </button>
              )}
              {currentStep === "done" && !autoAccept && (
                <button
                  type="button"
                  className="button premium-primary"
                  style={{
                    backgroundColor: "#2563eb",
                    color: "white",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                  onClick={() => sendRosettaAction("rosetta:openExternal", { url: MANUAL_JOIN_URL })}
                >
                  🔗 手动进组（打开 Google 联系人页面）
                </button>
              )}
              {(currentStep === "done" || currentStep === "error") && (
                <button className="button" onClick={resetFlow} type="button">
                  {currentStep === "done" ? "完成" : "重试"}{countdown !== null ? ` (${countdown}s)` : ""}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
