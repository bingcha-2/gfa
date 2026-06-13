"use client";

// 「实时算价预览」(spec §7 表单⑤)—— 和客户端购买页(CatalogPurchase)同款交互:
// 运营在右栏像客户一样点选「号池线 / 绑定线」的产品、用量档、等级、共享人数、设备数,
// 实时看「任意」组合的价格,而不是只看几个固定代表组合。
//
// 同口径:计价复用 buy-page 的 computePurchase(与后端 pricing.ts 字节对齐);配置取
// 「当前编辑中(未保存)」的表单 formToConfig(form),故改定价 / 等级即时反映。仅供预览,
// 不影响线上(线上读已发布版)。
//
// 与购买页的差异:① 无结算 / 下单,纯试算;② UI 用 console 自身 chip 风格(非 account
// 门户 CSS / i18n);③ 选项随表单编辑动态变化 —— 选中项可能引用「已停用产品 / 已删等级
// 或用量档」,故对失效选择做「纯派生兜底」(不写回 state):失效则从价格里剔除 / 回退首档,
// 表单改回来时选择自动恢复。

import { useMemo, useState } from "react";

import { formatPriceCents } from "@/lib/account/format-extensions";
import {
  computePurchase,
  type CatalogConfig,
  type Selection,
} from "@/lib/account/catalog-pricing";
import {
  formToConfig,
  SHARE_USERS,
  type PlanCatalogForm,
} from "@/lib/console/plan-catalog-form";
import { cn } from "@/lib/utils";
import { productLabel } from "./catalog-defaults";

type Line = "pool" | "bind";

const MAX_DEVICES = 20;

function tierLabel(key: string): string {
  if (key === "small") return "小用量";
  if (key === "large") return "大用量";
  return key;
}

function shareLabel(n: number): string {
  return n === 1 ? "1 人独号" : `${n} 人共享`;
}

