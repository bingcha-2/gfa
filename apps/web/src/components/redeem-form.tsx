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
    <section className="form-card">
      <div className="panel-stack">
        <div>
          <p className="label">提交邀请</p>
          <h2 className="public-panel-title">填写卡密和 Gmail</h2>
          <p className="muted">
            提交后会立即创建订单并进入自动处理队列。
          </p>
        </div>

        <form className="field-grid" onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="redeem-code">卡密</label>
            <input
              id="redeem-code"
              autoComplete="off"
              className="mono"
              placeholder="例如 ABCD1234EFGH5678"
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

          <div className="field-actions">
            <button className="button" disabled={isPending} type="submit">
              {isPending ? "正在排队..." : "提交并开始处理"}
            </button>
            <Link className="button secondary" href={secondaryHref}>
              {secondaryLabel}
            </Link>
          </div>
        </form>

        {error ? <div className="notice error">{error}</div> : null}

        {result ? (
          <div className="notice">
            <div className="panel-stack">
              <div>
                <strong>订单已创建:</strong>{" "}
                <span className="mono strong">{result.orderNo}</span>
              </div>
              <div className="muted">{result.message}</div>
              <div className="inline-actions" style={{ justifyContent: "flex-start" }}>
                <Link className="button small" href={`/status/${result.orderNo}`}>
                  打开独立状态页
                </Link>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
