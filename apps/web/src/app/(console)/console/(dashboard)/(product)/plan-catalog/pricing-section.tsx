"use client";

import { Separator } from "@/components/ui/separator";

import { NumberInput, YuanInput } from "./form-bits";
import { productLabel } from "./catalog-defaults";
import { QuotaReferencePanel } from "./quota-reference-panel";
import type {
  BindPricingForm,
  ProductRow,
} from "@/lib/console/plan-catalog-form";

const SEAT_OPTIONS = [1, 2, 4, 8] as const;

function seatLabel(n: number): string {
  return `${n}/8 席`;
}

export interface PricingSectionProps {
  products: ProductRow[];
  bind: BindPricingForm;
  oversellFactor?: string;
  onBindChange: (next: BindPricingForm) => void;
  disabled?: boolean;
}

export function PricingSection({
  products,
  bind,
  oversellFactor,
  onBindChange,
  disabled,
}: PricingSectionProps) {
  const enabled = products.filter((p) => p.enabled);

  return (
    <div className="flex flex-col gap-4">
      <QuotaReferencePanel oversellFactor={oversellFactor} />

      <PriceGroup title="等级价格与每份美元额度">
        <p className="text-xs text-muted-foreground">
          订阅总额度 = 每份额度 × 购买份数。超卖比例只控制最大可售份数，不会摊薄个人额度。
        </p>
        {enabled.length === 0 ? (
          <EmptyHint />
        ) : (
          enabled.map((row) => (
            <div key={row.product} className="rounded-lg border p-3">
              <div className="mb-2 text-sm font-medium">{productLabel(row.product)}</div>
              {row.levels.length === 0 ? (
                <p className="text-xs text-amber-600 dark:text-amber-500">
                  该产品无等级,请先在“产品与等级”添加。
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="grid grid-cols-[minmax(7rem,1fr)_7rem_7rem_7rem] gap-2 text-[11px] text-muted-foreground">
                    <span>等级</span>
                    <span>价格</span>
                    <span>每份 · 5 小时</span>
                    <span>每份 · 周</span>
                  </div>
                  {row.levels.map((level) => (
                    <div key={level} className="grid grid-cols-[minmax(7rem,1fr)_7rem_7rem_7rem] items-center gap-2">
                      <span className="font-mono text-xs">{level}</span>
                      <YuanInput
                        className="w-28"
                        value={bind.levelPrice[row.product]?.[level] ?? ""}
                        onChange={(v) =>
                          onBindChange({
                            ...bind,
                            levelPrice: {
                              ...bind.levelPrice,
                              [row.product]: {
                                ...(bind.levelPrice[row.product] ?? {}),
                                [level]: v,
                              },
                            },
                          })
                        }
                        disabled={disabled}
                        aria-label={`绑定 ${productLabel(row.product)} ${level} 价格`}
                      />
                      {supportsUsdQuota(row.product) ? (
                        <>
                          <NumberInput
                            className="w-28"
                            value={bind.usdQuotaPerSeat?.[row.product]?.[level]?.fiveHour ?? ""}
                            onChange={(v) => onBindChange(updateUsdQuota(bind, row.product, level, "fiveHour", v))}
                            disabled={disabled}
                            suffix="$ / 5h"
                            aria-label={`${productLabel(row.product)} ${level} 每份 5 小时美元额度`}
                          />
                          <NumberInput
                            className="w-28"
                            value={bind.usdQuotaPerSeat?.[row.product]?.[level]?.weekly ?? ""}
                            onChange={(v) => onBindChange(updateUsdQuota(bind, row.product, level, "weekly", v))}
                            disabled={disabled}
                            suffix="$ / 周"
                            aria-label={`${productLabel(row.product)} ${level} 每份每周美元额度`}
                          />
                        </>
                      ) : (
                        <span className="col-span-2 text-xs text-muted-foreground">沿用产品固定额度</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </PriceGroup>

      <Separator />
      <PriceGroup title="席位折扣(按购买席位数,通常为负)">
        {SEAT_OPTIONS.map((n) => (
          <PriceRow key={n} label={seatLabel(n)}>
            <YuanInput
              className="w-32"
              value={bind.share[String(n)] ?? ""}
              onChange={(v) =>
                onBindChange({ ...bind, share: { ...bind.share, [String(n)]: v } })
              }
              disabled={disabled}
              allowNegative
              aria-label={`绑定 ${seatLabel(n)} 折扣`}
            />
          </PriceRow>
        ))}
      </PriceGroup>

      <Separator />
      <PriceGroup title="设备">
        <PriceRow label="每多一台设备">
          <YuanInput
            className="w-32"
            value={bind.devicePerExtra}
            onChange={(v) => onBindChange({ ...bind, devicePerExtra: v })}
            disabled={disabled}
            aria-label="绑定每台设备加价"
          />
        </PriceRow>
      </PriceGroup>
    </div>
  );
}

function supportsUsdQuota(product: string): boolean {
  return product === "codex" || product === "anthropic";
}

function updateUsdQuota(
  bind: BindPricingForm,
  product: string,
  level: string,
  field: "fiveHour" | "weekly",
  value: string,
): BindPricingForm {
  const current = bind.usdQuotaPerSeat?.[product]?.[level] ?? { fiveHour: "", weekly: "" };
  return {
    ...bind,
    usdQuotaPerSeat: {
      ...(bind.usdQuotaPerSeat ?? {}),
      [product]: {
        ...(bind.usdQuotaPerSeat?.[product] ?? {}),
        [level]: { ...current, [field]: value },
      },
    },
  };
}

function PriceGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function PriceRow({
  label,
  mono,
  children,
}: {
  label: string;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className={mono ? "font-mono text-xs" : "text-sm"}>{label}</span>
      {children}
    </div>
  );
}

function EmptyHint() {
  return (
    <p className="text-xs text-muted-foreground">
      请先在“产品与等级”启用至少一个产品。
    </p>
  );
}
