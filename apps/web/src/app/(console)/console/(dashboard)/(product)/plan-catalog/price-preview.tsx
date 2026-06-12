"use client";

// 「实时算价预览」(spec §7 表单⑤)。改任一格 → 按 computePurchase(与后端同口径,
// 复用 buy-page 的 catalog-pricing.ts)算几个代表组合即时显示。
//
// 代表组合(基于当前表单派生的 config):
//   号池:每个启用产品 × 小用量 × 1 设备;首启用产品 × 大用量 × 1 设备。
//   绑定:每个启用产品取其首个等级 × 1 人独号 × 1 设备。
// computePurchase 在无效选择(无产品 / 等级无价)时抛错 —— 捕获后跳过该行,不崩。

import { useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import { formatPriceCents } from "@/lib/account/format-extensions";
import { computePurchase, type CatalogConfig } from "@/lib/account/catalog-pricing";
import { formToConfig, type PlanCatalogForm } from "@/lib/console/plan-catalog-form";
import { productLabel } from "./catalog-defaults";

interface PreviewRow {
  label: string;
  priceCents: number;
}

function tierLabel(key: string): string {
  if (key === "small") return "小用量";
  if (key === "large") return "大用量";
  return key;
}

/** 安全计价:无效选择返回 null(不抛)。 */
function priceOf(
  config: CatalogConfig,
  selection: Parameters<typeof computePurchase>[1],
): number | null {
  try {
    return computePurchase(config, selection).priceCents;
  } catch {
    return null;
  }
}

function buildRows(config: CatalogConfig): PreviewRow[] {
  const rows: PreviewRow[] = [];
  const products = config.products ?? [];
  const tierKeys = Object.keys(config.usageTiers ?? {});
  const firstTier = tierKeys[0];
  const largeTier = tierKeys.includes("large") ? "large" : tierKeys[1];

  // 号池:每产品 × 首个用量档 × 1 设备。
  for (const product of products) {
    if (!firstTier) break;
    const price = priceOf(config, {
      line: "pool",
      products: [product],
      usageTier: firstTier,
      deviceLimit: 1,
    });
    if (price !== null) {
      rows.push({
        label: `号池 · ${productLabel(product)} · ${tierLabel(firstTier)} · 1 设备`,
        priceCents: price,
      });
    }
  }

  // 号池:首产品 × 大用量(若存在且与首档不同)× 1 设备。
  if (products[0] && largeTier && largeTier !== firstTier) {
    const price = priceOf(config, {
      line: "pool",
      products: [products[0]],
      usageTier: largeTier,
      deviceLimit: 1,
    });
    if (price !== null) {
      rows.push({
        label: `号池 · ${productLabel(products[0])} · ${tierLabel(largeTier)} · 1 设备`,
        priceCents: price,
      });
    }
  }

  // 绑定:每产品取首个等级 × 1 人独号 × 1 设备。
  for (const product of products) {
    const level = config.levels?.[product]?.[0];
    if (!level) continue;
    const price = priceOf(config, {
      line: "bind",
      items: [{ product, level }],
      shareUsers: 1,
      deviceLimit: 1,
    });
    if (price !== null) {
      rows.push({
        label: `绑定 · ${productLabel(product)} · ${level} · 1 人独号`,
        priceCents: price,
      });
    }
  }

  return rows;
}

export function PricePreview({ form }: { form: PlanCatalogForm }) {
  // 表单 → config → 代表组合价。form 变即重算(useMemo 依赖整 form)。
  const rows = useMemo(() => {
    try {
      return buildRows(formToConfig(form));
    } catch {
      return [];
    }
  }, [form]);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        按当前编辑值实时计算(与购买页 / 后端同口径)。仅供预览,不影响线上。
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          配置完整后这里会显示几个代表套餐的价格。
        </p>
      ) : (
        <div className="flex flex-col divide-y rounded-lg border">
          {rows.map((row) => (
            <div
              key={row.label}
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <span className="text-xs text-muted-foreground">{row.label}</span>
              <Badge variant="secondary" className="font-mono text-xs">
                {formatPriceCents(row.priceCents)}
              </Badge>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
