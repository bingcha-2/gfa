"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface BindableAccount {
  provider: string;
  id: number;
  email: string;
  /** Shares already used on this account (sum of bound cards' weights). */
  usedShares: number;
  /** Total shares per account (份). Default 4. */
  shareCapacity: number;
  /** Membership level (planType), used to label in pickers. */
  planType?: string;
}

interface BindAccountControlProps {
  /** card.weight = this card's share weight (份额): 1 拼车 … 4 独享. */
  card: { id: string; bindings?: Record<string, number>; weight?: number };
  accounts: BindableAccount[];
  /** 一次性提交期望的最终绑定映射({} = 池子卡)。失败请 reject/throw,弹窗会保持打开。 */
  onApply: (bindings: Record<string, number>) => Promise<void> | void;
}

const PROVIDERS = [
  { id: "codex", label: "Codex" },
  { id: "antigravity", label: "Antigravity" },
  { id: "anthropic", label: "Anthropic" },
] as const;

function providerLabel(provider: string): string {
  return PROVIDERS.find((p) => p.id === provider)?.label || provider;
}

const MODE_ITEMS = [
  { label: "绑定模式（开通指定产品）", value: "bound" },
  { label: "池子模式（万能卡 · 不绑号）", value: "pool" },
];

/**
 * 卡片绑定管理:表格里只显示当前绑定摘要 + 一个「设置」按钮,点开二级弹窗。弹窗与
 * 「新增卡密」同构:顶层切「绑定模式 / 池子模式」,绑定模式下用 Checkbox 多选开通产品 +
 * 每个产品选账号(取消产品=解绑,换账号=换绑,切池子=全解绑)。保存一次性提交最终映射
 * (走 /access-key-set-bindings 原子写入)。
 */
export function BindAccountControl({ card, accounts, onApply }: BindAccountControlProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<"pool" | "bound">("pool");
  const [products, setProducts] = useState<string[]>([]);
  const [accSel, setAccSel] = useState<Record<string, string>>({});

  const bindings = card.bindings || {};
  const cardWeight = Math.max(1, Math.min(4, Number(card.weight || 1)));
  const boundProviders = Object.entries(bindings).filter(([, id]) => Number(id) > 0);

  // 池里有号的产品才能绑。
  const availProviders = PROVIDERS.filter((p) => accounts.some((a) => a.provider === p.id));

  const openDialog = () => {
    setMode(boundProviders.length > 0 ? "bound" : "pool");
    setProducts(boundProviders.map(([p]) => p));
    const nextAcc: Record<string, string> = {};
    for (const p of PROVIDERS) {
      const cur = Number(bindings[p.id] || 0);
      nextAcc[p.id] = cur > 0 ? String(cur) : "";
    }
    setAccSel(nextAcc);
    setOpen(true);
  };

  const save = async () => {
    const desired: Record<string, number> = {};
    if (mode === "bound") {
      const sel = availProviders.filter((p) => products.includes(p.id));
      if (sel.length === 0) {
        toast.error("绑定模式请至少开通一个产品");
        return;
      }
      for (const p of sel) {
        const id = Number(accSel[p.id] || 0);
        if (!(id > 0)) {
          toast.error(`请为 ${p.label} 选择账号`);
          return;
        }
        desired[p.id] = id;
      }
    }
    // mode === "pool" → desired 为空 → 池子卡。
    setSaving(true);
    try {
      await onApply(desired);
      setOpen(false);
    } catch {
      // 错误提示由 onApply 负责;弹窗保持打开供重试。
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {/* 当前绑定摘要 */}
      {boundProviders.length === 0 ? (
        <span className="text-xs text-muted-foreground">池子模式</span>
      ) : (
        <div className="flex flex-col gap-0.5">
          {boundProviders.map(([provider, accountId]) => {
            const acct = accounts.find(
              (a) => a.provider === provider && a.id === Number(accountId),
            );
            return (
              <span key={provider} className="text-sm whitespace-nowrap">
                {providerLabel(provider)} · {acct ? acct.email : `#${accountId}`}
              </span>
            );
          })}
        </div>
      )}
      <Button size="sm" variant="outline" onClick={openDialog}>
        设置
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>设置绑定账号</DialogTitle>
            <DialogDescription>
              选择「池子模式」或「绑定模式」(与新增卡密一致)。
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel>模式</FieldLabel>
              <Select
                items={MODE_ITEMS}
                value={mode}
                onValueChange={(v) => setMode(v as "pool" | "bound")}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {MODE_ITEMS.map((it) => (
                      <SelectItem key={it.value} value={it.value}>
                        {it.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            {mode === "pool" ? (
              <p className="text-sm text-muted-foreground">
                万能池子卡:不绑号,codex/antigravity 都能用,走动态池。
              </p>
            ) : availProviders.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无可绑定账号</p>
            ) : (
              <>
                <FieldSet>
                  <FieldLegend variant="label">开通产品（只开的能用）</FieldLegend>
                  <FieldGroup className="gap-3">
                    {availProviders.map((p) => (
                      <Field key={p.id} orientation="horizontal">
                        <Checkbox
                          id={`bind-${card.id}-${p.id}`}
                          checked={products.includes(p.id)}
                          onCheckedChange={(c) =>
                            setProducts((prev) =>
                              c === true
                                ? [...new Set([...prev, p.id])]
                                : prev.filter((x) => x !== p.id),
                            )
                          }
                        />
                        <FieldLabel htmlFor={`bind-${card.id}-${p.id}`} className="font-normal">
                          {p.label}
                        </FieldLabel>
                      </Field>
                    ))}
                  </FieldGroup>
                </FieldSet>

                {availProviders
                  .filter((p) => products.includes(p.id))
                  .map((p) => {
                    const provAccounts = accounts.filter((a) => a.provider === p.id);
                    const accItems = [
                      { label: "选择账号…", value: null },
                      ...provAccounts.map((a) => ({ label: a.email, value: String(a.id) })),
                    ];
                    return (
                      <Field key={p.id}>
                        <FieldLabel>{p.label} 账号</FieldLabel>
                        <Select
                          items={accItems}
                          value={accSel[p.id] || null}
                          onValueChange={(v) => setAccSel((m) => ({ ...m, [p.id]: v }))}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {provAccounts.map((a) => {
                                const isCurrent = Number(bindings[p.id] || 0) === a.id;
                                const full =
                                  !isCurrent && a.usedShares + cardWeight > a.shareCapacity;
                                return (
                                  <SelectItem key={a.id} value={String(a.id)} disabled={full}>
                                    {a.email}
                                    {a.planType ? ` · ${a.planType}` : ""} ({a.usedShares}/
                                    {a.shareCapacity}份){full ? " · 满" : ""}
                                  </SelectItem>
                                );
                              })}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                    );
                  })}
              </>
            )}
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
