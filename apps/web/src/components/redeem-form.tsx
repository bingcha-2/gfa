"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { apiRequest, getErrorMessage } from "../lib/client-api";
import { normalizeRedeemCode } from "../lib/public-orders";

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

export function RedeemForm({
  onSuccess,
  secondaryHref = "/",
  secondaryLabel = "返回概览"
}: RedeemFormProps) {
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<RedeemResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const normalizedCode = normalizeRedeemCode(code);
    const normalizedEmail = email.trim().toLowerCase();

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
      } catch (submitError) {
        setResult(null);
        setError(getErrorMessage(submitError));
      }
    });
  }

  return (
    <section className="form-card premium-shadow">
      <div className="panel-stack">


        <form className="field-grid" onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="redeem-code">卡密</label>
            <input
              id="redeem-code"
              autoComplete="off"
              className="mono"
              placeholder="例如 JZ12345678..."
              required
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
            />
            <small>每个卡密只能消耗一次，对应一次新的邀请任务。</small>
          </div>

          <div className="field">
            <label htmlFor="user-email">接收邀请的 Google 邮箱</label>
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

          <div className="field-actions" style={{ marginTop: '12px' }}>
            <button className="button premium-primary" disabled={isPending} type="submit" style={{ flex: 1, backgroundColor: '#ea580c', color: 'white' }}>
              {isPending ? (
                <>
                  <svg className="animate-spin" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
                  </svg>
                  <span>正在排队处理中...</span>
                </>
              ) : "立即提交"}
            </button>
          </div>
        </form>

        {error ? <div className="notice error">{error}</div> : null}

        {!onSuccess && result ? (
          <div className="notice success-scanner" style={{ background: 'rgba(234, 88, 12, 0.08)', borderColor: 'rgba(234, 88, 12, 0.2)', padding: '24px', borderRadius: '16px' }}>
            <div className="panel-stack">
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '24px' }}>🎉</span>
                <div>
                  <div style={{ fontSize: '13px', color: 'var(--accent-strong)', fontWeight: 700, letterSpacing: '0.05em' }}>SUCCESS</div>
                  <strong style={{ fontSize: '1.2rem', color: 'var(--foreground)' }}>订单已成功排队并创建</strong>
                </div>
              </div>
              <div style={{ background: 'white', padding: '12px 16px', borderRadius: '8px', border: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="muted">您的专属追踪订单号:</span>
                <span className="mono strong" style={{ color: 'var(--accent)', fontSize: '1.1rem' }}>{result.orderNo}</span>
              </div>
              <div className="muted" style={{ lineHeight: 1.6 }}>{result.message}</div>
              <div className="inline-actions" style={{ justifyContent: "flex-start", marginTop: '8px' }}>
                <Link className="button premium-primary" href={`/status/${result.orderNo}`} style={{ minHeight: '40px' }}>
                  查看实时追踪进度 →
                </Link>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
