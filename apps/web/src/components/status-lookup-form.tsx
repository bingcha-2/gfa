"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { normalizeRedeemCode } from "../lib/public-orders";

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
  const label = kind === "code" ? "输入卡密" : "输入订单号";
  const placeholder =
    kind === "code" ? "例如 ABCD1234EFGH5678" : "例如 GFA-MA3L7Q-9K2W";
  const helperText =
    kind === "code"
      ? "当前公开查询会直接按卡密读取订单状态，支持跨浏览器和跨设备查询。"
      : "订单号在提交卡密成功后返回，复制完整号码即可查询。";

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
            ? "查询中..."
            : buttonLabel ?? (kind === "code" ? "按卡密查询进度" : "查询订单状态")}
        </button>
      </div>
    </form>
  );
}
