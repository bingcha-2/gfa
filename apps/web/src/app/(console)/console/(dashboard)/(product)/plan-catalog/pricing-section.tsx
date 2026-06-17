"use client";

import { Separator } from "@/components/ui/separator";

import { YuanInput } from "./form-bits";
import { productLabel } from "./catalog-defaults";
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
  onBindChange: (next: BindPricingForm) => void;
  disabled?: boolean;
}

export function PricingSection({
  products,
  bind,
  onBindChange,
  disabled,
}: PricingSectionProps) {
  const enabled = products.filter((p) => p.enabled);

  return (
    <div className="flex flex-col gap-4">
      <PriceGroup title="等级价格矩阵(产品 x 等级)">
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
                  {row.levels.map((level) => (
                    <PriceRow key={level} label={level} mono>
                      <YuanInput
                        className="w-32"
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
                    </PriceRow>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </PriceGroup>

      <Separator />
      <PriceGroup title="席位折扣(通常为负)">
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
