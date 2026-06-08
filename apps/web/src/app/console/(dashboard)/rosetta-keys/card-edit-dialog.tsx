"use client";

// 卡密编辑面板(单页)—— 行内「编辑」入口。
// 单页分区(全字段可见,改起来顺)= card-config-form(基本 + 产品与绑定 + 模型限额)
//   + 状态(启用/禁用)切换。类型可改(通过「产品与绑定」切换:全部解绑=万能;绑任意=绑定)。
// 不放删除(删除只在行内 + AlertDialog 二次确认),避免重复。
//
// 保存 = 两次调用,顺序为先 update 再 set-bindings(绑定变更影响份额占用):
//   1. POST /api/rosetta/access-key-update —— { id, name, status, durationMs, windowMs,
//      weight, bucketLimits }。
//   2. POST /api/rosetta/access-key-set-bindings —— { id, bindings }(整张映射;
//      换绑/解绑/增开/切池都走这张映射)。
// 失败时弹窗保持打开 + 内联错误;成功后回调父刷新列表 + 账号份额。

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Separator } from "@/components/ui/separator";
import { Field, FieldLegend, FieldSet } from "@/components/ui/field";
import { toast } from "sonner";
import { SaveIcon } from "lucide-react";
import { CardConfigForm } from "./card-config-form";
import type {
  AccessKeyListItem,
  BindableAccount,
  CardConfigPatch,
  CardConfigValue,
} from "./types";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** 把毫秒还原成「数值 + 单位」:能整除天用天,否则用小时(便于回显)。 */
function msToValueUnit(ms: number): { value: string; unit: "h" | "d" } {
  const n = Math.max(0, Number(ms) || 0);
  if (n > 0 && n % DAY_MS === 0) return { value: String(n / DAY_MS), unit: "d" };
  const hours = n > 0 ? Math.max(1, Math.round(n / HOUR_MS)) : 1;
  return { value: String(hours), unit: "h" };
}

/** 把「数值 + 单位」换算成毫秒。 */
function toMs(value: string, unit: "h" | "d"): number {
  const v = Math.max(1, Math.floor(Number(value) || 1));
  return v * (unit === "d" ? DAY_MS : HOUR_MS);
}

/** 由列表卡构造编辑表单初始值。 */
function cardToConfig(card: AccessKeyListItem): CardConfigValue {
  const dur = msToValueUnit(card.durationMs);
  const win = msToValueUnit(card.windowMs);
  // 只保留 accountId>0 的绑定(后端 {} = 万能卡)。
  const bindings: Record<string, number> = {};
  for (const [product, id] of Object.entries(card.bindings || {})) {
    if (Number(id) > 0) bindings[product] = Number(id);
  }
  // 只保留 >0 的桶上限(0/缺省 = 无限)。
  const bucketLimits: Record<string, number> = {};
  for (const [bucket, lim] of Object.entries(card.bucketLimits || {})) {
    if (Number(lim) > 0) bucketLimits[bucket] = Number(lim);
  }
  return {
    // 卡类型取后端下发的 cardType(显式状态),不再由 bindings 是否为空推导。
    cardType: card.cardType,
    name: card.name || "",
    durationValue: dur.value,
    durationUnit: dur.unit,
    windowValue: win.value,
    windowUnit: win.unit,
    bindings,
    weight: Math.max(1, Math.min(8, Number(card.weight) || 1)),
    bucketLimits,
  };
}

export interface CardEditDialogProps {
  /** 当前编辑的卡(null = 关闭)。 */
  card: AccessKeyListItem | null;
  /** 弹窗开关。 */
  open: boolean;
  /** 开关变更。 */
  onOpenChange: (open: boolean) => void;
  /** 可绑定账号(产品绑定下拉 + 份额校验)。 */
  accounts: BindableAccount[];
  /** 保存成功后回调(父刷新列表 + 账号份额)。 */
  onSaved: () => void;
}

