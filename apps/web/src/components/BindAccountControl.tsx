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
          return (
            <div key={provider} className="flex items-center gap-2">
              <span className="text-sm">{label}</span>
              <Button size="sm" variant="outline" onClick={() => onUnbind(provider)}>
                解绑 {providerLabel(provider)}
              </Button>
            </div>
          );
        })
      )}

      {/* 仅对"已是绑定卡"的(至少绑了一个池)显示添加绑定框 —— 池子卡(无绑定)
          就是不绑号,不显示绑定框。池子/绑定的归属在建卡时由产品决定。 */}
      {boundProviders.length > 0 && addableAll.length > 0 && (
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
