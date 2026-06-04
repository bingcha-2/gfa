"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
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

const PROVIDER_LABEL: Record<string, string> = {
  codex: "Codex",
  antigravity: "Antigravity",
};

function providerLabel(provider: string): string {
  return PROVIDER_LABEL[provider] || provider;
}

/** 下拉里"池子模式"选项的哨兵值(Select 不能用空串)。 */
const POOL = "__pool";

/**
 * 卡片绑定管理:表格里只显示当前绑定摘要 + 一个按钮(池子卡=「绑定」,已绑卡=「换绑」)。
 * 点按钮弹出二级弹窗,弹窗里每个产品可在「池子模式」与「绑定到某账号」之间切换,保存时
 * 一次性提交最终映射(走 /access-key-set-bindings 原子写入)。
 */
export function BindAccountControl({ card, accounts, onApply }: BindAccountControlProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // 弹窗内每个 provider 的选择:POOL 或 accountId 字符串。
  const [sel, setSel] = useState<Record<string, string>>({});

  const bindings = card.bindings || {};
  const cardWeight = Math.max(1, Math.min(4, Number(card.weight || 1)));
  const boundProviders = Object.entries(bindings).filter(([, id]) => Number(id) > 0);

  // 池里有号的 provider 才能绑;固定顺序 codex → antigravity。
  const providers = ["codex", "antigravity"].filter((p) =>
    accounts.some((a) => a.provider === p),
  );

  const openDialog = () => {
    const init: Record<string, string> = {};
    for (const p of providers) {
      const cur = Number(bindings[p] || 0);
      init[p] = cur > 0 ? String(cur) : POOL;
    }
    setSel(init);
    setOpen(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const desired: Record<string, number> = {};
      for (const p of providers) {
        const v = sel[p];
        if (v && v !== POOL) desired[p] = Number(v);
      }
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
        {boundProviders.length > 0 ? "换绑" : "绑定"}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>设置绑定账号</DialogTitle>
            <DialogDescription>
              每个产品可选「池子模式」(不绑号、走动态池)或绑定到具体账号。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            {providers.length === 0 ? (
              <span className="text-sm text-muted-foreground">暂无可绑定账号</span>
            ) : (
              providers.map((provider) => {
                const cur = sel[provider] || POOL;
                const provAccounts = accounts.filter((a) => a.provider === provider);
                return (
                  <div key={provider} className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium">{providerLabel(provider)}</span>
                    <Select
                      value={cur}
                      onValueChange={(v) => setSel((m) => ({ ...m, [provider]: v }))}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={POOL}>池子模式（不绑号）</SelectItem>
                        {provAccounts.map((a) => {
                          const isCurrent = Number(bindings[provider] || 0) === a.id;
                          // 满额禁选;但当前已绑的号永远可选(它的 usedShares 含本卡)。
                          const full = !isCurrent && a.usedShares + cardWeight > a.shareCapacity;
                          return (
                            <SelectItem key={a.id} value={String(a.id)} disabled={full}>
                              {a.email}
                              {a.planType ? ` · ${a.planType}` : ""} ({a.usedShares}/{a.shareCapacity}份)
                              {full ? " · 满" : ""}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button onClick={save} disabled={saving || providers.length === 0}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
