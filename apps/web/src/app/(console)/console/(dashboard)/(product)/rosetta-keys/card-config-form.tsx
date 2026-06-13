"use client";

// 卡密配置表单(新增与编辑共用)—— 组合三块:
//   1. 基本:名称/备注 · 有效期(数值+单位)· 限流窗口(数值+单位,默认 5h)。
//   2. 产品与绑定:product-binding-manager(逐产品绑/换/解 + 卡级份额)。
//   3. 模型限额:model-limits-editor(逐桶 token 上限 + 一键全部 + 已用参考)。
// 完全受控:value(CardConfigValue)+ onChange(部分补丁)由父维护;accounts 供选号下拉。
// 当前可用模型桶随 bindings 实时推导(万能卡=全产品桶;绑定卡=已绑产品桶),
// 已用量(used)从父传入的 usageBuckets(编辑时来自 listAccessKeys 的 buckets)按桶键 join。

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GlobeIcon, LinkIcon } from "lucide-react";
import { ProductBindingManager } from "./product-binding-manager";
import { ModelLimitsEditor } from "./model-limits-editor";
import type {
  AccessKeyBucket,
  BindableAccount,
  CardConfigPatch,
  CardConfigValue,
  CardType,
} from "./types";

// 时间单位选项(有效期 / 限流窗口共用)。
const UNIT_ITEMS = [
  { label: "小时", value: "h" },
  { label: "天", value: "d" },
];

// ── 桶推导(对齐后端 product-bucket.ts 的 bucketsForProducts / bucketLabel)──
// 每产品暴露的复合桶键 "<product>-<family>"。antigravity 代理 Gemini+Claude;codex/anthropic 单家。
const FAMILIES_BY_PRODUCT: Record<string, string[]> = {
  antigravity: ["gemini", "claude"],
  codex: ["gpt"],
  anthropic: ["claude"],
};
// 产品/家族标签(与后端 productLabel/familyLabel 一致)。
const PRODUCT_LABELS: Record<string, string> = {
  antigravity: "Antigravity",
  codex: "Codex",
  anthropic: "Anthropic",
};
const FAMILY_LABELS: Record<string, string> = {
  gemini: "Gemini",
  claude: "Claude",
  gpt: "GPT",
};
// 产品枚举顺序(万能卡时列全部桶的顺序)。
const PRODUCTS_ORDER = ["antigravity", "codex", "anthropic"];

/** 复合桶键的人类标签,如 "Antigravity · Claude"。 */
function bucketLabel(bucket: string): string {
  const idx = bucket.indexOf("-");
  if (idx < 0) return PRODUCT_LABELS[bucket] || bucket;
  const product = bucket.slice(0, idx);
  const family = bucket.slice(idx + 1);
  const pl = PRODUCT_LABELS[product] || product;
  const fl = FAMILY_LABELS[family] || family;
  return `${pl} · ${fl}`;
}

/** 按卡类型推导可用桶键:万能卡=全产品桶;绑定卡=已绑产品桶,去重保序。
 *  注意:由显式 cardType 决定,不再用「bindings 是否为空」隐式判断。 */
function bucketsForType(cardType: CardType, bindings: Record<string, number>): string[] {
  const src =
    cardType === "bound"
      ? Object.keys(bindings).filter((p) => Number(bindings[p]) > 0)
      : PRODUCTS_ORDER;
  const out: string[] = [];
  for (const p of src) {
    for (const f of FAMILIES_BY_PRODUCT[p] || []) {
      const key = `${p}-${f}`;
      if (!out.includes(key)) out.push(key);
    }
  }
  return out;
}

export interface CardConfigFormProps {
  /** 受控值。 */
  value: CardConfigValue;
  /** 部分字段变更回传(父合并)。 */
  onChange: (patch: CardConfigPatch) => void;
  /** 可绑定账号(产品绑定下拉)。 */
  accounts: BindableAccount[];
  /** 编辑时的已用量(按桶键提供 used,用于模型限额行的「已用」参考)。新增时可省略。 */
  usageBuckets?: AccessKeyBucket[];
  /** 隐藏「卡类型」切换(创建向导第①步已选定类型,配置步无需再切)。
   *  编辑面板不传此项 → 显示万能/绑定显式切换。 */
  hideTypeToggle?: boolean;
  /** 是否禁用(保存/加载中)。 */
  disabled?: boolean;
}

