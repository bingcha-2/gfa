"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Progress } from "@/components/ui/progress";

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Field, FieldLabel, FieldGroup } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiRequest, getErrorMessage } from "@/lib/console/client-api";

type GatewayUser = {
  id: string;
  email: string;
  motherAccountId: string;
  motherAccountName: string;
  shares: number;
  limitUsd: number;
  usedUsd: number;
  remainingUsd: number | null;
  quotaWindows: { period: "5h" | "7d"; usedUsd: number; limitUsd: number | null; resetAt: number | null }[];
  totalUsedUsd: number;
  totalRequests: number;
  lastUsedAt: string | null;
  periodStartedAt: string;
  enabled: boolean;
  keyHint: string;
  subscriptionName: string | null;
  subscriptionExpiresAt: string | null;
  subscriptionValid: boolean;
  subscriptionId: string | null;
  quotaSource: string;
  quotaReason: string;
  quotaOverrides: { fiveHour: number | null; weekly: number | null };
};

type Mother = { id: string; accountName: string; enabled: boolean; status: string };

const usd = (v: number) => `$${v.toFixed(v !== 0 && Math.abs(v) < 0.01 ? 6 : 2)}`;

export default function GatewayUsersPage() {
  const [rows, setRows] = useState<GatewayUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [assignOpen, setAssignOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [managedId, setManagedId] = useState<string | null>(null);
  const [mothers, setMothers] = useState<Mother[]>([]);
  const [motherId, setMotherId] = useState("");
  const [busy, setBusy] = useState(false);
  const managed = rows.find(u => u.id === managedId);
  const visible = rows.filter(u => u.email.toLowerCase().includes(query.toLowerCase()) &&
    (filter === "all" || (filter === "active" ? u.subscriptionValid && u.enabled : filter === "expired" ? !u.subscriptionValid : !u.enabled)));
  async function manage(u: GatewayUser) {
    setManagedId(u.id); setMotherId(u.motherAccountId); setMothers([]);
    try { setMothers(await apiRequest<Mother[]>("gateway-accounts")); }
    catch (err) { toast.error(getErrorMessage(err)); }
  }
  const [assigning, setAssigning] = useState(false);
  const [editingQuota, setEditingQuota] = useState<GatewayUser | null>(null);
  const [quotaForm, setQuotaForm] = useState({ fiveHour: "", weekly: "" });
  const [quotaSaving, setQuotaSaving] = useState(false);
  function editQuota(user: GatewayUser) {
    setQuotaForm({ fiveHour: user.quotaOverrides?.fiveHour?.toString() ?? "", weekly: user.quotaOverrides?.weekly?.toString() ?? "" });
    setEditingQuota(user);
  }
  async function saveQuota(restore = false) {
    if (!editingQuota) return;
    const value = (v: string) => v.trim() === "" ? null : Number(v);
    const values = restore ? { fiveHour: null, weekly: null } : { fiveHour: value(quotaForm.fiveHour), weekly: value(quotaForm.weekly) };
    if (Object.values(values).some(v => v !== null && (!Number.isFinite(v) || v < 0))) {
      toast.error("请输入非负金额"); return;
    }
    setQuotaSaving(true);
    try {
      await apiRequest(`gateway-users/${editingQuota.id}/quota`, { method: "PUT", body: { subscriptionId: editingQuota.subscriptionId, ...values } });
      toast.success(restore ? "已恢复套餐额度" : "额度已更新，已用量保持不变");
      setEditingQuota(null); await load();
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setQuotaSaving(false); }
  }

  const load = useCallback(async () => {
    try {
      setRows(await apiRequest<GatewayUser[]>("gateway-users"));
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function assign() {
    if (!email.trim()) return;
    setAssigning(true);
    try {
      const eligibility = await apiRequest<{ eligible: boolean; message: string }>(`gateway-users/eligibility?email=${encodeURIComponent(email.trim())}`);
      if (!eligibility.eligible) { toast.error(eligibility.message); return; }
      await apiRequest("gateway-users", {
        method: "POST",
        body: { email: email.trim() },
      });
      toast.success("已分配");
      setEmail("");
      setAssignOpen(false);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setAssigning(false);
    }
  }

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-xl font-semibold">网关用户</h1><p className="text-sm text-muted-foreground">查看订阅、剩余额度与账号分配。</p></div>
        <div className="flex gap-2"><Button variant="outline" onClick={load} aria-label="刷新用户"><RefreshCwIcon />刷新</Button><Button onClick={() => setAssignOpen(true)}><PlusIcon />分配用户</Button></div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Input className="max-w-sm" aria-label="搜索用户" placeholder="搜索用户邮箱" value={query} onChange={e => setQuery(e.target.value)} />
        <select aria-label="筛选状态" className="h-9 rounded-md border bg-background px-3 text-sm" value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="all">全部状态</option><option value="active">订阅有效且启用</option><option value="expired">无有效订阅</option><option value="disabled">已停用</option>
        </select>
        <span className="text-sm text-muted-foreground">{visible.length} 位用户</span>
      </div>
      <Card>
        <CardContent>
          {loading ? <Spinner /> : <Table>
            <TableHeader><TableRow>
              <TableHead>用户</TableHead><TableHead>订阅</TableHead><TableHead>五小时额度</TableHead><TableHead>每周额度</TableHead><TableHead>分配母号</TableHead><TableHead className="text-right">操作</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {visible.map(u => <TableRow key={u.id}>
                <TableCell><div className="flex flex-col items-start gap-1"><span className="max-w-52 truncate font-medium" title={u.email}>{u.email}</span>{!u.enabled && <Badge variant="secondary">已停用</Badge>}</div></TableCell>
                <TableCell><div className="flex flex-col items-start gap-1">
                  <span>{u.subscriptionName ?? (u.subscriptionValid ? "Claude 套餐" : "无有效订阅")}</span>
                  <span className="text-xs text-muted-foreground">{u.subscriptionValid ? u.subscriptionExpiresAt ? `${new Date(u.subscriptionExpiresAt).toLocaleDateString()} 到期` : "有效 · 未设置到期时间" : "请续费或购买套餐"}</span>
                </div></TableCell>
                {(["5h", "7d"] as const).map(period => {
                  const w = u.quotaWindows?.find(w => w.period === period);
                  const custom = u.quotaOverrides?.[period === "5h" ? "fiveHour" : "weekly"] != null;
                  const remaining = w?.limitUsd ? Math.max(0, Math.min(100, 100 * (1 - w.usedUsd / w.limitUsd))) : null;
                  return <TableCell key={period} className="min-w-44">
                    {w ? <div className="flex flex-col gap-2 py-2">
                      <div className="flex items-center justify-between gap-2"><span className="text-sm tabular-nums">{remaining === null ? "不限额" : `剩余 ${remaining.toFixed(0)}%`}</span>{custom && <Badge variant="outline">自定义</Badge>}</div>
                      {remaining !== null && <Progress value={remaining} aria-label={`${period === "5h" ? "五小时" : "每周"}剩余额度`} />}
                      <span className="text-xs tabular-nums">{usd(w.usedUsd)} / {w.limitUsd === null ? "不限额" : usd(w.limitUsd)}</span>
                      <span className="text-xs text-muted-foreground">{w.resetAt ? `重置 ${new Date(w.resetAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "重置时间待更新"}</span>
                    </div> : <span className="text-xs text-muted-foreground">{!u.subscriptionValid ? "—" : u.quotaReason === "quota_configuration_invalid" ? "请配置套餐额度" : "暂停服务"}</span>}
                  </TableCell>;
                })}
                <TableCell><span className="block max-w-44 truncate text-sm" title={u.motherAccountName}>{u.motherAccountName ?? "未分配"}</span></TableCell>
                <TableCell className="text-right"><Button variant="outline" size="sm" onClick={() => manage(u)}>管理</Button></TableCell>
              </TableRow>)}
              {visible.length === 0 && <TableRow><TableCell colSpan={6} className="py-12 text-center text-muted-foreground">{rows.length ? "没有匹配的用户" : "暂无用户，点击“分配用户”开始"}</TableCell></TableRow>}
            </TableBody>
          </Table>}
        </CardContent>
      </Card>
      <Dialog open={assignOpen} onOpenChange={open => { if (!assigning) setAssignOpen(open); }}>
        <DialogContent><DialogHeader><DialogTitle>分配用户</DialogTitle><DialogDescription>仅限有效 Claude 订阅。系统自动选择可用母号，每位用户占一个名额。</DialogDescription></DialogHeader>
          <Field><FieldLabel htmlFor="assign-email">用户邮箱</FieldLabel><Input id="assign-email" type="email" placeholder="用户邮箱" value={email} onChange={e => setEmail(e.target.value)} /></Field>
          <DialogFooter><Button disabled={assigning || !email.trim()} onClick={assign}>{assigning && <Spinner />}分配</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Sheet open={!!managed} onOpenChange={open => { if (!open && !busy) setManagedId(null); }}>
        <SheetContent className="overflow-y-auto sm:max-w-lg">
          <SheetHeader><SheetTitle>用户管理</SheetTitle><SheetDescription className="break-all">{managed?.email}</SheetDescription></SheetHeader>
          {managed && <div className="flex flex-col gap-7 px-4 pb-6">
            <section className="flex flex-col gap-3"><h2 className="font-medium">订阅与额度</h2>
              <p className="text-sm text-muted-foreground">{managed.subscriptionName ?? "无有效订阅"} · {managed.quotaSource === "custom" ? "自定义额度" : "套餐额度"}</p>
              <Button variant="outline" disabled={!managed.subscriptionValid || !managed.subscriptionId} onClick={() => editQuota(managed)}>调整额度</Button>
            </section>
            <section className="flex flex-col gap-3"><h2 className="font-medium">账号分配</h2>
              <Field><FieldLabel htmlFor="mother-select">母号</FieldLabel>
                <select id="mother-select" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={motherId} onChange={e => setMotherId(e.target.value)}>
                  {!mothers.some(m => m.id === managed.motherAccountId) && <option value={managed.motherAccountId}>{managed.motherAccountName}</option>}
                  {mothers.map(m => <option key={m.id} value={m.id} disabled={!m.enabled || m.status !== "ready"}>{m.accountName}{!m.enabled || m.status !== "ready" ? "（不可用）" : ""}</option>)}
                </select>
              </Field>
              <Button variant="outline" disabled={busy || !managed.subscriptionValid || motherId === managed.motherAccountId} onClick={() => act(() => apiRequest(`gateway-users/${managed.id}`, { method: "PATCH", body: { motherAccountId: motherId } }), "已更换母号，已用量保持不变")}>更换母号</Button>
              <div className="flex items-center justify-between"><label htmlFor="user-enabled" className="text-sm">启用服务</label><Switch id="user-enabled" checked={managed.enabled} disabled={busy} onCheckedChange={enabled => act(() => apiRequest(`gateway-users/${managed.id}`, { method: "PATCH", body: { enabled } }), "已更新")} /></div>
            </section>
            <section className="flex flex-col gap-3"><h2 className="font-medium">使用记录</h2>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm"><dt className="text-muted-foreground">累计折算金额</dt><dd>{usd(managed.totalUsedUsd)}</dd><dt className="text-muted-foreground">累计请求</dt><dd>{managed.totalRequests} 次</dd><dt className="text-muted-foreground">最近使用</dt><dd>{managed.lastUsedAt ? new Date(managed.lastUsedAt).toLocaleString() : "暂无记录"}</dd></dl>
            </section>
            <section className="flex flex-col gap-3"><h2 className="font-medium">密钥与维护</h2><p className="text-sm text-muted-foreground">当前 Key：{managed.keyHint ?? "—"}</p>
              <Button variant="outline" disabled={busy} onClick={() => window.confirm("更换后旧 Key 立即失效，用户需要重新接管。继续？") && act(() => apiRequest(`gateway-users/${managed.id}/rotate-key`, { method: "POST" }), "已更换 Key")}>更换 Key</Button>
              <Button variant="outline" disabled={busy} onClick={() => window.confirm("清零该用户本周期已用量？") && act(() => apiRequest(`gateway-users/${managed.id}/reset`, { method: "POST" }), "已清零")}>清零本周期用量</Button>
              <Button variant="destructive" disabled={busy} onClick={() => window.confirm("删除用户分配及其用量明细？此操作不可恢复。") && act(() => apiRequest(`gateway-users/${managed.id}`, { method: "DELETE" }), "已删除分配")}>删除分配</Button>
            </section>
          </div>}
        </SheetContent>
      </Sheet>
      <Dialog open={editingQuota !== null} onOpenChange={open => { if (!open && !quotaSaving) setEditingQuota(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>调整用户额度</DialogTitle>
            <DialogDescription>{editingQuota?.email} · 仅当前订阅有效；续费后恢复套餐额度。调整不会清零已用量。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {(["fiveHour", "weekly"] as const).map(period => <Field key={period}>
              <FieldLabel htmlFor={`quota-${period}`}>{period === "fiveHour" ? "五小时上限（美元）" : "每周上限（美元）"}</FieldLabel>
              <Input id={`quota-${period}`} type="number" min="0" step="any" placeholder="留空跟随套餐，0 表示不限额" value={quotaForm[period]} onChange={e => setQuotaForm({ ...quotaForm, [period]: e.target.value })} />
              <span className="text-xs text-muted-foreground">{quotaForm[period] === "" ? "跟随套餐" : Number(quotaForm[period]) === 0 ? "不限额" : "自定义金额"}</span>
            </Field>)}
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" disabled={quotaSaving} onClick={() => saveQuota(true)}>恢复套餐额度</Button>
            <Button disabled={quotaSaving} onClick={() => saveQuota()}>{quotaSaving ? <Spinner /> : null}保存额度</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
