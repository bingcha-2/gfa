"use client";

import { useState } from "react";
import { toast } from "sonner";

import { AccountButton, AccountInput, AccountPill } from "./account-ui";
import { bindCard, UserApiError } from "@/lib/account/user-api";
import type { BindCardResult } from "@/lib/account/user-types";
import { formatDateTime } from "@/lib/format";
import { fmt } from "@/lib/i18n";
import { useDict } from "@/lib/i18n/client";

const KNOWN_CODES = [
  "CARD_NOT_FOUND",
  "CARD_DISABLED",
  "CARD_EXPIRED",
  "CARD_ALREADY_BOUND",
] as const;

type KnownCode = (typeof KNOWN_CODES)[number];

export function BindCardForm({ onBound }: { onBound?: () => void }) {
  const dict = useDict();
  const t = dict.portalApp.billing;

  const [cardKey, setCardKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BindCardResult | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return; // one-shot guard
    setError(null);
    setResult(null);
    setPending(true);
    try {
      const res = await bindCard(cardKey.trim());
      setResult(res);
      if (!res.alreadyBound) {
        toast.success(t.bindSuccessToast);
        onBound?.();
      }
      setCardKey("");
    } catch (err) {
      if (
        err instanceof UserApiError &&
        err.code &&
        (KNOWN_CODES as readonly string[]).includes(err.code)
      ) {
        setError(t.bindErrors[err.code as KnownCode]);
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
          value={cardKey}
          onChange={(e) => setCardKey(e.target.value)}
          required
          disabled={pending}
          autoComplete="off"
          spellCheck={false}
        />

        {error && <p className="account-field__error">{error}</p>}

        <AccountButton type="submit" disabled={pending || !cardKey.trim()}>
          {pending ? t.binding : t.bindSubmit}
        </AccountButton>
      </form>

      {result && sub && (
        <div className="account-bind-card__result">
          <div className="account-bind-card__result-title">
            {result.alreadyBound ? t.bindAlreadyBound : t.bindSuccessTitle}
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