export function CardEditDialog({
  card,
  open,
  onOpenChange,
  accounts,
  onSaved,
}: CardEditDialogProps) {
  const [config, setConfig] = useState<CardConfigValue | null>(null);
  // 状态:active = 启用;其余视为禁用(保存时写回 active/disabled)。
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // 卡变更时(打开新卡)重置表单。
  useEffect(() => {
    if (open && card) {
      setConfig(cardToConfig(card));
      setEnabled(card.status === "active");
      setError("");
    }
  }, [open, card]);

  const patchConfig = (patch: CardConfigPatch) =>
    setConfig((prev) => (prev ? { ...prev, ...patch } : prev));

  // 保存:先 update(基本/状态/份额/模型限额),再 set-bindings(整张绑定映射)。
  const handleSave = async () => {
    if (!card || !config) return;
    setSaving(true);
    setError("");
    try {
      // 模型限额:只下发 >0 的项;后端 update 会把 0/缺省视为删除该桶覆盖。
      // 为支持「清空某桶」,把当前卡已有但本次未设的桶显式置 0(回到无限)。
      const bucketLimits: Record<string, number> = {};
      for (const bucket of Object.keys(card.bucketLimits || {})) {
        bucketLimits[bucket] = 0; // 先全部清,再用本次值覆盖。
      }
      for (const [bucket, lim] of Object.entries(config.bucketLimits)) {
        if (Number(lim) > 0) bucketLimits[bucket] = Math.floor(Number(lim));
      }

      const updateRes = await fetch("/api/rosetta/access-key-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: card.id,
          name: config.name.trim(),
          status: enabled ? "active" : "disabled",
          durationMs: toMs(config.durationValue, config.durationUnit),
          windowMs: toMs(config.windowValue, config.windowUnit),
          weight: Math.max(1, Math.min(8, Number(config.weight) || 1)),
          bucketLimits,
        }),
      });
      const updateData = await updateRes.json();
      if (!updateData.ok) throw new Error(updateData.error || "保存失败");

      // 整张绑定映射(空 = 万能卡):换绑/解绑/增开/切池都走这里。
      // 按显式 cardType 决定:万能 → 必空({});绑定 → 用配置的绑定,且至少绑一个。
      const bindings: Record<string, number> = {};
      if (config.cardType === "bound") {
        for (const [product, id] of Object.entries(config.bindings)) {
          if (Number(id) > 0) bindings[product] = Number(id);
        }
        if (Object.keys(bindings).length === 0) {
          throw new Error("绑定卡请至少为一个产品绑定账号(或切换为万能卡)");
        }
      }
      const bindRes = await fetch("/api/rosetta/access-key-set-bindings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: card.id, bindings }),
      });
      const bindData = await bindRes.json();
      if (!bindData.ok) throw new Error(bindData.error || "绑定保存失败");

      toast.success("已保存");
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>编辑卡密</DialogTitle>
          <DialogDescription>
            <code className="font-mono">{card?.key}</code>
            {card?.name ? ` · ${card.name}` : ""}
          </DialogDescription>
        </DialogHeader>

        {config && (
          <div className="flex flex-col gap-4">
            {/* 状态(启用/禁用) */}
            <FieldSet>
              <FieldLegend variant="label">状态</FieldLegend>
              <Field
                orientation="horizontal"
                className="items-center justify-between rounded-lg border p-3"
              >
                <span className="text-sm">
                  {enabled ? "已启用(可正常调用)" : "已禁用(暂停调用)"}
                </span>
                <Switch
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  disabled={saving}
                />
              </Field>
            </FieldSet>

            <Separator />

            {/* 配置(基本 + 产品与绑定 + 模型限额) */}
            <CardConfigForm
              value={config}
              onChange={patchConfig}
              accounts={accounts}
              usageBuckets={card?.buckets}
              disabled={saving}
            />

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            取消
          </Button>
          <Button onClick={handleSave} disabled={saving || !config}>
            {saving ? (
              <Spinner data-icon className="size-3.5" />
            ) : (
              <SaveIcon data-icon className="size-3.5" />
            )}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
