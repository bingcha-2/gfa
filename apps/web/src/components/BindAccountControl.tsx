"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

export interface BindableAccount {
  provider: string;
  id: number;
  email: string;
  /** Shares already used on this account (sum of bound cards' weights). */
  usedShares: number;
  /** Total shares per account (份). Default 4. */
  shareCapacity: number;
  /** Membership level (planType), used to filter/label in pickers. */
  planType?: string;
}

interface BindAccountControlProps {
  /** card.weight = this card's share weight (份额): 1 拼车 … 4 独享. */
  card: { id: string; bindings?: Record<string, number>; weight?: number };
  accounts: BindableAccount[];
  onBind: (provider: string, accountId: number) => void;
  onUnbind: (provider: string) => void;
}

const PROVIDER_LABEL: Record<string, string> = {
  codex: "Codex",
  antigravity: "Antigravity",
};

function providerLabel(provider: string): string {
  return PROVIDER_LABEL[provider] || provider;
}

/**
 * Manage a card's static bindings. A card with no bindings is a "pool" card
 * (dynamic pool). Each binding pins the card to one account in a pool; the
 * picker adds a binding, and each existing binding can be unbound independently.
 */
export function BindAccountControl({
  card,
  accounts,
  onBind,
  onUnbind,
}: BindAccountControlProps) {
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  // 每个已绑定 provider 的"换绑到"下拉选中值。
  const [swapSel, setSwapSel] = useState<Record<string, string>>({});

  const bindings = card.bindings || {};
  const cardWeight = Math.max(1, Math.min(4, Number(card.weight || 1)));
  const boundProviders = Object.entries(bindings).filter(([, id]) => Number(id) > 0);
  // A card binds at most one account per pool — only offer pools not yet bound.
  const boundProviderKeys = new Set(boundProviders.map(([provider]) => provider));
  const q = query.trim().toLowerCase();
  // Pools the card can still bind (drives whether to show the picker at all).
  const addableAll = accounts.filter((a) => !boundProviderKeys.has(a.provider));
  // …narrowed by the search box.
  const addableAccounts = addableAll.filter(
    (a) => !q || `${providerLabel(a.provider)} ${a.email}`.toLowerCase().includes(q),
  );

  return (
    <div className="flex flex-col gap-1.5">
      {boundProviders.length === 0 ? (
        <span className="text-xs text-muted-foreground">池子模式（不绑号）</span>
      ) : (
        boundProviders.map(([provider, accountId]) => {
          const acct = accounts.find((a) => a.provider === provider && a.id === Number(accountId));
          const label = acct
            ? `${providerLabel(provider)} · ${acct.email}`
            : `${providerLabel(provider)} · #${accountId}`;
          // 换绑候选:同 provider、排除当前账号。容量按"目标号已用份额 + 本卡份额"判断
          // (服务端会排除本卡自身,这里目标号不是当前号,故其 usedShares 不含本卡)。
          const swapOptions = accounts.filter(
            (a) => a.provider === provider && a.id !== Number(accountId),
          );
          const sel = swapSel[provider] || "";
          return (
            <div key={provider} className="flex flex-wrap items-center gap-2">
              <span className="text-sm">{label}</span>
              {swapOptions.length > 0 && (
                <>
                  <select
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                    value={sel}
                    onChange={(e) =>
                      setSwapSel((m) => ({ ...m, [provider]: e.target.value }))
                    }
                  >
                    <option value="">换绑到…</option>
                    {swapOptions.map((a) => (
                      <option
                        key={a.id}
                        value={String(a.id)}
                        disabled={a.usedShares + cardWeight > a.shareCapacity}
                      >
                        {a.email}
                        {a.planType ? ` · ${a.planType}` : ""} ({a.usedShares}/{a.shareCapacity} 份)
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    disabled={!sel}
                    onClick={() => {
                      onBind(provider, Number(sel));
                      setSwapSel((m) => ({ ...m, [provider]: "" }));
                    }}
                  >
                    换绑
                  </Button>
                </>
              )}
              <Button size="sm" variant="outline" onClick={() => onUnbind(provider)}>
                解绑 {providerLabel(provider)}
              </Button>
            </div>
          );
        })
      )}

      {/* 绑定框:已绑定卡可"再加一个池";池子卡(无绑定)也显示,允许直接绑号 ——
          否则单账号卡解绑后变池子就再也绑不回去了(死路)。换绑见上方每行的「换绑到…」。 */}
      {addableAll.length > 0 && (
      <div className="flex items-center gap-2">
        <input
          className="h-8 w-32 rounded-md border border-input bg-background px-2 text-sm"
          placeholder="筛选账号…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">绑定账号…</option>
          {addableAccounts.map((a) => (
            <option
              key={`${a.provider}:${a.id}`}
              value={`${a.provider}:${a.id}`}
              disabled={a.usedShares + cardWeight > a.shareCapacity}
            >
              {providerLabel(a.provider)} · {a.email} ({a.usedShares}/{a.shareCapacity} 份)
            </option>
          ))}
        </select>
        <Button
          size="sm"
          disabled={!selected}
          onClick={() => {
            const [provider, id] = selected.split(":");
            if (provider && id) {
              onBind(provider, Number(id));
              setSelected("");
            }
          }}
        >
          绑定
        </Button>
      </div>
      )}
    </div>
  );
}
