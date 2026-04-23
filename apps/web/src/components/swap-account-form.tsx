"use client";

import React from "react";
import Link from "next/link";
import { useState, useTransition, useEffect, useRef, useCallback } from "react";

import { apiRequest, getErrorMessage } from "../lib/client-api";
import { normalizeRedeemCode } from "../lib/public-orders";

type SwapResponse = {
  orderNo: string;
  status: string;
  message: string;
  taskId?: string;
};

export type SwapSuccessPayload = SwapResponse & {
  swapCode: string;
  newEmail: string;
};

type SwapAccountFormProps = {
  onSuccess?: (payload: SwapSuccessPayload) => void;
};

/* ── Auto-accept types ── */
interface TaskLog { level: string; message: string; createdAt: string }
interface TaskStatus { taskId: string; type: string; status: string; logs: TaskLog[] }

const TERMINAL = ["SUCCESS", "FAILED_FINAL", "FAILED_RETRYABLE", "CANCELLED", "MANUAL_REVIEW"];

/** Parse credential line "email----password----totp" → email part */
function parseEmailFromCredential(line: string): string {
  const parts = line.split("----");
  return (parts[0] || "").trim().toLowerCase();
}

export function SwapAccountForm({ onSuccess }: SwapAccountFormProps) {
  const [swapCode, setSwapCode] = useState("");
  const [originalEmail, setOriginalEmail] = useState("");
  const [newEmail, setNewEmail] = useState("");         // used when autoAccept is OFF
  const [credentialLine, setCredentialLine] = useState(""); // used when autoAccept is ON
  const [result, setResult] = useState<SwapResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Auto-accept state
  const [autoAccept, setAutoAccept] = useState(false);
  const [acceptTask, setAcceptTask] = useState<{ taskId: string; status: string; logs: TaskLog[]; label: string } | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [isAccepting, setIsAccepting] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup polling
  useEffect(() => {
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, []);

  const startPolling = useCallback((taskId: string, label: string) => {
    if (pollingRef.current) clearInterval(pollingRef.current);

    const interval = setInterval(async () => {
      try {
        const status = await apiRequest<TaskStatus>(`automation/status/${taskId}`);
        setAcceptTask({ taskId, status: status.status, logs: status.logs, label });
        if (TERMINAL.includes(status.status)) {
          clearInterval(interval);
          pollingRef.current = null;
          setIsAccepting(false);
        }
      } catch { /* retry */ }
    }, 3000);
    pollingRef.current = interval;
  }, []);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setResult(null);
    setAcceptError(null);
    setAcceptTask(null);

    const normalizedCode = normalizeRedeemCode(swapCode);
    const normalizedOriginalEmail = originalEmail.trim().toLowerCase();

    // Derive new email from credential line or standalone field
    const normalizedNewEmail = autoAccept
      ? parseEmailFromCredential(credentialLine)
      : newEmail.trim().toLowerCase();

    if (!normalizedNewEmail) {
      setError(autoAccept ? "请输入完整凭据（邮箱----密码----TOTP密钥）" : "请输入新邮箱");
      return;
    }

    // Guard: new email must differ
    if (normalizedOriginalEmail === normalizedNewEmail) {
      setError("新邮箱不能与原邮箱相同，请重新填写。");
      return;
    }

    startTransition(async () => {
      try {
        const data = await apiRequest<SwapResponse>("public/swap-by-email", {
          method: "POST",
          body: {
            swapCode: normalizedCode,
            originalEmail: normalizedOriginalEmail,
            newEmail: normalizedNewEmail
          }
        });

        setResult(data);
        onSuccess?.({
          ...data,
          swapCode: normalizedCode,
          newEmail: normalizedNewEmail
        });

        // Auto-accept flow
        if (autoAccept && credentialLine.trim()) {
          setIsAccepting(true);
          setAcceptError(null);

          try {
            // Parse credential line: email----password----totpSecret
            const credParts = credentialLine.trim().split("----");
            const credEmail = (credParts[0] || "").trim();
            const credPassword = (credParts[1] || "").trim();
            const credTotp = (credParts[2] || "").trim();

            if (!credEmail || !credPassword) {
              setAcceptError("凭据格式不正确，需要至少包含 邮箱----密码");
              setIsAccepting(false);
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
              label: normalizedNewEmail,
            });
            startPolling(taskResult.taskId, normalizedNewEmail);
          } catch (acErr) {
            setAcceptError(getErrorMessage(acErr));
            setIsAccepting(false);
          }
        }
      } catch (submitError) {
        setResult(null);
        setError(getErrorMessage(submitError));
      }
    });
  }

  const isAnyRunning = isAccepting || (acceptTask && !TERMINAL.includes(acceptTask.status));

  // Credential validation
  const credentialParts = credentialLine.split("----");
  const credentialValid = autoAccept ? credentialParts.length >= 3 && credentialParts[0].trim().length > 0 : true;

  return (
    <section className="form-card">
      <div className="panel-stack">

        <form className="field-grid" onSubmit={onSubmit} style={{ marginTop: '16px' }}>
          <div className="field">
            <label htmlFor="swap-code">换号卡密</label>
            <input
              id="swap-code"
              autoComplete="off"
              className="mono"
              placeholder="例如 HH1234... 或 CX5678..."
              required
              value={swapCode}
              onChange={(event) => setSwapCode(event.target.value.toUpperCase())}
            />
            <small>换号卡密是专属类型，普通邀请卡密无法使用此功能。</small>
          </div>

          <div className="field">
            <label htmlFor="swap-original-email">原账号邮箱</label>
            <input
              id="swap-original-email"
              autoComplete="email"
              inputMode="email"
              placeholder="your-original-account@gmail.com"
              required
              type="email"
              value={originalEmail}
              onChange={(event) => setOriginalEmail(event.target.value.trimStart())}
            />
            <small>之前兑换进组时使用的 Google 账号邮箱。</small>
          </div>

          {/* Auto-accept toggle */}
          <div className="autojoin-toggle-wrap">
            <button
              type="button"
              className={`autojoin-toggle ${autoAccept ? "on" : ""}`}
              onClick={() => {
                setAutoAccept(!autoAccept);
                setAcceptError(null);
              }}
            >
              <span className="autojoin-toggle-copy">
                <span className="autojoin-toggle-label">🤖 自动进组</span>
                <span className="autojoin-toggle-hint">
                  {autoAccept ? "已开启 — 换号后将自动接受家庭组邀请" : "关闭 — 系统发送邀请后需手动去确认家庭组"}
                </span>
              </span>
              <span className="autojoin-toggle-track">
                <span className="autojoin-toggle-thumb" />
              </span>
            </button>
          </div>

          {/* Conditional: normal new email OR credential input */}
          {autoAccept ? (
            <div className="autojoin-credential-form">
              <label htmlFor="swap-credential">新账号凭据</label>
              <input
                id="swap-credential"
                autoComplete="off"
                className="mono"
                placeholder="邮箱----密码----TOTP密钥"
                required
                value={credentialLine}
                onChange={(event) => setCredentialLine(event.target.value)}
              />
              <small style={{ lineHeight: 1.6 }}>
                格式：<code style={{ background: 'rgba(234, 88, 12, 0.1)', padding: '2px 6px', borderRadius: '4px', fontSize: '12px' }}>账号邮箱----密码----TOTP密钥</code>
                <br />
                开启后系统会在换号完成后自动登录新账号并接受邀请，无需手动操作。
              </small>
            </div>
          ) : (
            <div className="field">
              <label htmlFor="swap-new-email">新 Google 邮箱</label>
              <input
                id="swap-new-email"
                autoComplete="email"
                inputMode="email"
                placeholder="newaddress@gmail.com"
                required
                type="email"
                value={newEmail}
                onChange={(event) => setNewEmail(event.target.value.trimStart())}
              />
              <small>邀请将发送到此新邮箱，请确认邮箱拼写正确。</small>
            </div>
          )}

          <div className="field-actions" style={{ marginTop: '16px', display: 'flex', gap: '8px' }}>
            <button className="button" disabled={isPending || !!isAnyRunning || (autoAccept && !credentialValid)} type="submit" style={{ flex: 1, padding: '8px 16px', background: '#ea580c', color: 'white', border: 'none' }}>
              {isPending ? (
                <>
                  <svg className="animate-spin" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <circle cx="12" cy="12" r="10" opacity="0.25"></circle>
                    <path d="M12 2v4"></path>
                  </svg>
                  <span>正在提交换号任务...</span>
                </>
              ) : "提交换号请求"}
            </button>
            <Link className="button secondary" href="/status" style={{ padding: '8px 16px' }}>
              查询订单
            </Link>
          </div>
        </form>

        {error ? <div className="notice error">{error}</div> : null}
        {acceptError ? <div className="notice error">{acceptError}</div> : null}

        {/* Auto-accept task status */}
        {acceptTask && (
          <div className="autojoin-log">
            <p className="label" style={{ marginBottom: '6px' }}>自动进组</p>
            <details open={!TERMINAL.includes(acceptTask.status)} style={{ marginBottom: '4px' }}>
              <summary className="autojoin-log-summary">
                {!TERMINAL.includes(acceptTask.status) ? (
                  <svg className="animate-spin" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
                ) : acceptTask.status === "SUCCESS" ? "✅" : "❌"}
                <span style={{ marginLeft: '6px', flex: 1 }}>{acceptTask.label}</span>
                <span style={{ fontSize: '10px', opacity: 0.5 }}>{acceptTask.status}</span>
              </summary>
              <div className="autojoin-log-body">
                {acceptTask.logs.length === 0 ? (
                  <div style={{ padding: '8px', color: 'rgba(31,26,23,0.3)', fontSize: '11px' }}>等待执行…</div>
                ) : (
                  acceptTask.logs.map((log, i) => (
                    <div key={i} className={`autojoin-log-line${log.level === "ERROR" ? " error" : ""}`}>
                      <span style={{ fontSize: '10px', color: 'rgba(31,26,23,0.35)', flexShrink: 0, minWidth: '50px' }}>
                        {new Date(log.createdAt).toLocaleTimeString()}
                      </span>
                      <span style={{ fontSize: '11px' }}>{log.message}</span>
                    </div>
                  ))
                )}
              </div>
            </details>
          </div>
        )}

        {!onSuccess && result ? (
          <div className="notice" style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '18px' }}>⚡</span>
              <div>
                <strong style={{ fontSize: '14px', color: 'var(--foreground)' }}>换号任务已排队</strong>
              </div>
            </div>
            <div style={{ background: '#010409', padding: '8px 12px', borderRadius: '4px', border: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="muted" style={{ fontSize: '12px' }}>订单号</span>
              <span className="mono strong" style={{ color: 'var(--accent)', fontSize: '13px' }}>{result.orderNo}</span>
            </div>
            <div className="muted">{result.message}</div>
            <Link className="button" href={`/status/${result.orderNo}`} style={{ alignSelf: 'flex-start' }}>
              查看换号执行进度
            </Link>
          </div>
        ) : null}
      </div>
    </section>
  );
}
