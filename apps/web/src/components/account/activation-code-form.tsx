"use client";

import { useState } from "react";
import { toast } from "sonner";

import { AccountButton, AccountInput, AccountPill } from "./account-ui";
import { activateCode, UserApiError } from "@/lib/account/user-api";
import type { ActivateCodeResult } from "@/lib/account/user-types";
import { formatDateTime } from "@/lib/format";
import { fmt } from "@/lib/i18n";
import { useDict } from "@/lib/i18n/client";

// 后端激活码错误码 → 复用既有 billing.bindErrors 文案键(避免改动 8 套词典的结构)。
// 座位不足等未列出的码 → fallback。
const CODE_TO_DICT: Record<string, "CARD_NOT_FOUND" | "CARD_DISABLED" | "CARD_ALREADY_BOUND"> = {
  CODE_NOT_FOUND: "CARD_NOT_FOUND",
  CODE_DISABLED: "CARD_DISABLED",
  CODE_ALREADY_USED: "CARD_ALREADY_BOUND",
};

export function ActivationCodeForm({ onActivated }: { onActivated?: () => void }) {
  const dict = useDict();
  const t = dict.portalApp.billing;

  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ActivateCodeResult | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return; // one-shot guard
    setError(null);
    setResult(null);
    setPending(true);
    try {
      const res = await activateCode(code.trim());
      setResult(res);
      if (!res.alreadyActivated) {
        toast.success(t.bindSuccessToast);
        onActivated?.();
      }
      setCode("");
    } catch (err) {
      if (err instanceof UserApiError && err.code && CODE_TO_DICT[err.code]) {
        setError(t.bindErrors[CODE_TO_DICT[err.code]]);
      } else if (err instanceof UserApiError && err.message) {
        // 座位不足 / 目录非法等带可读信息的 BadRequest:直接展示后端消息。
        setError(err.message);
      } else {
        setError(t.bindErrors.fallback);
      }
    } finally {
      setPending(false);
    }
  }

  const sub = result?.subscription;

  return (
    <div className="account-bind-card">
      <form onSubmit={handleSubmit} className="account-bind-card__form">
        <AccountInput
          label={t.cardKeyLabel}
          className="account-input--mono"
          placeholder={t.cardKeyPlaceholder}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
          disabled={pending}
          autoComplete="off"
          spellCheck={false}
        />

        {error && <p className="account-field__error">{error}</p>}

        <AccountButton type="submit" disabled={pending || !code.trim()}>
          {pending ? t.binding : t.bindSubmit}
        </AccountButton>
      </form>

      {result && sub && (
        <div className="account-bind-card__result">
          <div className="account-bind-card__result-title">
            {result.alreadyActivated ? t.bindAlreadyBound : t.bindSuccessTitle}
          </div>
          <div className="account-bind-card__products">
            {sub.products.map((p) => (
              <AccountPill key={p} tone="info">{p}</AccountPill>
            ))}
          </div>
          <div className="account-bind-card__meta">
            <span>
              {t.expiresLabel}:{" "}
              <strong>
                {sub.expiresAt ? formatDateTime(sub.expiresAt) : t.neverExpires}
              </strong>
            </span>
            <span>
              {t.deviceLimitLabel}:{" "}
              <strong>{fmt(t.deviceLimitValue, { n: sub.deviceLimit })}</strong>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
