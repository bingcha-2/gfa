"use client";
import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ChevronRightIcon } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type FairShare = Record<string, { fraction: number; resetAt: number }>;
type Card_ = { id: string; name: string; weight: number; windowWeightedUsed: number; totalTokensUsed: number; totalRequests: number; fairShare: FairShare };
type Account = { id: number; email: string; planType: string; quotaStatus: string; boundCards: Card_[] };

function minFraction(fs: FairShare): number | null {
  const v = Object.values(fs).map((f) => f.fraction); return v.length ? Math.min(...v) : null;
}
function barColor(pct: number) { return pct >= 50 ? "#22c55e" : pct >= 20 ? "#f59e0b" : "#ef4444"; }

export function BoundCardAccordion({ accounts }: { accounts: Account[] }) {
  const [warnOnly, setWarnOnly] = useState(false);
  const shown = accounts.filter((a) => !warnOnly || a.boundCards.some((c) => { const f = minFraction(c.fairShare); return f !== null && f < 0.2; }));
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm">绑定卡明细</CardTitle>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">只看告警账号 <Switch checked={warnOnly} onCheckedChange={setWarnOnly} /></label>
      </CardHeader>
      <CardContent className="space-y-2">
        {shown.length === 0 && <div className="py-4 text-center text-xs text-muted-foreground">无符合条件的账号</div>}
        {shown.map((a) => {
          const worst = Math.min(100, ...a.boundCards.map((c) => { const f = minFraction(c.fairShare); return f === null ? 100 : Math.round(f * 100); }));
          return (
            <Collapsible key={a.id} className="rounded-lg border">
              <CollapsibleTrigger className="flex w-full items-center gap-2 p-3 text-sm [&[data-panel-open]>svg]:rotate-90">
                <ChevronRightIcon className="size-3 text-muted-foreground transition" />
                <span className="truncate font-medium">{a.email || `账号 #${a.id}`}</span>
                {a.planType && <Badge variant="secondary">{a.planType}</Badge>}
                <span className="ml-auto text-xs text-muted-foreground">{a.boundCards.length} 卡 · 份额最紧 {worst}%</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="border-t px-3 py-2">
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>卡</TableHead><TableHead className="text-center">权重</TableHead>
                      <TableHead className="text-right">本窗口已用</TableHead><TableHead className="text-right">累计 Token</TableHead>
                      <TableHead className="w-32">份额剩余 <Badge variant="outline" className="ml-1 text-[9px]">估算</Badge></TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {a.boundCards.map((c) => {
                        const f = minFraction(c.fairShare); const pct = f === null ? null : Math.round(f * 100);
                        return (
                          <TableRow key={c.id}>
                            <TableCell className="max-w-[140px] truncate font-medium">{c.name || c.id}</TableCell>
                            <TableCell className="text-center"><Badge variant="secondary">×{c.weight}</Badge></TableCell>
                            <TableCell className="text-right tabular-nums">{Math.round(c.windowWeightedUsed).toLocaleString()}</TableCell>
                            <TableCell className="text-right tabular-nums">{c.totalTokensUsed.toLocaleString()}</TableCell>
                            <TableCell>{pct === null ? <span className="text-xs text-muted-foreground">—</span> : (
                              <div className="flex items-center gap-2"><div className="h-2 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full" style={{ width: `${Math.max(2, pct)}%`, background: barColor(pct) }} /></div><span className="w-8 text-right text-xs tabular-nums">{pct}%</span></div>
                            )}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </CardContent>
    </Card>
  );
}
