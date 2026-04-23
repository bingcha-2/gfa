import fs from 'fs';

const content = `"use client";

import React from "react";
import Link from "next/link";
import { useState, useTransition } from "react";

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

export function SwapAccountForm({ onSuccess }: SwapAccountFormProps) {
  const [swapCode, setSwapCode] = useState("");
  const [originalEmail, setOriginalEmail] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [result, setResult] = useState<SwapResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setResult(null);

    const normalizedCode = normalizeRedeemCode(swapCode);
    const normalizedOriginalEmail = originalEmail.trim().toLowerCase();
    const normalizedNewEmail = newEmail.trim().toLowerCase();

    // Guard: new email must differ from the original
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
          <p className="label">切换账号</p>
          <h2 className="public-panel-title">填写换号信息</h2>
          <p className="muted" style={{ marginTop: '4px' }}>
            提交后系统会自动移除旧账号并向新邮箱重新发送邀请。
          </p>
        </div>

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

          <div className="field-actions" style={{ marginTop: '16px', display: 'flex', gap: '8px' }}>
            <button className="button" disabled={isPending} type="submit" style={{ flex: 1, padding: '8px 16px', background: 'var(--surface-strong)', color: 'var(--accent)' }}>
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
            <Link className="button" href={\`/status/\${result.orderNo}\`} style={{ alignSelf: 'flex-start' }}>
              查看换号执行进度
            </Link>
          </div>
        ) : null}
      </div>
    </section>
  );
}
`;

fs.writeFileSync('apps/web/src/components/swap-account-form.tsx', content);
console.log('Updated swap-account-form.tsx');
