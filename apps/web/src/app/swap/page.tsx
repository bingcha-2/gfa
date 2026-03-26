"use client";

import { useState } from "react";

type SwapStep = "form" | "done" | "error";

export default function SwapPage() {
  const [step, setStep] = useState<SwapStep>("form");
  const [form, setForm] = useState({ originalEmail: "", swapCode: "", newEmail: "" });
  const [result, setResult] = useState<{ orderNo: string; status: string; message: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    setErrorMsg(null);

    // Guard: new email must differ from the original
    if (form.originalEmail.trim().toLowerCase() === form.newEmail.trim().toLowerCase()) {
      setErrorMsg("新邮箱不能与原邮箱相同，请重新填写。");
      setStep("error");
      setIsSubmitting(false);
      return;
    }

    try {
      const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
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
      setStep("done");
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

        {step === "done" && result && (
          <div className="panel-stack">
            <div className="section-copy">
              <p className="label notice-ok">✓ 换号申请已提交</p>
              <h2 className="panel-title">换号任务已入队</h2>
              <p className="muted">系统将自动踢出旧账号并向您的新账号发送邀请，整个过程约需 1–3 分钟。</p>
            </div>

            <div className="info-block">
              <div className="info-row">
                <span className="label">订单号</span>
                <span className="strong mono">{result.orderNo}</span>
              </div>
              <div className="info-row">
                <span className="label">状态</span>
                <span className="strong">{result.status}</span>
              </div>
              {result.message && (
                <div className="info-row">
                  <span className="label">说明</span>
                  <span className="muted">{result.message}</span>
                </div>
              )}
            </div>

            <p className="muted">
              请留意新账号邮箱的家庭组邀请邮件。接受邀请后换号完成。
            </p>
            <button className="button secondary" onClick={reset} type="button">
              再次换号
            </button>
          </div>
        )}

        {step === "error" && (
          <div className="panel-stack">
            <div className="section-copy">
              <p className="label notice-error">✕ 换号失败</p>
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
