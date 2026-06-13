"use client";

// 产品与绑定管理器 —— card-config-form 的「产品与绑定」区块。
// 逐产品(Codex / Antigravity / Anthropic)一行:
//   - 未绑定(默认)/ 绑定账号(下拉选号 = 绑定或换绑)/ 解绑。
//   - 选号下拉按会员等级(planType)分组,显示 usedShares/shareCapacity,份额不足禁选。
//   - 卡级份额(weight 1–8)作用于本卡所有绑定。
// 全部不绑 => 万能卡(全产品开放,靠模型限额控量);绑任意 => 绑定卡(仅绑定产品可用)。
// 完全受控:bindings({product:accountId})、weight、accounts 由父传入,变更通过 onChange 回传。

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnplugIcon } from "lucide-react";
import type { BindableAccount } from "./types";

// 产品列表(顺序与号池售卖顺序一致:Codex → Antigravity → Anthropic)。
const PRODUCTS: { id: string; label: string }[] = [
  { id: "codex", label: "Codex" },
  { id: "antigravity", label: "Antigravity" },
  { id: "anthropic", label: "Anthropic" },
];

// 份额(weight)选项:1 拼车(8人/号)… 8 独享(独占一个号,capacity=8)。
const WEIGHT_ITEMS = [
  { label: "拼车 · 1份(8人/号)", value: "1" },
  { label: "2份(4人/号)", value: "2" },
  { label: "4份(2人/号)", value: "4" },
  { label: "独享 · 8份(独占一个号)", value: "8" },
];

const UNBOUND = "__unbound"; // Select 用的「未绑定」占位值(空字符串在 base-ui Select 里不稳)。

export interface ProductBindingManagerProps {
  /** 受控绑定映射 { product: accountId };{} = 万能卡。 */
  bindings: Record<string, number>;
  /** 受控卡级【默认】份额 1..8(未单独设置的产品用它)。 */
  weight: number;
  /** 受控【按产品】份额覆盖 { product: 份额 }。 */
  weights?: Record<string, number>;
  /** 可绑定账号(跨三个池,provider 区分)。 */
  accounts: BindableAccount[];
  /** 绑定映射变更回传整张映射。 */
  onChange: (next: Record<string, number>) => void;
  /** 卡级默认份额变更回传。 */
  onWeightChange: (weight: number) => void;
  /** 按产品份额覆盖变更回传整张映射。 */
  onWeightsChange?: (next: Record<string, number>) => void;
  /** 是否禁用(保存/加载中)。 */
  disabled?: boolean;
}

