"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { normalizeRedeemCode } from "../lib/public-orders";
import { useDict } from "@/lib/i18n/client";

type StatusLookupFormProps = {
  compact?: boolean;
  kind?: "order" | "code";
  buttonLabel?: string;
  onLookup?: (value: string) => void | Promise<void>;
};

export function StatusLookupForm({
  compact = false,
  kind = "order",
  buttonLabel,
  onLookup
}: StatusLookupFormProps) {
  const t = useDict();
  const router = useRouter();
  const [value, setValue] = useState("");
  const [isPending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalized = normalizeRedeemCode(value);

    if (!normalized) {
      return;
    }

    if (onLookup) {
      startTransition(() => {
        void onLookup(normalized);
      });
      return;
    }

    router.push(`/status/${normalized}`);
  }

  const fieldId = compact ? `status-lookup-${kind}-compact` : `status-lookup-${kind}`;
  const label = kind === "code" ? t.lookupForm.codeLabel : t.lookupForm.orderLabel;
  const placeholder =
    kind === "code" ? t.lookupForm.codePlaceholder : t.lookupForm.orderPlaceholder;
  const helperText =
    kind === "code" ? t.lookupForm.codeHelper : t.lookupForm.orderHelper;

  return (
    <form className="field-grid" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor={fieldId}>{label}</label>
        <input
          id={fieldId}
          className="mono"
          placeholder={placeholder}
          required
          value={value}
          onChange={(event) => setValue(event.target.value.toUpperCase())}
        />
        <small>{helperText}</small>
      </div>

      <div className="field-actions">
        <button className="button" disabled={isPending} type="submit">
          {isPending
            ? t.lookupForm.searching
            : buttonLabel ?? (kind === "code" ? t.lookupForm.searchByCode : t.lookupForm.searchByOrder)}
        </button>
      </div>
    </form>
  );
}
