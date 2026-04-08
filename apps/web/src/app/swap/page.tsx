"use client";

import { useState, useEffect, useCallback } from "react";

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
  const [step, setStep] = useState<SwapStep>("form");
  const [form, setForm] = useState({ originalEmail: "", swapCode: "", newEmail: "" });
  const [result, setResult] = useState<{ orderNo: string; status: string; message: string } | null>(null);
  const [swapStatus, setSwapStatus] = useState<SwapStatus | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

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
      setErrorMsg("新邮箱不能与原邮箱相同，请重新填写。");
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
        <h1 className="brand-title">Google One Family</h1>
        <p className="brand-sub">账号换绑服务</p>
      </header>

      <section className="public-card">
        {step === "form" && (
          <form className="form-card panel-stack" onSubmit={handleSubmit}>
            <div className="section-copy">
              <p className="label">Account Swap</p>
              <h2 className="panel-title">自助换号</h2>
              <p className="muted">
                如原账号被封禁，填写原邮箱、换号卡密和新账号邮箱即可完成自动换绑。
              </p>
            </div>

            <div className="field">
              <label htmlFor="swap-originalEmail">原账号邮箱</label>
              <input
                autoComplete="off"
                id="swap-originalEmail"
                placeholder="your-original-account@gmail.com"
                required
                type="email"
                value={form.originalEmail}
                onChange={(e) => setForm((f) => ({ ...f, originalEmail: e.target.value }))}
              />
              <p className="field-hint">之前兑换进组时使用的 Google 账号邮箱。</p>
            </div>

            <div className="field">
              <label htmlFor="swap-code">换号卡密</label>
              <input
                autoComplete="off"
                id="swap-code"
                placeholder="XXXXXXXXXXXXXXXX"
                required
                type="text"
                value={form.swapCode}
                onChange={(e) => setForm((f) => ({ ...f, swapCode: e.target.value }))}
              />
              <p className="field-hint">换号卡密（ACCOUNT_SWAP 类型），每张只能使用一次。</p>
            </div>

            <div className="field">
              <label htmlFor="swap-newEmail">新账号邮箱</label>
              <input
                autoComplete="off"
                id="swap-newEmail"
                placeholder="your-new-account@gmail.com"
                required
                type="email"
                value={form.newEmail}
                onChange={(e) => setForm((f) => ({ ...f, newEmail: e.target.value }))}
              />
              <p className="field-hint">将加入家庭组的新 Google 账号，确认拼写无误。</p>
            </div>

            <button className="button" disabled={isSubmitting} type="submit">
              {isSubmitting ? "提交中..." : "提交换号申请"}
            </button>
          </form>
        )}

        {step === "polling" && (
          <div className="panel-stack">
            <div className="section-copy">
              <p className="label notice-ok">⏳ 执行中</p>
              <h2 className="panel-title">换号任务进行中</h2>
              <p className="muted">系统正在自动处理，通常需要 1–3 分钟。请勿关闭此页面。</p>
            </div>

            {result && (
              <div className="info-block">
                <div className="info-row">
                  <span className="label">订单号</span>
                  <span className="strong mono">{result.orderNo}</span>
                </div>
                <div className="info-row">
                  <span className="label">订单状态</span>
                  <span className="strong">{swapStatus?.status ?? result.status}</span>
                </div>
                {swapStatus?.task && (
                  <div className="info-row">
                    <span className="label">任务状态</span>
                    <span className="strong">{swapStatus.task.status}</span>
                  </div>
                )}
                {swapStatus?.isRetrying && (
                  <div className="info-row">
                    <span className="label">提示</span>
                    <span className="muted">
                      {swapStatus.task?.errorHint ?? "系统正在自动重试，请耐心等待..."}
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
              <p className="label notice-ok">✓ 换号成功</p>
              <h2 className="panel-title">邀请已发出</h2>
              <p className="muted">系统已将旧账号踢出并向您的新账号发送了邀请。</p>
            </div>

            {result && (
              <div className="info-block">
                <div className="info-row">
                  <span className="label">订单号</span>
                  <span className="strong mono">{result.orderNo}</span>
                </div>
                <div className="info-row">
                  <span className="label">状态</span>
                  <span className="strong notice-ok">已完成</span>
                </div>
              </div>
            )}

            <p className="muted">
              请登录新账号邮箱，接受 Google Family 邀请即可。
            </p>
            <button className="button secondary" onClick={reset} type="button">
              再次换号
            </button>
          </div>
        )}

        {step === "failed" && (
          <div className="panel-stack">
            <div className="section-copy">
              <p className="label notice-error">✕ 换号失败</p>
              <h2 className="panel-title">任务未能完成</h2>
            </div>

            <div className="notice error">
              {swapStatus?.task?.errorHint ?? swapStatus?.resultMessage ?? "系统多次重试后仍未成功，请重新提交。"}
            </div>

            {result && (
              <div className="info-block">
                <div className="info-row">
                  <span className="label">订单号</span>
                  <span className="strong mono">{result.orderNo}</span>
                </div>
              </div>
            )}

            <p className="muted">
              您可以直接使用相同的卡密重新提交换号申请，系统将重新执行。
            </p>
            <button className="button" onClick={retryWithSameInfo} type="button">
              重新提交换号
            </button>
          </div>
        )}

        {step === "error" && (
          <div className="panel-stack">
            <div className="section-copy">
              <p className="label notice-error">✕ 提交失败</p>
              <h2 className="panel-title">提交遇到问题</h2>
            </div>
            <div className="notice error">{errorMsg}</div>
            <button className="button" onClick={reset} type="button">
              重新填写
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
