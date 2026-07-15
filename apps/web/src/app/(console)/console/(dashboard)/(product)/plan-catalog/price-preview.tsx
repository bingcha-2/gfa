"use client";

import { useMemo, useState } from "react";

import { formatPriceCents } from "@/lib/account/format-extensions";
import {
  computePurchase,
  type CatalogConfig,
  type Selection,
} from "@/lib/account/catalog-pricing";
import { formToConfig, type PlanCatalogForm } from "@/lib/console/plan-catalog-form";
import { cn } from "@/lib/utils";
import { productLabel } from "./catalog-defaults";

const SEAT_OPTIONS = [1, 2, 4, 8] as const;
const MAX_DEVICES = 20;
const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 6,
});

function chipCls(active: boolean): string {
  return cn(
    "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
    "disabled:pointer-events-none disabled:opacity-50",
    active
      ? "border-primary bg-primary/10 text-foreground"
      : "bg-muted/40 text-muted-foreground hover:bg-muted",
  );
}

export function PricePreview({ form }: { form: PlanCatalogForm }) {
  const config = useMemo<CatalogConfig>(() => formToConfig(form), [form]);
  const products = config.products;
  const shareCapacity = config.shareCapacity ?? 8;
  const seatOptions = useMemo(
    () => SEAT_OPTIONS.filter((n) => n <= shareCapacity),
    [shareCapacity],
  );

  const [bindLevels, setBindLevels] = useState<Record<string, string>>({});
  const [shareSeats, setShareSeats] = useState(1);
  const [deviceLimit, setDeviceLimit] = useState(1);

  const effBindItems = products
    .filter((p) => p in bindLevels)
    .map((p) => {
      const levels = config.levels[p] ?? [];
      const stored = bindLevels[p];
      const level = levels.includes(stored) ? stored : levels[0];
      return level ? { product: p, level } : null;
    })
    .filter((x): x is { product: string; level: string } => x !== null);

  const selection: Selection = {
    line: "bind",
    items: effBindItems,
    shareSeats,
    deviceLimit,
  };

  let priced: ReturnType<typeof computePurchase> | null = null;
  try {
    if (effBindItems.length > 0) priced = computePurchase(config, selection);
  } catch {
    priced = null;
  }

  const summary = effBindItems.length
    ? `绑定 · ${effBindItems.map((i) => `${productLabel(i.product)} ${i.level}`).join(" + ")} · ${shareSeats}/${shareCapacity} 席 · ${deviceLimit} 设备`
    : null;
  const quotaRows = configuredQuotaRows(priced, effBindItems);

  function toggleBindProduct(p: string) {
    setBindLevels((prev) => {
      if (p in prev) {
        const next = { ...prev };
        delete next[p];
        return next;
      }
      const first = config.levels[p]?.[0];
      return first ? { ...prev, [p]: first } : prev;
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        按客户购买页的统一绑定线口径试算价格。仅用于预览,不影响线上发布版本。
      </p>

      {products.length === 0 ? (
        <p className="text-sm text-muted-foreground">启用并配置产品后,可在这里试算价格。</p>
      ) : (
        <>
          <div className="flex flex-col gap-3" role="tabpanel">
            <Field label="产品 / 等级" hint="选产品后再选等级">
              <div className="flex flex-col gap-2">
                {products.map((p) => {
                  const selected = p in bindLevels;
                  const levels = config.levels[p] ?? [];
                  const effLevel = levels.includes(bindLevels[p]) ? bindLevels[p] : levels[0];
                  return (
                    <div key={p} className="flex flex-col gap-1.5">
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => toggleBindProduct(p)}
                        disabled={levels.length === 0}
                        title={levels.length === 0 ? "该产品未配置等级" : undefined}
                        className={cn(chipCls(selected), "self-start")}
                      >
                        {productLabel(p)}
                      </button>
                      {selected && levels.length > 0 && (
                        <div
                          className="flex flex-wrap gap-1.5 pl-1"
                          role="radiogroup"
                          aria-label={`${productLabel(p)} 等级`}
                        >
                          {levels.map((level) => (
                            <button
                              key={level}
                              type="button"
                              role="radio"
                              aria-checked={effLevel === level}
                              onClick={() => setBindLevels((prev) => ({ ...prev, [p]: level }))}
                              className={chipCls(effLevel === level)}
                            >
                              {level}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Field>

            <Field label="购买席位">
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="购买席位">
                {seatOptions.map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={shareSeats === n}
                    onClick={() => setShareSeats(n)}
                    className={chipCls(shareSeats === n)}
                  >
                    {n}/{shareCapacity} 席
                  </button>
                ))}
              </div>
            </Field>

            <Field label="设备">
              <Stepper value={deviceLimit} onChange={setDeviceLimit} />
            </Field>
          </div>

          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="min-h-4 text-[11px] text-muted-foreground">
              {summary ?? "请为选中的产品各选一个等级"}
            </div>
            {quotaRows.length > 0 && (
              <div className="mt-2 border-y py-2" data-testid="preview-usd-quota">
                <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground">配置额度</span>
                  <span>{shareSeats} 份合计</span>
                </div>
                <div className="space-y-1">
                  {quotaRows.map((row) => (
                    <div key={row.product} className="flex items-center justify-between gap-3 text-[11px]">
                      <span className="font-medium">{productLabel(row.product)}</span>
                      <span className="text-right font-mono tabular-nums text-muted-foreground">
                        5 小时 {row.fiveHour > 0 ? formatUsd(row.fiveHour) : "未启用"}
                        <span aria-hidden="true"> · </span>
                        每周 {row.weekly > 0 ? formatUsd(row.weekly) : "未启用"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-1 flex items-baseline justify-between gap-2">
              <span className="text-xs text-muted-foreground">合计</span>
              <span className="font-mono text-lg font-semibold tabular-nums" data-testid="preview-total">
                {priced ? formatPriceCents(priced.priceCents) : "—"}
              </span>
            </div>
            <div className="text-right text-[11px] text-muted-foreground">/ {config.durationDays} 天</div>
          </div>
        </>
      )}
    </div>
  );
}

function configuredQuotaRows(
  priced: ReturnType<typeof computePurchase> | null,
  items: Array<{ product: string; level: string }>,
): Array<{ product: string; fiveHour: number; weekly: number }> {
  const raw = priced?.config?.usdQuotaByProduct;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const quotas = raw as Record<string, unknown>;
  return items.flatMap(({ product }) => {
    const value = quotas[product];
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const quota = value as Record<string, unknown>;
    const fiveHour = nonNegativeAmount(quota.fiveHour);
    const weekly = nonNegativeAmount(quota.weekly);
    if (fiveHour <= 0 && weekly <= 0) return [];
    return [{ product, fiveHour, weekly }];
  });
}

function nonNegativeAmount(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function formatUsd(value: number): string {
  return USD_FORMATTER.format(value);
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium">{label}</span>
        {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Stepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const btn =
    "inline-flex size-7 items-center justify-center rounded-md border text-sm transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50";
  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        aria-label="减少"
        disabled={value <= 1}
        onClick={() => onChange(Math.max(1, value - 1))}
        className={btn}
      >
        -
      </button>
      <span className="w-14 text-center text-xs tabular-nums" aria-live="polite">
        {value} 设备
      </span>
      <button
        type="button"
        aria-label="增加"
        disabled={value >= MAX_DEVICES}
        onClick={() => onChange(Math.min(MAX_DEVICES, value + 1))}
        className={btn}
      >
        +
      </button>
    </div>
  );
}
