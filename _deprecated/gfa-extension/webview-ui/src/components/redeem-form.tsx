import React, { useEffect, useRef, useState, useCallback } from "react";
import { apiRequest, getErrorMessage } from "../lib/vscode-api";
import { normalizeRedeemCode, upsertStoredPublicOrder } from "../lib/public-orders";
import type { RosettaState, RosettaAccount } from "../lib/rosetta-types";
import { onRosettaState, sendRosettaAction, requestRosettaState, requestCredentialLine } from "../lib/rosetta-api";
import { Spinner } from "./spinner";

type RedeemResponse = { orderNo: string; status: string; message: string };
export type RedeemSuccessPayload = RedeemResponse & { code: string; email: string };
type RedeemFormProps = { onSuccess?: (payload: RedeemSuccessPayload) => void };

/* ── Task polling types ── */
interface TaskLog { level: string; message: string; createdAt: string }
interface TaskStatus { taskId: string; type: string; status: string; logs: TaskLog[] }
type RunningTask = { taskId: string; status: string; logs: TaskLog[]; label: string };

const TERMINAL = ["SUCCESS", "FAILED_FINAL", "FAILED_RETRYABLE", "CANCELLED", "MANUAL_REVIEW"];

const MANUAL_JOIN_URL = "https://myaccount.google.com/u/4/people-and-sharing";

/* ── localStorage helpers ── */
const LS_REDEEM_CODE_KEY = "gfa:redeem-code";

function loadSavedRedeemCode(): string {
  try { return window.localStorage.getItem(LS_REDEEM_CODE_KEY) || ""; } catch { return ""; }
}
function saveSavedRedeemCode(v: string): void {
  try { window.localStorage.setItem(LS_REDEEM_CODE_KEY, v); } catch { /* */ }
}

