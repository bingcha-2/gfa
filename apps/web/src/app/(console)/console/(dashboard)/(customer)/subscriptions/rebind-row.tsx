"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Link2 } from "lucide-react";
import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SubProductRow } from "@/lib/console/subscription-view";

const PRODUCT_LABELS: Record<string, string> = { anthropic: "Anthropic", codex: "Codex", antigravity: "Antigravity" };
const LEVEL_LABELS: Record<string, string> = { pro: "Pro", "max-5x": "Max 5x", "max-20x": "Max 20x", plus: "Plus", ultra: "Ultra" };

export function RebindRow({ subId, row, onDone }: { subId: string; row: SubProductRow; onDone: () => void | Promise<void> }) {
  const [accountId, setAccountId] = useState("");
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const id = Number(accountId);
    if (!(id > 0)) { toast.error("请填写有效的账号 ID"); return; }
    setBusy(true);
    try {
      await apiRequest(`subscriptions/${subId}/rebind`, { method: "POST", body: { product: row.product, accountId: id, force } });
      toast.success(`已将「${PRODUCT_LABELS[row.product] ?? row.product}」绑定切到账号 #${id}`);
      setAccountId("");
      await onDone();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 py-2 border-t first:border-t-0">
      <span className="font-medium text-sm w-24">{PRODUCT_LABELS[row.product] ?? row.product}</span>
      <span className="text-xs text-muted-foreground w-16">{row.level ? (LEVEL_LABELS[row.level] ?? row.level) : "—"}</span>
      <span className="text-sm flex-1 min-w-32">
        {row.bound
          ? <a className="text-blue-600 underline-offset-2 hover:underline" href={`/console/codex-accounts?focus=${row.accountId}`}>当前 #{row.accountId} ↗</a>
          : <span className="text-destructive">⚠ 未绑定</span>}
      </span>
      <Input type="number" placeholder="目标账号 ID" value={accountId} onChange={(e) => setAccountId(e.target.value)} className="w-32 h-8" />
      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> 强制
      </label>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void submit()}>
        <Link2 className="h-3.5 w-3.5 mr-1" />{row.bound ? "换绑" : "绑号"}
      </Button>
    </div>
  );
}
