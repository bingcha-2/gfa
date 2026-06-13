"use client";

// 新增卡密向导(弹窗 · 分步)—— 顶部「+ 生成卡密」入口。
// 步骤:
//   ① 选类型:绑定卡 / 万能卡 两张大卡(点选,绑定卡优先置前)。
//   ② 配置:复用 card-config-form。
//        - 万能卡:hideBinding,只显示「基本 + 模型限额」(全产品桶)。
//        - 绑定卡:显示全部(基本 + 产品与绑定 + 模型限额,按已绑产品列桶)。
//   ③ 生成数量 + 生成 → 结果面板(列出全部卡密 + 「全部复制」)。
//
// 创建接口对齐旧 page.tsx handleCreate:
//   - POST /api/console/rosetta/access-key 接受 { name, durationMs, windowMs, count, weight,
//     products[], levels{product:level}, accountIds{product:id} }。
//   - 注意:create 接口不接受 bucketLimits;若用户在向导里设了模型限额,创建成功后
//     对每张返回的卡再调用 /api/console/rosetta/access-key-update 写入 bucketLimits(逐卡)。
//   - 绑定卡的 products/levels/accountIds 由 card-config-form 的 bindings(product→accountId)
//     联表 accounts 推导:planType 作为 level;accountId 作为手动指定账号。

import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Field, FieldLabel } from "@/components/ui/field";
import { toast } from "sonner";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CopyIcon,
  GlobeIcon,
  LinkIcon,
  SparklesIcon,
} from "lucide-react";
import { CardConfigForm } from "./card-config-form";
import type {
  BindableAccount,
  CardConfigPatch,
  CardConfigValue,
  CardType,
} from "./types";

// 向导步骤:type 选类型 → config 配置 → done 结果面板。
type WizardStep = "type" | "config" | "done";

// 配置表单的初始值(每次打开重置)。
function defaultConfig(): CardConfigValue {
  return {
    cardType: "bound",
    name: "",
    durationValue: "30",
    durationUnit: "d",
    windowValue: "5",
    windowUnit: "h",
    bindings: {},
    weight: 1,
    bucketLimits: {},
  };
}

/** 把「数值 + 单位」换算成毫秒(小时/天)。 */
function toMs(value: string, unit: "h" | "d"): number {
  const v = Math.max(1, Math.floor(Number(value) || 1));
  return v * (unit === "d" ? 86_400_000 : 3_600_000);
}

export interface CreateWizardProps {
  /** 弹窗开关。 */
  open: boolean;
  /** 开关变更(关闭时父应重置入口状态)。 */
  onOpenChange: (open: boolean) => void;
  /** 可绑定账号(产品绑定下拉 + 由绑定推导 level)。 */
  accounts: BindableAccount[];
  /** 创建成功后回调(父刷新列表 + 账号份额)。 */
  onCreated: () => void;
}