export function CardConfigForm({
  value,
  onChange,
  accounts,
  usageBuckets,
  hideTypeToggle,
  disabled,
}: CardConfigFormProps) {
  // 切换卡类型(显式):切到万能即清空绑定(万能卡 bindings 必为 {});切到绑定保留现有绑定。
  const setCardType = (cardType: CardType) =>
    onChange(cardType === "pool" ? { cardType, bindings: {} } : { cardType });

  // 当前可用桶 × 已用量(used 从 usageBuckets join;新增时为 0)。
  const usedByBucket = new Map<string, number>(
    (usageBuckets || []).map((b) => [b.bucket, Number(b.used || 0)]),
  );
  const buckets: AccessKeyBucket[] = bucketsForType(value.cardType, value.bindings).map(
    (bucket) => ({
      bucket,
      label: bucketLabel(bucket),
      used: usedByBucket.get(bucket) || 0,
      limit: Number(value.bucketLimits[bucket] || 0),
    }),
  );

  return (
    <div className="flex flex-col gap-6">
      {/* ── 1. 基本 ── */}
      <FieldSet>
        <FieldLegend variant="label">基本</FieldLegend>
        <div className="flex flex-wrap items-end gap-3">
          <Field className="min-w-[160px] flex-1">
            <FieldLabel>备注/用户名</FieldLabel>
            <Input
              placeholder="可选"
              value={value.name}
              disabled={disabled}
              onChange={(e) => onChange({ name: e.target.value })}
            />
          </Field>

          <Field className="min-w-[180px]">
            <FieldLabel>有效期</FieldLabel>
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={1}
                className="w-20"
                value={value.durationValue}
                disabled={disabled}
                onChange={(e) => onChange({ durationValue: e.target.value })}
              />
              <Select
                items={UNIT_ITEMS}
                value={value.durationUnit}
                onValueChange={(v) => onChange({ durationUnit: v as "h" | "d" })}
                disabled={disabled}
              >
                <SelectTrigger className="w-20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {UNIT_ITEMS.map((it) => (
                      <SelectItem key={it.value} value={it.value}>
                        {it.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </Field>

          {value.cardType === "bound" ? (
            // 绑定卡:限额窗口自动对齐绑定账号的上游刷新窗口,不需要手动设置。
            <Field className="min-w-[160px]">
              <FieldLabel>限流窗口</FieldLabel>
              <p className="pt-2 text-xs text-muted-foreground">
                自动对齐绑定账号的上游刷新窗口,无需设置。
              </p>
            </Field>
          ) : (
            <Field className="min-w-[160px]">
              <FieldLabel>限流窗口</FieldLabel>
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  min={1}
                  className="w-20"
                  value={value.windowValue}
                  disabled={disabled}
                  onChange={(e) => onChange({ windowValue: e.target.value })}
                />
                <Select
                  items={UNIT_ITEMS}
                  value={value.windowUnit}
                  onValueChange={(v) => onChange({ windowUnit: v as "h" | "d" })}
                  disabled={disabled}
                >
                  <SelectTrigger className="w-20">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {UNIT_ITEMS.map((it) => (
                        <SelectItem key={it.value} value={it.value}>
                          {it.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            </Field>
          )}
        </div>
      </FieldSet>

      {/* ── 2. 卡类型(显式切换)+ 产品与绑定 ── */}
      <Separator />
      <FieldSet>
        <FieldLegend variant="label">卡类型</FieldLegend>
        {!hideTypeToggle && (
          <div className="flex gap-2">
            <Button
              type="button"
              variant={value.cardType === "pool" ? "default" : "outline"}
              onClick={() => setCardType("pool")}
              disabled={disabled}
            >
              <GlobeIcon data-icon className="size-4" />
              万能卡
            </Button>
            <Button
              type="button"
              variant={value.cardType === "bound" ? "default" : "outline"}
              onClick={() => setCardType("bound")}
              disabled={disabled}
            >
              <LinkIcon data-icon className="size-4" />
              绑定卡
            </Button>
          </div>
        )}
        {value.cardType === "bound" ? (
          <ProductBindingManager
            bindings={value.bindings}
            weight={value.weight}
            weights={value.weights || {}}
            accounts={accounts}
            onChange={(bindings) => onChange({ bindings })}
            onWeightChange={(weight) => onChange({ weight })}
            onWeightsChange={(weights) => onChange({ weights })}
            disabled={disabled}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            万能卡:不绑号、自动开放全部产品,走动态池。新增时未填写的模型额度会按 1 写入,代表不可用。
          </p>
        )}
      </FieldSet>

      {/* ── 3. 模型限额 ── */}
      <Separator />
      <FieldSet>
        <FieldLegend variant="label">模型限额</FieldLegend>
        <p className="text-xs text-muted-foreground">
          {value.cardType === "bound"
            ? "每个上限是「该模型在绑定账号当前刷新窗口」内的 token 配额,跟随账号窗口自动重置。留空 = 该模型无限。"
            : "每个上限是「上面设的限流窗口」(默认 5 小时,可改) 内的 token 配额,不是终身总额——窗口到期自动重置。新增时留空 = 1,代表该模型不可用。"}
        </p>
        <ModelLimitsEditor
          buckets={buckets}
          value={value.bucketLimits}
          onChange={(bucketLimits) => onChange({ bucketLimits })}
          disabled={disabled}
          blankLimitBehavior={value.cardType === "pool" ? "disabled" : "unlimited"}
        />
      </FieldSet>
    </div>
  );
}
