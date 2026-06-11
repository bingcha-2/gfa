"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { bindCard, UserApiError } from "@/lib/user-api";
import type { BindCardResult } from "@/lib/user-types";
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
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="space-y-3">
        <Field>
          <FieldLabel>{t.cardKeyLabel}</FieldLabel>
          <Input
            className="font-mono"
            placeholder={t.cardKeyPlaceholder}
            value={cardKey}
            onChange={(e) => setCardKey(e.target.value)}
            required
            disabled={pending}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        {error && <FieldError>{error}</FieldError>}

        <Button type="submit" disabled={pending || !cardKey.trim()}>
          {pending ? t.binding : t.bindSubmit}
        </Button>
      </form>

      {result && sub && (
        <div className="rounded-lg border bg-muted/30 p-4 space-y-2 text-sm">
          <div className="font-medium">
            {result.alreadyBound ? t.bindAlreadyBound : t.bindSuccessTitle}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {sub.products.map((p) => (
              <Badge key={p} variant="secondary">
                {p}
              </Badge>
            ))}
          </div>
          <div className="grid gap-1 text-muted-foreground">
            <span>
              {t.expiresLabel}:{" "}
              <span className="tabular-nums text-foreground">
                {sub.expiresAt ? formatDateTime(sub.expiresAt) : t.neverExpires}
              </span>
            </span>
            <span>
              {t.deviceLimitLabel}:{" "}
              <span className="tabular-nums text-foreground">
                {fmt(t.deviceLimitValue, { n: sub.deviceLimit })}
              </span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
