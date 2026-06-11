"use client";

import Link from "next/link";
import { useState, useTransition, useEffect, useRef, useCallback } from "react";

import { apiRequest, getErrorMessage } from "../lib/client-api";
import { normalizeRedeemCode } from "../lib/public-orders";
import { useDict } from "@/lib/i18n/client";

type RedeemResponse = {
  orderNo: string;
  status: string;
  message: string;
};

export type RedeemSuccessPayload = RedeemResponse & {
  code: string;
  email: string;
};

type RedeemFormProps = {
  onSuccess?: (payload: RedeemSuccessPayload) => void;
  secondaryHref?: string;
  secondaryLabel?: string;
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

export function RedeemForm({
  onSuccess,
  secondaryHref = "/",
  secondaryLabel
}: RedeemFormProps) {
  const t = useDict();
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");         // used when autoAccept is OFF
  const [credentialLine, setCredentialLine] = useState(""); // used when autoAccept is ON
  const [result, setResult] = useState<RedeemResponse | null>(null);
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
    setAcceptError(null);
    setAcceptTask(null);

    const normalizedCode = normalizeRedeemCode(code);

    // Derive email from credential line or standalone field
    const normalizedEmail = autoAccept
      ? parseEmailFromCredential(credentialLine)
      : email.trim().toLowerCase();

    if (!normalizedEmail) {
      setError(autoAccept ? t.redeemForm.errNeedCredential : t.redeemForm.errNeedEmail);
      return;
    }

    startTransition(async () => {
      try {
        const data = await apiRequest<RedeemResponse>("public/redeem", {
          method: "POST",
          body: { code: normalizedCode, email: normalizedEmail }
        });

        setResult(data);
        onSuccess?.({
          ...data,
          code: normalizedCode,
          email: normalizedEmail
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
              label: normalizedEmail,
            });
            startPolling(taskResult.taskId, normalizedEmail);
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

  // Credential validation: must have 3 parts
  const credentialParts = credentialLine.split("----");
  const credentialValid = autoAccept ? credentialParts.length >= 3 && credentialParts[0].trim().length > 0 : true;

  return (
    <section className="form-card premium-shadow">
      <div className="panel-stack">

        <form className="field-grid" onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="redeem-code">{t.redeemForm.codeLabel}</label>
            <input
              id="redeem-code"
              autoComplete="off"
              className="mono"
              placeholder={t.redeemForm.codePlaceholder}
              required
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
            />
            <small>{t.redeemForm.codeHint}</small>
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
                  {autoAccept ? t.redeemForm.autoJoinOn : t.redeemForm.autoJoinOff}
                </span>
              </span>
              <span className="autojoin-toggle-track">
                <span className="autojoin-toggle-thumb" />
              </span>
            </button>
          </div>

          {/* Conditional: normal email OR credential input */}
          {autoAccept ? (
            <div className="autojoin-credential-form">
              <label htmlFor="redeem-credential">{t.redeemForm.credentialLabel}</label>
              <input
                id="redeem-credential"
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
                {t.redeemForm.credentialNote}
              </small>
            </div>
          ) : (
            <div className="field">
              <label htmlFor="user-email">{t.redeemForm.emailLabel}</label>
              <input
                id="user-email"
                autoComplete="email"
                inputMode="email"
                placeholder="yourname@gmail.com"
                required
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value.trimStart())}
              />
            </div>
          )}

          <div className="field-actions" style={{ marginTop: '12px' }}>
            <button
              className="button premium-primary"
              disabled={isPending || !!isAnyRunning || (autoAccept && !credentialValid)}
              type="submit"
              style={{ flex: 1, backgroundColor: '#ea580c', color: 'white' }}
            >
              {isPending ? (
                <>
                  <svg className="animate-spin" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
                  </svg>
                  <span>{t.redeemForm.submitQueueing}</span>
                </>
              ) : t.redeemForm.submit}
            </button>
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
          <div className="notice success-scanner" style={{ background: 'rgba(234, 88, 12, 0.08)', borderColor: 'rgba(234, 88, 12, 0.2)', padding: '24px', borderRadius: '16px' }}>
            <div className="panel-stack">
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '24px' }}>🎉</span>
                <div>
                  <div style={{ fontSize: '13px', color: 'var(--accent-strong)', fontWeight: 700, letterSpacing: '0.05em' }}>SUCCESS</div>
                  <strong style={{ fontSize: '1.2rem', color: 'var(--foreground)' }}>{t.redeemForm.successTitle}</strong>
                </div>
              </div>
              <div style={{ background: 'white', padding: '12px 16px', borderRadius: '8px', border: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="muted">{t.redeemForm.successOrderNo}</span>
                <span className="mono strong" style={{ color: 'var(--accent)', fontSize: '1.1rem' }}>{result.orderNo}</span>
              </div>
              <div className="muted" style={{ lineHeight: 1.6 }}>{result.message}</div>
              <div className="inline-actions" style={{ justifyContent: "flex-start", marginTop: '8px' }}>
                <Link className="button premium-primary" href={`/status/${result.orderNo}`} style={{ minHeight: '40px' }}>
                  {t.redeemForm.viewProgress}
                </Link>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
