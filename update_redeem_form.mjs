import fs from 'fs';

const content = `"use client";

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
    <section className="form-card">
      <div className="panel-stack">
        <div>
          <p className="label">邀请进组</p>
          <h2 className="public-panel-title">填写卡密和 Gmail</h2>
          <p className="muted" style={{ marginTop: '4px' }}>
            提交后会立即创建订单并进入自动处理队列。
          </p>
        </div>

        <form className="field-grid" onSubmit={onSubmit} style={{ marginTop: '16px' }}>
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

          <div className="field-actions" style={{ marginTop: '16px', display: 'flex', gap: '8px' }}>
            <button className="button premium-primary" disabled={isPending} type="submit" style={{ flex: 1, padding: '8px 16px' }}>
              {isPending ? (
                <>
                  <svg className="animate-spin" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <circle cx="12" cy="12" r="10" opacity="0.25"></circle>
                    <path d="M12 2v4"></path>
                  </svg>
                  <span>正在处理中...</span>
                </>
              ) : "提交进入队列"}
            </button>
            <Link className="button secondary" href={secondaryHref} style={{ padding: '8px 16px' }}>
              {secondaryLabel}
            </Link>
          </div>
        </form>

        {error ? <div className="notice error">{error}</div> : null}

        {!onSuccess && result ? (
          <div className="notice" style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '18px' }}>✅</span>
              <div>
                <strong style={{ fontSize: '14px', color: 'var(--foreground)' }}>订单已排队</strong>
              </div>
            </div>
            <div style={{ background: '#010409', padding: '8px 12px', borderRadius: '4px', border: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="muted" style={{ fontSize: '12px' }}>订单号</span>
              <span className="mono strong" style={{ color: 'var(--accent)', fontSize: '13px' }}>{result.orderNo}</span>
            </div>
            <div className="muted">{result.message}</div>
            <Link className="button" href={\`/status/\${result.orderNo}\`} style={{ alignSelf: 'flex-start' }}>
              查看进度
            </Link>
          </div>
        ) : null}
      </div>
    </section>
  );
}
`;

fs.writeFileSync('apps/web/src/components/redeem-form.tsx', content);
console.log('Updated redeem-form.tsx');
