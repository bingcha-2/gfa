"use client";

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
          <p className="label">换号申请</p>
          <h2 className="public-panel-title">填写换号信息</h2>
          <p className="muted">
            提交后系统会自动移除旧账号并向新邮箱重新发送邀请。
          </p>
        </div>

        <form className="field-grid" onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="swap-code">换号卡密</label>
            <input
              id="swap-code"
              autoComplete="off"
              className="mono"
              placeholder="例如 SWAP1234ABCD5678"
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

          <div className="field-actions">
            <button className="button" disabled={isPending} type="submit">
              {isPending ? "提交中..." : "提交换号申请"}
            </button>
            <Link className="button secondary" href="/status">
              查询订单
            </Link>
          </div>
        </form>

        {error ? <div className="notice error">{error}</div> : null}

        {result ? (
          <div className="notice">
            <div className="panel-stack">
              <div>
                <strong>换号任务已创建:</strong>{" "}
                <span className="mono strong">{result.orderNo}</span>
              </div>
              <div className="muted">{result.message}</div>
              <div className="inline-actions" style={{ justifyContent: "flex-start" }}>
                <Link className="button small" href={`/status/${result.orderNo}`}>
                  查看换号进度
                </Link>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