export function RedeemForm({ onSuccess }: RedeemFormProps) {
  // Rosetta state
  const [rosettaState, setRosettaState] = useState<RosettaState | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);

  // Form — code persisted to localStorage
  const [code, setCode] = useState(loadSavedRedeemCode);
  const [autoAccept, setAutoAccept] = useState(false);


  // Results
  const [result, setResult] = useState<RedeemResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Auto-accept task tracking
  const [acceptTask, setAcceptTask] = useState<RunningTask | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Subscribe to Rosetta state
  useEffect(() => {
    const unsub = onRosettaState(setRosettaState);
    requestRosettaState();
    return unsub;
  }, []);

  // Cleanup polling
  useEffect(() => {
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, []);

  // Auto-clear countdown: 10 seconds after terminal state reached
  const [autoClearCountdown, setAutoClearCountdown] = useState<number | null>(null);
  const autoClearRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Detect terminal state (result with no running task, or error without running task)
  const isTerminal = (result && (!acceptTask || TERMINAL.includes(acceptTask.status))) || (error && !isSubmitting);

  useEffect(() => {
    if (isTerminal) {
      setAutoClearCountdown(10);
      autoClearRef.current = setInterval(() => {
        setAutoClearCountdown(prev => {
          if (prev === null || prev <= 1) {
            if (autoClearRef.current) clearInterval(autoClearRef.current);
            autoClearRef.current = null;
            // Auto-clear display
            setResult(null);
            setError(null);
            setAcceptTask(null);
            return null;
          }
          return prev - 1;
        });
      }, 1000);
    } else {
      if (autoClearRef.current) {
        clearInterval(autoClearRef.current);
        autoClearRef.current = null;
      }
      setAutoClearCountdown(null);
    }
    return () => {
      if (autoClearRef.current) {
        clearInterval(autoClearRef.current);
        autoClearRef.current = null;
      }
    };
  }, [isTerminal]);

  const accounts = rosettaState?.accounts ?? [];
  const selectedAccount = accounts.find(a => a.id === selectedAccountId) ?? null;

  // Poll task status
  const startPolling = useCallback((taskId: string, label: string) => {
    if (pollingRef.current) clearInterval(pollingRef.current);

    const interval = setInterval(async () => {
      try {
        const status = await apiRequest<TaskStatus>(`automation/status/${taskId}`);
        setAcceptTask({ taskId, status: status.status, logs: status.logs, label });
        if (TERMINAL.includes(status.status)) {
          clearInterval(interval);
          pollingRef.current = null;
        }
      } catch { /* retry */ }
    }, 3000);
    pollingRef.current = interval;
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedAccount) {
      setError("请先选择一个账号");
      return;
    }
    setError(null);
    setResult(null);
    setAcceptTask(null);
    setIsSubmitting(true);

    const normalizedCode = normalizeRedeemCode(code);
    const email = selectedAccount.email.trim().toLowerCase();

    try {
      // Step 1: Submit redeem
      const data = await apiRequest<RedeemResponse>("public/redeem", {
        method: "POST",
        body: { code: normalizedCode, email },
      });
      setResult(data);

      const now = new Date().toISOString();
      upsertStoredPublicOrder({ code: normalizedCode, email, orderNo: data.orderNo, status: data.status, createdAt: now, updatedAt: now });
      onSuccess?.({ ...data, code: normalizedCode, email });

      // Step 2: If auto-accept is on, use stored credentials to trigger accept-invite
      if (autoAccept && selectedAccount.hasCredentials) {
        let actualCredentialText: string;
        try {
          actualCredentialText = await requestCredentialLine(selectedAccount.id);
        } catch (err: any) {
          setError(`获取存储凭据失败: ${getErrorMessage(err)}`);
          return;
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
          setError("凭据格式不正确，需要至少包含 邮箱----密码");
          return;
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

        setAcceptTask({
          taskId: taskResult.taskId,
          status: taskResult.status,
          logs: [],
          label: selectedAccount.email,
        });
        startPolling(taskResult.taskId, selectedAccount.email);
      }
    } catch (err) {
      setResult(null);
      setError(getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  const isAnyRunning = acceptTask && !TERMINAL.includes(acceptTask.status);

  return (
    <section className="form-card">
      <div className="panel-stack">
        <form className="field-grid" onSubmit={onSubmit}>
          {/* Card code */}
          <div className="field">
            <label htmlFor="redeem-code">卡密</label>
            <input
              id="redeem-code"
              autoComplete="off"
              className="mono"
              placeholder="例如 JZ12345678..."
              required
              value={code}
              onChange={e => {
                const v = e.target.value.toUpperCase();
                setCode(v);
                saveSavedRedeemCode(v);
              }}
            />
            <small>每个卡密只能消耗一次，对应一次新的邀请任务。</small>
          </div>

          {/* Account selection from Rosetta pool */}
          <div className="field">
            <label>选择接收邀请的账号（本地账号池）</label>
            {!rosettaState?.ready ? (
              <div className="ultra-notice subtle">
                <span>⚠️</span> Rosetta 未就绪，请先确认代理目录已安装。
              </div>
            ) : accounts.length === 0 ? (
              <div className="ultra-notice subtle">
                <span>📭</span> 账号池为空，请先通过账号管理的「新增账号」添加。
              </div>
            ) : (
              <select
                className="mono"
                value={selectedAccountId ?? ""}
                onChange={e => setSelectedAccountId(e.target.value ? Number(e.target.value) : null)}
                style={{ width: "100%" }}
              >
                <option value="">-- 请选择账号 --</option>
                {accounts.map(acc => (
                  <option key={acc.id} value={acc.id}>
                    {acc.email}{acc.planType ? ` [${acc.planType.toUpperCase()}]` : ""}{acc.isActive ? " (使用中)" : ""}{!acc.enabled ? " (已禁用)" : ""}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Auto-accept toggle — SwitchCard style (matches 一键接管) */}
          <div className="rosetta-switches rosetta-switches-single" style={{ marginTop: 4 }}>
            <button
              type="button"
              className={`rosetta-switch ${autoAccept ? "on" : "off"}`}
              onClick={() => {
                setAutoAccept(!autoAccept);
                setError(null);
              }}
            >
              <span className="rosetta-switch-copy">
                <span className="rosetta-switch-label">自动接受邀请</span>
                <span className="rosetta-switch-hint">
                  {autoAccept
                    ? (selectedAccount?.hasCredentials
                        ? `✅ 将使用 ${selectedAccount.email} 的已存凭据`
                        : "⚠️ 所选账号未录入凭据")
                    : "关闭"}
                </span>
              </span>
              <span className="rosetta-switch-track">
                <span className="rosetta-switch-thumb" />
              </span>
            </button>
          </div>
          {autoAccept && selectedAccount && !selectedAccount.hasCredentials && (
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
              ⚠️ <strong>{selectedAccount.email}</strong> 尚未录入凭据，无法自动接受邀请。
              <br />
              请前往「账号管理」→ 点击该账号的「🔑 凭据」按钮 → 录入密码和 TOTP 密钥后再试。
            </div>
          )}

          {/* Submit */}
          <div className="field-actions" style={{ marginTop: 12 }}>
            <button
              className="button premium-primary"
              disabled={isSubmitting || !selectedAccount || !code.trim() || !!isAnyRunning || (autoAccept && !selectedAccount?.hasCredentials)}
              type="submit"
              style={{ flex: 1, backgroundColor: "#ea580c", color: "white" }}
            >
              {isSubmitting ? (
                <>
                  <Spinner size={16} color="white" />
                  <span>正在处理中...</span>
                </>
              ) : "立即提交"}
            </button>
          </div>
        </form>

        {error ? <div className="notice error">{error}</div> : null}

        {/* Redeem result */}
        {result ? (
          <div className="notice success-scanner" style={{
            background: "rgba(234, 88, 12, 0.08)", borderColor: "rgba(234, 88, 12, 0.2)",
            padding: 24, borderRadius: 16
          }}>
            <div className="panel-stack">
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 24 }}>🎉</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, color: "var(--accent-strong)", fontWeight: 700, letterSpacing: "0.05em" }}>SUCCESS</div>
                  <strong style={{ fontSize: "1.2rem", color: "var(--foreground)" }}>订单已成功排队并创建</strong>
                </div>
                {autoClearCountdown !== null && (
                  <span style={{ fontSize: 11, color: "rgba(31,26,23,0.4)", whiteSpace: "nowrap" }}>{autoClearCountdown}s 后自动关闭</span>
                )}
              </div>
              <div style={{
                background: "white", padding: "12px 16px", borderRadius: 8,
                border: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center",
              }}>
                <span className="muted">追踪订单号:</span>
                <span className="mono strong" style={{ color: "var(--accent)", fontSize: "1.1rem" }}>{result.orderNo}</span>
              </div>
              {/* Manual join link — shown when auto-accept is not used */}
              {!autoAccept && (
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="button premium-primary"
                    style={{
                      width: "100%",
                      backgroundColor: "#2563eb",
                      color: "white",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 8,
                      padding: "10px 16px",
                      fontSize: 13,
                      fontWeight: 600,
                    }}
                    onClick={() => sendRosettaAction("rosetta:openExternal", { url: MANUAL_JOIN_URL })}
                  >
                    🔗 手动进组（打开 Google 联系人页面）
                  </button>
                  <small style={{ display: "block", marginTop: 6, lineHeight: 1.5, color: "rgba(31,26,23,0.5)" }}>
                    邀请发送成功后，请登录子号并在上方链接中接受家庭组邀请。
                  </small>
                </div>
              )}
            </div>
          </div>
        ) : null}

        {/* Auto-accept task status */}
        {acceptTask && (
          <div className="autojoin-log" style={{ marginTop: 8 }}>
            <p className="label" style={{ marginBottom: 6 }}>自动接受邀请</p>
            {TERMINAL.includes(acceptTask.status) ? (
              /* Terminal: only show summary, no full log */
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "8px 12px", borderRadius: 8,
                background: acceptTask.status === "SUCCESS" ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)",
                border: `1px solid ${acceptTask.status === "SUCCESS" ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)"}`,
                fontSize: 12,
              }}>
                <span>{acceptTask.status === "SUCCESS" ? "✅" : "❌"}</span>
                <span style={{ flex: 1 }}>{acceptTask.label} — {acceptTask.status === "SUCCESS" ? "已完成" : acceptTask.status}</span>
                <span style={{ fontSize: 10, opacity: 0.5 }}>共 {acceptTask.logs.length} 条日志</span>
              </div>
            ) : (
              /* Running: show last 3 log lines */
              <details open style={{ marginBottom: 4 }}>
                <summary className="autojoin-log-summary">
                  <Spinner size={10} />
                  <span style={{ marginLeft: 6, flex: 1 }}>{acceptTask.label}</span>
                  <span style={{ fontSize: 10, opacity: 0.5 }}>{acceptTask.status}</span>
                </summary>
                <div className="autojoin-log-body">
                  {acceptTask.logs.length === 0 ? (
                    <div style={{ padding: 8, color: "rgba(31,26,23,0.3)", fontSize: 11 }}>等待执行…</div>
                  ) : (
                    acceptTask.logs.slice(-3).map((log, i) => (
                      <div key={i} className={`autojoin-log-line${log.level === "ERROR" ? " error" : ""}`}>
                        <span style={{ fontSize: 10, color: "rgba(31,26,23,0.35)", flexShrink: 0, minWidth: 50 }}>
                          {new Date(log.createdAt).toLocaleTimeString()}
                        </span>
                        <span style={{ fontSize: 11 }}>{log.message}</span>
                      </div>
                    ))
                  )}
                </div>
              </details>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
