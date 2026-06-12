"use client";

// 「定价」区块(spec §5 / §7 表单③),元为单位。两 tab:
//   - 号池:每产品基础价 + 用量(小/大)加价 + 每台设备加价。
//   - 绑定:产品 × 等级 价格矩阵 + 共享人数(1/2/4/8)折扣 + 每台设备加价。
// 受控:pool / bind 两块各自 onChange 回传整块新对象(上层合并)。等级矩阵的行/列
//   随产品行与其等级列表派生 —— 故只对「启用且有等级」的产品渲染绑定价行。

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";

import { YuanInput } from "./form-bits";
import { productLabel } from "./catalog-defaults";
import { SHARE_USERS } from "@/lib/console/plan-catalog-form";
import type {
  BindPricingForm,
  PoolPricingForm,
  ProductRow,
  UsageTierRow,
} from "@/lib/console/plan-catalog-form";

function tierLabel(key: string): string {
  if (key === "small") return "小用量";
  if (key === "large") return "大用量";
  return key;
}

function shareLabel(n: number): string {
  return n === 1 ? "1 人独号" : `${n} 人拼车`;
}

export interface PricingSectionProps {
  products: ProductRow[];
  usageTiers: UsageTierRow[];
  pool: PoolPricingForm;
  bind: BindPricingForm;
  onPoolChange: (next: PoolPricingForm) => void;
  onBindChange: (next: BindPricingForm) => void;
  disabled?: boolean;
}

export function PricingSection({
  products,
  usageTiers,
  pool,
  bind,
  onPoolChange,
  onBindChange,
  disabled,
}: PricingSectionProps) {
  const enabled = products.filter((p) => p.enabled);

  return (
    <Tabs defaultValue="pool" className="gap-4">
      <TabsList>
        <TabsTrigger value="pool">号池线</TabsTrigger>
        <TabsTrigger value="bind">绑定线</TabsTrigger>
      </TabsList>

      {/* ── 号池线 ─────────────────────────────────────────────────────────── */}
      <TabsContent value="pool" className="flex flex-col gap-4">
        <PriceGroup title="每产品基础价">
          {enabled.length === 0 ? (
            <EmptyHint />
          ) : (
            enabled.map((row) => (
              <PriceRow key={row.product} label={productLabel(row.product)}>
                <YuanInput
                  className="w-32"
                  value={pool.product[row.product] ?? ""}
                  onChange={(v) =>
                    onPoolChange({ ...pool, product: { ...pool.product, [row.product]: v } })
                  }
                  disabled={disabled}
                  aria-label={`号池 ${productLabel(row.product)} 价`}
                />
              </PriceRow>
            ))
          )}
        </PriceGroup>

        <Separator />
        <PriceGroup title="用量加价">
          {usageTiers.map((tier) => (
            <PriceRow key={tier.key} label={tierLabel(tier.key)}>
              <YuanInput
                className="w-32"
                value={pool.usage[tier.key] ?? ""}
                onChange={(v) =>
                  onPoolChange({ ...pool, usage: { ...pool.usage, [tier.key]: v } })
                }
                disabled={disabled}
                aria-label={`号池 ${tierLabel(tier.key)} 加价`}
              />
            </PriceRow>
          ))}
        </PriceGroup>

        <Separator />
        <PriceGroup title="设备">
          <PriceRow label="每多一台设备">
            <YuanInput
              className="w-32"
              value={pool.devicePerExtra}
              onChange={(v) => onPoolChange({ ...pool, devicePerExtra: v })}
              disabled={disabled}
              aria-label="号池每台设备加价"
            />
          </PriceRow>
        </PriceGroup>
      </TabsContent>

      {/* ── 绑定线 ─────────────────────────────────────────────────────────── */}
      <TabsContent value="bind" className="flex flex-col gap-4">
        <PriceGroup title="等级价矩阵(产品 × 等级)">
          {enabled.length === 0 ? (
            <EmptyHint />
          ) : (
            enabled.map((row) => (
              <div key={row.product} className="rounded-lg border p-3">
                <div className="mb-2 text-sm font-medium">{productLabel(row.product)}</div>
                {row.levels.length === 0 ? (
                  <p className="text-xs text-amber-600 dark:text-amber-500">
                    该产品无等级,请先在「产品与等级」添加。
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
                          aria-label={`绑定 ${productLabel(row.product)} ${level} 价`}
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
        <PriceGroup title="共享人数折扣(通常为负)">
          {SHARE_USERS.map((n) => (
            <PriceRow key={n} label={shareLabel(n)}>
              <YuanInput
                className="w-32"
                value={bind.share[String(n)] ?? ""}
                onChange={(v) =>
                  onBindChange({ ...bind, share: { ...bind.share, [String(n)]: v } })
                }
                disabled={disabled}
                allowNegative
                aria-label={`绑定 ${shareLabel(n)} 折扣`}
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
      </TabsContent>
    </Tabs>
  );
}

// ── 小型展示件 ─────────────────────────────────────────────────────────────────

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
      请先在「产品与等级」启用至少一个产品。
    </p>
  );
}