/** chip / pill 统一样式(对齐 products-section 的等级 chip)。 */
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
  // 当前编辑值 → config(与购买页 / 后端同结构)。表单变即重算。
  const config = useMemo<CatalogConfig>(() => formToConfig(form), [form]);
  const products = config.products; // 仅启用产品(formToConfig 已过滤)。
  const tierKeys = useMemo(() => Object.keys(config.usageTiers), [config]);

  const [line, setLine] = useState<Line>("pool");

  // ── 号池线选择(首产品 + 首档预选,进页面即有一个非空价)──────────────────────────
  const [poolProducts, setPoolProducts] = useState<string[]>(() =>
    products[0] ? [products[0]] : [],
  );
  const [usageTier, setUsageTier] = useState<string>(() => tierKeys[0] ?? "");
  const [poolDevices, setPoolDevices] = useState(1);

  // ── 绑定线选择:product → 选中等级(不在表里 = 该产品未选)────────────────────────
  const [bindLevels, setBindLevels] = useState<Record<string, string>>({});
  const [shareUsers, setShareUsers] = useState(1);
  const [bindDevices, setBindDevices] = useState(1);

  // ── 失效兜底(纯派生,不写回 state)──────────────────────────────────────────────
  const effTier = tierKeys.includes(usageTier) ? usageTier : tierKeys[0] ?? "";
  const effPoolProducts = poolProducts.filter((p) => products.includes(p));
  // 绑定项:仅启用产品 & 该产品仍有等级;选中等级失效则回退该产品首档。
  const effBindItems = products
    .filter((p) => p in bindLevels)
    .map((p) => {
      const levels = config.levels[p] ?? [];
      const stored = bindLevels[p];
      const level = levels.includes(stored) ? stored : levels[0];
      return level ? { product: p, level } : null;
    })
    .filter((x): x is { product: string; level: string } => x !== null);

  // ── 当前组合 → 价格(computePurchase 在空选 / 失效时抛错 → 视为「未就绪」)─────────
  const selection: Selection =
    line === "pool"
      ? { line: "pool", products: effPoolProducts, usageTier: effTier, deviceLimit: poolDevices }
      : { line: "bind", items: effBindItems, shareUsers, deviceLimit: bindDevices };

  let priced: { priceCents: number } | null = null;
  try {
    const ready =
      line === "pool"
        ? effPoolProducts.length > 0 && !!effTier
        : effBindItems.length > 0;
    if (ready) priced = computePurchase(config, selection);
  } catch {
    priced = null;
  }

  // 当前组合的人类摘要(展示在价格上方)。
  const summary =
    line === "pool"
      ? effPoolProducts.length
        ? `号池 · ${effPoolProducts.map(productLabel).join(" + ")} · ${tierLabel(effTier)} · ${poolDevices} 设备`
        : null
      : effBindItems.length
        ? `绑定 · ${effBindItems.map((i) => `${productLabel(i.product)} ${i.level}`).join(" + ")} · ${shareLabel(shareUsers)} · ${bindDevices} 设备`
        : null;

  function togglePoolProduct(p: string) {
    setPoolProducts((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
    );
  }

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

  const emptyHint = line === "pool" ? "请至少选择一个产品" : "请为选中的产品各选一个等级";

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        像客户端一样选配,实时看任意组合的价格(与购买页 / 后端同口径)。仅供预览,不影响线上。
      </p>

      {products.length === 0 ? (
        <p className="text-sm text-muted-foreground">启用并配置产品后,可在此像客户端一样试算价格。</p>
      ) : (
        <>
          {/* 线切换 */}
          <div className="grid grid-cols-2 gap-1 rounded-lg border p-1" role="tablist" aria-label="计价线">
            {(["pool", "bind"] as const).map((l) => (
              <button
                key={l}
                type="button"
                role="tab"
                aria-selected={line === l}
                onClick={() => setLine(l)}
                className={cn(
                  "rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                  line === l ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
                )}
              >
                {l === "pool" ? "号池线" : "绑定线"}
              </button>
            ))}
          </div>

          {/* ── 号池线 ───────────────────────────────────────────────────────────── */}
          {line === "pool" && (
            <div className="flex flex-col gap-3" role="tabpanel">
              <Field label="产品" hint="可多选,叠加">
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="产品">
                  {products.map((p) => (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={poolProducts.includes(p)}
                      onClick={() => togglePoolProduct(p)}
                      className={chipCls(poolProducts.includes(p))}
                    >
                      {productLabel(p)}
                    </button>
                  ))}
                </div>
              </Field>

              <Field label="用量档">
                {tierKeys.length === 0 ? (
                  <p className="text-xs text-amber-600 dark:text-amber-500">未配置用量档。</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="用量档">
                    {tierKeys.map((key) => (
                      <button
                        key={key}
                        type="button"
                        role="radio"
                        aria-checked={effTier === key}
                        onClick={() => setUsageTier(key)}
                        className={chipCls(effTier === key)}
                      >
                        {tierLabel(key)}
                      </button>
                    ))}
                  </div>
                )}
              </Field>

              <Field label="设备">
                <Stepper value={poolDevices} onChange={setPoolDevices} />
              </Field>
            </div>
          )}

          {/* ── 绑定线 ───────────────────────────────────────────────────────────── */}
          {line === "bind" && (
            <div className="flex flex-col gap-3" role="tabpanel">
              <Field label="产品 / 等级" hint="选产品再选等级">
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

              <Field label="共享人数">
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="共享人数">
                  {SHARE_USERS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={shareUsers === n}
                      onClick={() => setShareUsers(n)}
                      className={chipCls(shareUsers === n)}
                    >
                      {shareLabel(n)}
                    </button>
                  ))}
                </div>
              </Field>

              <Field label="设备">
                <Stepper value={bindDevices} onChange={setBindDevices} />
              </Field>
            </div>
          )}

          {/* ── 价格读数 ─────────────────────────────────────────────────────────── */}
          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="min-h-4 text-[11px] text-muted-foreground">{summary ?? emptyHint}</div>
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

// ── 小型展示件 ───────────────────────────────────────────────────────────────────

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
        −
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