export function ProductBindingManager({
  bindings,
  weight,
  weights,
  accounts,
  onChange,
  onWeightChange,
  onWeightsChange,
  disabled,
}: ProductBindingManagerProps) {
  const cardWeight = Math.max(1, Math.min(8, Number(weight) || 1));
  // 某产品的实际份额:按产品覆盖优先,否则卡级默认。
  const weightFor = (product: string) =>
    Math.max(1, Math.min(8, Number((weights ?? {})[product] ?? cardWeight) || 1));
  // 设/清某产品的份额覆盖(等于默认值则清掉,保持 weights 精简)。
  const setWeightFor = (product: string, w: number) => {
    if (!onWeightsChange) return;
    const next = { ...(weights ?? {}) };
    const v = Math.max(1, Math.min(8, Number(w) || 1));
    if (v === cardWeight) delete next[product];
    else next[product] = v;
    onWeightsChange(next);
  };

  // 某产品的账号下拉「完整 items」(base-ui Select 靠它把选中值映射成 label 显示;
  // 缺项会导致选中后触发器空白)。占位「不绑定」+ 该产品全部账号。
  const accountItems = (product: string) => {
    const opts = [{ label: "不绑定", value: UNBOUND }];
    for (const a of accounts.filter((x) => x.provider === product)) {
      opts.push({
        label: `${a.email}(${a.usedShares}/${a.shareCapacity}份)`,
        value: String(a.id),
      });
    }
    return opts;
  };

  // 设定/换绑某产品的账号(id<=0 视为解绑)。
  const setBinding = (product: string, accountId: number) => {
    const next = { ...bindings };
    if (accountId > 0) next[product] = accountId;
    else delete next[product];
    onChange(next);
  };

  // 某产品在各等级下的账号(按 planType 分组,等级名升序)。
  const accountsByLevel = (product: string) => {
    const list = accounts.filter((a) => a.provider === product);
    const groups = new Map<string, BindableAccount[]>();
    for (const a of list) {
      const lv = String(a.planType || "").trim() || "(未分级)";
      if (!groups.has(lv)) groups.set(lv, []);
      groups.get(lv)!.push(a);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部:绑定提示 + 份额(绑定卡始终显示;均分账号原生配额)*/}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          为需要的产品绑定账号(至少一个);未绑定的产品该卡不可用。
        </span>
        <div className="flex items-center gap-2">
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            默认份额(未单独设置的产品用)
          </span>
          <Select
            items={WEIGHT_ITEMS}
            value={String(cardWeight)}
            onValueChange={(v) => onWeightChange(Math.max(1, Math.min(8, Number(v) || 1)))}
            disabled={disabled}
          >
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {WEIGHT_ITEMS.map((it) => (
                  <SelectItem key={it.value} value={it.value}>
                    {it.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* 逐产品行 */}
      <div className="space-y-2">
        {PRODUCTS.map((p) => {
          const currentId = Number(bindings[p.id] || 0);
          const groups = accountsByLevel(p.id);
          const hasAccounts = groups.length > 0;
          // base-ui Select 的当前值:未绑 = 占位值;已绑 = 账号 id 字符串。
          const selectValue = currentId > 0 ? String(currentId) : UNBOUND;

          return (
            <div
              key={p.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border p-3"
            >
              <span className="min-w-[96px] text-sm font-medium">{p.label}</span>

              <div className="flex-1 min-w-[220px]">
                {hasAccounts ? (
                  <Select
                    items={accountItems(p.id)}
                    value={selectValue}
                    onValueChange={(v) =>
                      setBinding(p.id, v === UNBOUND ? 0 : Number(v))
                    }
                    disabled={disabled}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value={UNBOUND}>不绑定</SelectItem>
                      </SelectGroup>
                      {groups.map(([level, list]) => (
                        <SelectGroup key={level}>
                          <SelectLabel>{level}</SelectLabel>
                          {list.map((a) => {
                            const isCurrent = a.id === currentId;
                            // 份额是否够:换绑到非当前号时,需 usedShares + 本卡【该产品】份额 <= 容量。
                            const full =
                              !isCurrent && a.usedShares + weightFor(p.id) > a.shareCapacity;
                            return (
                              <SelectItem
                                key={a.id}
                                value={String(a.id)}
                                disabled={full}
                              >
                                {a.email} ({a.usedShares}/{a.shareCapacity}份)
                                {full ? " · 份额不足" : ""}
                              </SelectItem>
                            );
                          })}
                        </SelectGroup>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    该产品暂无可绑定账号
                  </span>
                )}
              </div>

              {/* 该产品份额(仅已绑时可设;等于默认则不写覆盖) */}
              {currentId > 0 && onWeightsChange && (
                <Select
                  items={WEIGHT_ITEMS}
                  value={String(weightFor(p.id))}
                  onValueChange={(v) => setWeightFor(p.id, Number(v))}
                  disabled={disabled}
                >
                  <SelectTrigger className="w-[150px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {WEIGHT_ITEMS.map((it) => (
                        <SelectItem key={it.value} value={it.value}>
                          {it.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              )}

              {/* 解绑按钮(仅已绑时可点) */}
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        disabled={disabled || currentId <= 0}
                        onClick={() => setBinding(p.id, 0)}
                      />
                    }
                  >
                    <UnplugIcon
                      data-icon
                      className="size-3.5 text-muted-foreground"
                    />
                  </TooltipTrigger>
                  <TooltipContent>解绑</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          );
        })}
      </div>
    </div>
  );
}
