"use client";

import React from "react";
import Link from "next/link";
import { useState, useTransition, useEffect, useRef, useCallback } from "react";

import { apiRequest, getErrorMessage } from "../lib/client-api";
import { normalizeRedeemCode } from "../lib/public-orders";
import { useDict } from "@/lib/i18n/client";

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
  const t = useDict();
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
      setError(autoAccept ? t.redeemForm.errNeedCredential : t.swapForm.errNeedNewEmail);
      return;
    }

    // Guard: new email must differ
    if (normalizedOriginalEmail === normalizedNewEmail) {
      setError(t.swapForm.errSameEmail);
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
              setAcceptError(t.redeemForm.errBadCredential);
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
            <label htmlFor="swap-code">{t.swapForm.codeLabel}</label>
            <input
              id="swap-code"
              autoComplete="off"
              className="mono"
              placeholder={t.swapForm.codePlaceholder}
              required
              value={swapCode}
              onChange={(event) => setSwapCode(event.target.value.toUpperCase())}
            />
            <small>{t.swapForm.codeHint}</small>
          </div>

          <div className="field">
            <label htmlFor="swap-original-email">{t.swapForm.originalEmailLabel}</label>
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
            <small>{t.swapForm.originalEmailHint}</small>
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
                <span className="autojoin-toggle-label">{t.redeemForm.autoJoinLabel}</span>
                <span className="autojoin-toggle-hint">
                  {autoAccept ? t.swapForm.autoJoinOn : t.redeemForm.autoJoinOff}
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
              <label htmlFor="swap-credential">{t.swapForm.credentialLabel}</label>
              <input
                id="swap-credential"
                autoComplete="off"
                className="mono"
                placeholder={t.redeemForm.credentialPlaceholder}
                required
                value={credentialLine}
                onChange={(event) => setCredentialLine(event.target.value)}
              />
              <small style={{ lineHeight: 1.6 }}>
                {t.redeemForm.credentialFormatLabel}<code style={{ background: 'rgba(234, 88, 12, 0.1)', padding: '2px 6px', borderRadius: '4px', fontSize: '12px' }}>{t.redeemForm.credentialFormatCode}</code>
                <br />
                {t.swapForm.credentialNote}
              </small>
            </div>
          ) : (
            <div className="field">
              <label htmlFor="swap-new-email">{t.swapForm.newEmailLabel}</label>
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
              <small>{t.swapForm.newEmailHint}</small>
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
                  <span>{t.swapForm.submitting}</span>
                </>
              ) : t.swapForm.submit}
            </button>
            <Link className="button secondary" href="/status" style={{ padding: '8px 16px' }}>
              {t.swapForm.lookupOrder}
            </Link>
          </div>
        </form>

        {error ? <div className="notice error">{error}</div> : null}
        {acceptError ? <div className="notice error">{acceptError}</div> : null}

        {/* Auto-accept task status */}
        {acceptTask && (
          <div className="autojoin-log">
            <p className="label" style={{ marginBottom: '6px' }}>{t.redeemForm.autoJoinSection}</p>
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
                  <div style={{ padding: '8px', color: 'rgba(31,26,23,0.3)', fontSize: '11px' }}>{t.redeemForm.waitingExec}</div>
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
                <strong style={{ fontSize: '14px', color: 'var(--foreground)' }}>{t.swapForm.queuedTitle}</strong>
              </div>
            </div>
            <div style={{ background: '#010409', padding: '8px 12px', borderRadius: '4px', border: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="muted" style={{ fontSize: '12px' }}>{t.swapForm.orderNo}</span>
              <span className="mono strong" style={{ color: 'var(--accent)', fontSize: '13px' }}>{result.orderNo}</span>
            </div>
            <div className="muted">{result.message}</div>
            <Link className="button" href={`/status/${result.orderNo}`} style={{ alignSelf: 'flex-start' }}>
              {t.swapForm.viewProgress}
            </Link>
          </div>
        ) : null}
      </div>
    </section>
  );
}
