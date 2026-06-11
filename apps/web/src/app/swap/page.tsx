"use client";

import { useState, useEffect, useCallback } from "react";
import { useDict } from "@/lib/i18n/client";

type SwapStep = "form" | "polling" | "done" | "failed" | "error";

type SwapStatus = {
  orderNo: string;
  userEmail: string;
  status: string;
  resultMessage: string | null;
  task: {
    status: string;
    startedAt: string | null;
    finishedAt: string | null;
    hasError: boolean;
    errorHint: string | null;
  } | null;
  canRetry: boolean;
  isRetrying: boolean;
};

export default function SwapPage() {
  const t = useDict();
  const [step, setStep] = useState<SwapStep>("form");
  const [form, setForm] = useState({ originalEmail: "", swapCode: "", newEmail: "" });
  const [result, setResult] = useState<{ orderNo: string; status: string; message: string } | null>(null);
  const [swapStatus, setSwapStatus] = useState<SwapStatus | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

  const statusLabel = (s: string | undefined | null) =>
    s ? (t.statusLabels[s] ?? s) : s;

  // Poll swap status
  const pollStatus = useCallback(async (orderNo: string) => {
    try {
      const res = await fetch(`${apiBase}/public/swap-status/${orderNo}`);
      if (!res.ok) return;
      const data: SwapStatus = await res.json();
      setSwapStatus(data);

      // Terminal states
      const terminalOrderStatuses = new Set(["INVITE_SENT", "COMPLETED", "WAIT_USER_ACCEPT"]);
      const terminalTaskStatuses = new Set(["SUCCESS", "REPLACED_AND_INVITE_SENT", "INVITE_SENT"]);

      if (terminalOrderStatuses.has(data.status) || (data.task && terminalTaskStatuses.has(data.task.status))) {
        setStep("done");
        return;
      }

      if (data.canRetry) {
        setStep("failed");
        return;
      }
    } catch {
      // Non-fatal polling error, will retry
    }
  }, [apiBase]);

  // Auto-poll while in polling step
  useEffect(() => {
    if (step !== "polling" || !result?.orderNo) return;

    // Initial poll
    void pollStatus(result.orderNo);

    const timer = window.setInterval(() => {
      void pollStatus(result.orderNo);
    }, 5000);

    return () => window.clearInterval(timer);
  }, [step, result?.orderNo, pollStatus]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    setErrorMsg(null);

    if (form.originalEmail.trim().toLowerCase() === form.newEmail.trim().toLowerCase()) {
      setErrorMsg(t.swapPage.sameEmailError);
      setStep("error");
      setIsSubmitting(false);
      return;
    }

    try {
      const res = await fetch(`${apiBase}/public/swap-by-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originalEmail: form.originalEmail.trim().toLowerCase(),
          swapCode: form.swapCode.trim().toUpperCase(),
          newEmail: form.newEmail.trim().toLowerCase()
        })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.message ?? `Request failed (${res.status})`);
      }

      setResult(data);
      setStep("polling");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStep("error");
    } finally {
      setIsSubmitting(false);
    }
  }

  function reset() {
    setStep("form");
    setForm({ originalEmail: "", swapCode: "", newEmail: "" });
    setResult(null);
    setSwapStatus(null);
    setErrorMsg(null);
  }

  function retryWithSameInfo() {
    // Pre-fill form and go back to form step so user can re-submit
    setStep("form");
    setResult(null);
    setSwapStatus(null);
    setErrorMsg(null);
  }

  return (
    <main className="public-shell">
      <header className="public-header">
        <div className="brand-mark">GO</div>
        <h1 className="brand-title">{t.swapPage.brandTitle}</h1>
        <p className="brand-sub">{t.swapPage.brandSub}</p>
      </header>

      <section className="public-card">
        {step === "form" && (
          <form className="form-card panel-stack" onSubmit={handleSubmit}>
            <div className="section-copy">
              <p className="label">{t.swapPage.formLabel}</p>
              <h2 className="panel-title">{t.swapPage.formTitle}</h2>
              <p className="muted">
                {t.swapPage.formDesc}
              </p>
            </div>

            <div className="field">
              <label htmlFor="swap-originalEmail">{t.swapPage.originalEmailLabel}</label>
              <input
                autoComplete="off"
                id="swap-originalEmail"
                placeholder="your-original-account@gmail.com"
                required
                type="email"
                value={form.originalEmail}
                onChange={(e) => setForm((f) => ({ ...f, originalEmail: e.target.value }))}
              />
              <p className="field-hint">{t.swapPage.originalEmailHint}</p>
            </div>

            <div className="field">
              <label htmlFor="swap-code">{t.swapPage.swapCodeLabel}</label>
              <input
                autoComplete="off"
                id="swap-code"
                placeholder="XXXXXXXXXXXXXXXX"
                required
                type="text"
                value={form.swapCode}
                onChange={(e) => setForm((f) => ({ ...f, swapCode: e.target.value }))}
              />
              <p className="field-hint">{t.swapPage.swapCodeHint}</p>
            </div>

            <div className="field">
              <label htmlFor="swap-newEmail">{t.swapPage.newEmailLabel}</label>
              <input
                autoComplete="off"
                id="swap-newEmail"
                placeholder="your-new-account@gmail.com"
                required
                type="email"
                value={form.newEmail}
                onChange={(e) => setForm((f) => ({ ...f, newEmail: e.target.value }))}
              />
              <p className="field-hint">{t.swapPage.newEmailHint}</p>
            </div>

            <button className="button" disabled={isSubmitting} type="submit">
              {isSubmitting ? t.swapPage.submitting : t.swapPage.submit}
            </button>
          </form>
        )}

        {step === "polling" && (
          <div className="panel-stack">
            <div className="section-copy">
              <p className="label notice-ok">{t.swapPage.pollingLabel}</p>
              <h2 className="panel-title">{t.swapPage.pollingTitle}</h2>
              <p className="muted">{t.swapPage.pollingDesc}</p>
            </div>

            {result && (
              <div className="info-block">
                <div className="info-row">
                  <span className="label">{t.swapPage.orderNo}</span>
                  <span className="strong mono">{result.orderNo}</span>
                </div>
                <div className="info-row">
                  <span className="label">{t.swapPage.orderStatus}</span>
                  <span className="strong">{statusLabel(swapStatus?.status ?? result.status)}</span>
                </div>
                {swapStatus?.task && (
                  <div className="info-row">
                    <span className="label">{t.swapPage.taskStatus}</span>
                    <span className="strong">{statusLabel(swapStatus.task.status)}</span>
                  </div>
                )}
                {swapStatus?.isRetrying && (
                  <div className="info-row">
                    <span className="label">{t.swapPage.hint}</span>
                    <span className="muted">
                      {swapStatus.task?.errorHint ?? t.swapPage.retryingHint}
                    </span>
                  </div>
                )}
              </div>
            )}

            <div className="swap-progress-bar">
              <div className="swap-progress-fill" />
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="panel-stack">
            <div className="section-copy">
              <p className="label notice-ok">{t.swapPage.doneLabel}</p>
              <h2 className="panel-title">{t.swapPage.doneTitle}</h2>
              <p className="muted">{t.swapPage.doneDesc}</p>
            </div>

            {result && (
              <div className="info-block">
                <div className="info-row">
                  <span className="label">{t.swapPage.orderNo}</span>
                  <span className="strong mono">{result.orderNo}</span>
                </div>
                <div className="info-row">
                  <span className="label">{t.swapPage.status}</span>
                  <span className="strong notice-ok">{t.swapPage.completed}</span>
                </div>
              </div>
            )}

            <p className="muted">
              {t.swapPage.doneNote}
            </p>
            <button className="button secondary" onClick={reset} type="button">
              {t.swapPage.swapAgain}
            </button>
          </div>
        )}

        {step === "failed" && (
          <div className="panel-stack">
            <div className="section-copy">
              <p className="label notice-error">{t.swapPage.failedLabel}</p>
              <h2 className="panel-title">{t.swapPage.failedTitle}</h2>
            </div>

            <div className="notice error">
              {swapStatus?.task?.errorHint ?? swapStatus?.resultMessage ?? t.swapPage.failedFallback}
            </div>

            {result && (
              <div className="info-block">
                <div className="info-row">
                  <span className="label">{t.swapPage.orderNo}</span>
                  <span className="strong mono">{result.orderNo}</span>
                </div>
              </div>
            )}

            <p className="muted">
              {t.swapPage.failedNote}
            </p>
            <button className="button" onClick={retryWithSameInfo} type="button">
              {t.swapPage.resubmit}
            </button>
          </div>
        )}

        {step === "error" && (
          <div className="panel-stack">
            <div className="section-copy">
              <p className="label notice-error">{t.swapPage.errorLabel}</p>
              <h2 className="panel-title">{t.swapPage.errorTitle}</h2>
            </div>
            <div className="notice error">{errorMsg}</div>
            <button className="button" onClick={reset} type="button">
              {t.swapPage.refill}
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