export function CreateWizard({
  open,
  onOpenChange,
  accounts,
  onCreated,
}: CreateWizardProps) {
  const [step, setStep] = useState<WizardStep>("type");
  // 默认绑定卡(绑定卡优先,与用户端选购页 / 绑定弹窗一致)。
  const [cardType, setCardType] = useState<CardType>("bound");
  const [config, setConfig] = useState<CardConfigValue>(defaultConfig);
  const [count, setCount] = useState("1");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  // 结果面板:生成的完整卡密列表。
  const [revealKeys, setRevealKeys] = useState<string[]>([]);

  // accountId → BindableAccount 速查(推导 provider/level 用)。
  const accountById = useMemo(() => {
    const map = new Map<number, BindableAccount>();
    for (const a of accounts) map.set(a.id, a);
    return map;
  }, [accounts]);

  // 完全重置向导状态(关闭或「再建一批」时)。
  const reset = () => {
    setStep("type");
    setCardType("bound");
    setConfig(defaultConfig());
    setCount("1");
    setError("");
    setRevealKeys([]);
  };

  // 受控关闭:关闭即重置(避免下次打开残留旧状态)。
  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  // card-config-form 的部分补丁合并。
  const patchConfig = (patch: CardConfigPatch) =>
    setConfig((prev) => ({ ...prev, ...patch }));

  // 选类型 → 进入配置:万能卡清空 bindings(确保 hideBinding 时不残留绑定)。
  const chooseType = (type: CardType) => {
    setCardType(type);
    setConfig((prev) => ({
      ...prev,
      cardType: type,
      bindings: type === "pool" ? {} : prev.bindings,
    }));
    setError("");
    setStep("config");
  };

  // 提交创建。失败时保持弹窗打开 + 内联错误。
  const handleCreate = async () => {
    setSubmitting(true);
    setError("");
    try {
      const num = Math.max(1, Math.min(200, Math.floor(Number(count) || 1)));
      const payload: Record<string, unknown> = {
        name: config.name.trim() || undefined,
        durationMs: toMs(config.durationValue, config.durationUnit),
        windowMs: toMs(config.windowValue, config.windowUnit),
        count: num,
      };

      // 绑定卡:由 bindings 推导 products/levels/accountIds(每个产品手动指定账号)。
      if (cardType === "bound") {
        const boundEntries = Object.entries(config.bindings).filter(
          ([, id]) => Number(id) > 0,
        );
        if (boundEntries.length === 0) {
          throw new Error("绑定卡请至少为一个产品绑定账号");
        }
        const products: string[] = [];
        const levels: Record<string, string> = {};
        const accountIds: Record<string, number> = {};
        for (const [product, rawId] of boundEntries) {
          const id = Number(rawId);
          const acc = accountById.get(id);
          const level = String(acc?.planType || "").trim();
          if (!level) {
            throw new Error(`所选账号缺少会员等级,无法绑定 ${product}`);
          }
          products.push(product);
          levels[product] = level;
          accountIds[product] = id;
        }
        payload.products = products;
        payload.levels = levels;
        payload.accountIds = accountIds;
        payload.weight = Math.max(1, Math.min(8, Number(config.weight) || 1));
      }

      const res = await fetch("/api/console/rosetta/access-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "创建失败");

      const created: { id?: string; fullKey?: string }[] = Array.isArray(data.keys)
        ? data.keys
        : data.key
          ? [data.key]
          : [];

      // create 接口不接受 bucketLimits;若设了模型限额,逐卡 update 写入。
      const limits = Object.fromEntries(
        Object.entries(config.bucketLimits).filter(([, v]) => Number(v) > 0),
      );
      if (Object.keys(limits).length > 0) {
        await Promise.all(
          created
            .map((k) => k.id)
            .filter((id): id is string => Boolean(id))
            .map((id) =>
              fetch("/api/console/rosetta/access-key-update", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id, bucketLimits: limits }),
              }),
            ),
        );
      }

      const fullKeys = created.map((k) => k.fullKey || "").filter(Boolean);
      setRevealKeys(fullKeys);
      setStep("done");
      // 生成后自动复制一份到剪贴板(失败静默)。
      if (fullKeys.length > 0) {
        await navigator.clipboard?.writeText(fullKeys.join("\n")).catch(() => {});
      }
      toast.success(`已生成 ${created.length || num} 张卡密`);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setSubmitting(false);
    }
  };

  // 「全部复制」结果面板里的卡密。
  const copyAll = async () => {
    await navigator.clipboard
      ?.writeText(revealKeys.join("\n"))
      .catch(() => {});
    toast.success("已复制全部卡密");
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {step === "done" ? "卡密已生成" : "生成卡密"}
          </DialogTitle>
          <DialogDescription>
            {step === "type" && "先选择卡类型,再配置基本信息与额度。"}
            {step === "config" &&
              (cardType === "pool"
                ? "万能卡 = 全产品开放,靠模型限额控量。"
                : "绑定卡 = 逐产品绑号,靠份额均分账号原生配额。")}
            {step === "done" &&
              "请立即复制下方卡密,关闭后将无法再次查看完整卡密。"}
          </DialogDescription>
        </DialogHeader>

        {/* ── 步骤 ① 选类型 ── */}
        {step === "type" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => chooseType("bound")}
              className="flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors hover:border-purple-500/60 hover:bg-purple-500/5"
            >
              <div className="flex items-center gap-2">
                <LinkIcon className="size-5 text-purple-500" />
                <span className="font-medium">绑定卡</span>
              </div>
              <p className="text-xs text-muted-foreground">
                逐产品绑定账号,按「份额」均分账号原生配额;可再叠加模型限额作为绝对封顶。
              </p>
            </button>

            <button
              type="button"
              onClick={() => chooseType("pool")}
              className="flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors hover:border-blue-500/60 hover:bg-blue-500/5"
            >
              <div className="flex items-center gap-2">
                <GlobeIcon className="size-5 text-blue-500" />
                <span className="font-medium">万能卡</span>
              </div>
              <p className="text-xs text-muted-foreground">
                不绑任何产品 → 自动开放全部产品。唯一控量手段是「模型限额」。适合通用分发。
              </p>
            </button>
          </div>
        )}

        {/* ── 步骤 ② 配置 ── */}
        {step === "config" && (
          <div className="flex flex-col gap-4">
            <CardConfigForm
              value={config}
              onChange={patchConfig}
              accounts={accounts}
              hideTypeToggle
              disabled={submitting}
            />

            {/* 生成数量(随配置一同确认,提交按钮在底部) */}
            <Field className="max-w-[200px]">
              <FieldLabel>生成数量</FieldLabel>
              <Input
                type="number"
                min={1}
                max={200}
                value={count}
                disabled={submitting}
                onChange={(e) => setCount(e.target.value)}
              />
            </Field>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </div>
        )}

        {/* ── 步骤 ③ 结果面板 ── */}
        {step === "done" && (
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border bg-muted/50 p-3">
              <p className="mb-2 text-xs text-muted-foreground">
                共 {revealKeys.length} 张,已自动复制到剪贴板:
              </p>
              <code className="block max-h-72 overflow-y-auto break-all font-mono text-sm whitespace-pre-wrap">
                {revealKeys.join("\n")}
              </code>
            </div>
          </div>
        )}

        {/* ── 底部操作区(随步骤切换)── */}
        <DialogFooter className="gap-2 sm:gap-2">
          {step === "config" && (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setError("");
                  setStep("type");
                }}
                disabled={submitting}
              >
                <ArrowLeftIcon data-icon className="size-3.5" />
                上一步
              </Button>
              <Button onClick={handleCreate} disabled={submitting}>
                {submitting ? (
                  <Spinner data-icon className="size-3.5" />
                ) : (
                  <SparklesIcon data-icon className="size-3.5" />
                )}
                生成
              </Button>
            </>
          )}

          {step === "type" && (
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              取消
            </Button>
          )}

          {step === "done" && (
            <>
              <Button variant="outline" onClick={copyAll}>
                <CopyIcon data-icon className="size-3.5" />
                全部复制
              </Button>
              <Button onClick={reset}>
                <ArrowRightIcon data-icon className="size-3.5" />
                再建一批
              </Button>
              <Button variant="ghost" onClick={() => handleOpenChange(false)}>
                完成
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
