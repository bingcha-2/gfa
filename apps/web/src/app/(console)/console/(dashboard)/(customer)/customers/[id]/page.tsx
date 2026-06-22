"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import { toast } from "sonner";
import type {
  ConsoleCustomerDetail, ConsoleSubscriptionLite, ConsoleSubscription,
} from "@/lib/console/types";
import {
  fmtYuan, fmtDateTime, ORDER_STATUS_LABEL, SUB_STATUS_LABEL, PAY_CHANNEL_LABEL,
} from "@/lib/console/format";
import { buildSubscriptionView } from "@/lib/console/subscription-view";
import { orderAction } from "@/lib/console/order-action";
import { GrantSubscriptionDialog } from "./grant-subscription-dialog";
import { SubscriptionDetailDrawer } from "../../subscriptions/subscription-detail-drawer";

import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, Ban, CircleCheck, Pencil, Plus, RefreshCw } from "lucide-react";

function subStatusBadge(status: string) {
  if (status === "ACTIVE") return <Badge className="bg-emerald-500 text-white">{SUB_STATUS_LABEL[status]}</Badge>;
  if (status === "CANCELLED") return <Badge variant="destructive">{SUB_STATUS_LABEL[status]}</Badge>;
  return <Badge variant="outline">{SUB_STATUS_LABEL[status] ?? status}</Badge>;
}

function selectionName(json: string | null | undefined): string {
  if (!json) return "—";
  try {
    const s = JSON.parse(json);
    if (!s || typeof s !== "object" || !("line" in s)) return "—";
    const line = s.line === "bind" ? "绑定" : "号池";
    const products = s.line === "bind"
      ? (s.items ?? []).map((i: { product: string }) => i.product)
      : s.products ?? [];
    return `${line} ${products.join("+") || "套餐"}`;
  } catch { return "—"; }
}

function toDatetimeLocal(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function fromDatetimeLocal(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function remainingDays(value: string | null): string {
  if (!value) return "长期";
  const ms = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "已到期";
  return `${Math.ceil(ms / (24 * 60 * 60 * 1000))} 天`;
}

function orderStatusBadge(status: string) {
  if (status === "PAID") return <Badge className="bg-emerald-500 text-white">{ORDER_STATUS_LABEL[status]}</Badge>;
  if (status === "REFUNDED") return <Badge variant="destructive">{ORDER_STATUS_LABEL[status]}</Badge>;
  if (status === "PENDING") return <Badge className="bg-amber-500 text-white">{ORDER_STATUS_LABEL[status]}</Badge>;
  return <Badge variant="outline">{ORDER_STATUS_LABEL[status] ?? status}</Badge>;
}

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [c, setC] = useState<ConsoleCustomerDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({ displayName: "", creditYuan: "" });

  const [grantOpen, setGrantOpen] = useState(false);
  const [detail, setDetail] = useState<ConsoleSubscription | null>(null);
  const [subEditOpen, setSubEditOpen] = useState(false);
  const [editingSub, setEditingSub] = useState<ConsoleSubscriptionLite | null>(null);
  const [subEditForm, setSubEditForm] = useState({ expiresAt: "" });
  const [savingSub, setSavingSub] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const d = await apiRequest<ConsoleCustomerDetail>(`customers/${id}`);
      setC(d);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) void load();
  }, [load, id]);

  async function toggleBan() {
    if (!c) return;
    const next = c.status === "DISABLED" ? "ACTIVE" : "DISABLED";
    try {
      await apiRequest(`customers/${c.id}`, { method: "PATCH", body: { status: next } });
      toast.success(next === "DISABLED" ? "已封禁" : "已解封");
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  function openEdit() {
    if (!c) return;
    setEditForm({ displayName: c.displayName ?? "", creditYuan: (c.creditCents / 100).toString() });
    setEditOpen(true);
  }

  async function saveEdit() {
    if (!c) return;
    const creditYuan = Number(editForm.creditYuan);
    if (!Number.isFinite(creditYuan)) { toast.error("额度无效"); return; }
    try {
      await apiRequest(`customers/${c.id}`, {
        method: "PATCH",
        body: { displayName: editForm.displayName.trim(), creditCents: Math.round(creditYuan * 100) },
      });
      toast.success("已保存");
      setEditOpen(false);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  async function syncOrder(orderId: string) {
    try {
      const res = await apiRequest<{ synced: boolean; message: string }>(`plan-orders/${orderId}/sync`, { method: "POST" });
      if (res.synced) {
        toast.success(res.message);
      } else {
        toast.info(res.message);
      }
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  async function revoke(sub: ConsoleSubscriptionLite) {
    try {
      await apiRequest(`subscriptions/${sub.id}/revoke`, { method: "POST" });
      toast.success("订阅已取消");
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  function openSubEdit(sub: ConsoleSubscriptionLite) {
    setEditingSub(sub);
    setSubEditForm({ expiresAt: toDatetimeLocal(sub.expiresAt) });
    setSubEditOpen(true);
  }

  async function saveSubEdit() {
    if (!editingSub) return;
    const expiresAt = fromDatetimeLocal(subEditForm.expiresAt);
    if (!expiresAt) {
      toast.error("请选择有效的到期时间");
      return;
    }
    try {
      setSavingSub(true);
      await apiRequest(`subscriptions/${editingSub.id}`, {
        method: "PATCH",
        body: { expiresAt },
      });
      toast.success("订阅到期时间已更新");
      setSubEditOpen(false);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSavingSub(false);
    }
  }

  if (loading) {
    return <div className="space-y-4"><Skeleton className="h-8 w-40" /><Skeleton className="h-40 w-full" /></div>;
  }
  if (!c) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/console/customers" />}><ArrowLeft className="h-4 w-4 mr-1" />返回</Button>
        <div className="text-sm text-muted-foreground">未找到该客户。</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/console/customers" />}><ArrowLeft className="h-4 w-4 mr-1" />客户列表</Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2">
                {c.email}
                {c.status === "DISABLED" ? <Badge variant="destructive">已封禁</Badge> : <Badge className="bg-emerald-500 text-white">正常</Badge>}
                {c.emailVerified && <Badge variant="secondary">已验证</Badge>}
              </CardTitle>
              <div className="text-sm text-muted-foreground">
                {c.displayName || "（无昵称）"} · 邀请码 {c.referralCode} · 返佣余额 {fmtYuan(c.creditCents)}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>分享链接</span>
                <code className="truncate max-w-[26rem] rounded bg-muted px-1.5 py-0.5">{c.referralLink}</code>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2"
                  onClick={() => {
                    void navigator.clipboard?.writeText(c.referralLink);
                    toast.success("已复制分享链接");
                  }}
                >
                  复制
                </Button>
              </div>
              <div className="text-xs text-muted-foreground">注册于 {fmtDateTime(c.createdAt)}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button variant="outline" size="sm" onClick={openEdit}><Pencil className="h-3.5 w-3.5 mr-1" />备注/额度</Button>
              <Button variant="outline" size="sm" onClick={() => setGrantOpen(true)}><Plus className="h-3.5 w-3.5 mr-1" />发放订阅</Button>
              <AlertDialog>
                <AlertDialogTrigger render={<Button variant="outline" size="sm" className={c.status === "DISABLED" ? "text-emerald-600" : "text-destructive"} />}>
                  {c.status === "DISABLED" ? <><CircleCheck className="h-3.5 w-3.5 mr-1" />解封</> : <><Ban className="h-3.5 w-3.5 mr-1" />封禁</>}
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{c.status === "DISABLED" ? "解封客户？" : "封禁客户？"}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {c.status === "DISABLED"
                        ? "解封后该客户可重新登录。"
                        : "封禁会立即使其所有登录态失效（强制下线），但不影响已有订阅。"}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void toggleBan()}>确认</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="subs">
            <TabsList>
              <TabsTrigger value="subs">订阅 ({c.subscriptions.length})</TabsTrigger>
              <TabsTrigger value="orders">订单 ({c.planOrders.length})</TabsTrigger>
              <TabsTrigger value="devices">设备 ({c.devices.length})</TabsTrigger>
            </TabsList>

            <TabsContent value="subs" className="pt-3">
              {c.subscriptions.length === 0 ? (
                <div className="text-sm text-muted-foreground py-6 text-center">暂无订阅。</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>套餐</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>开始</TableHead>
                      <TableHead>到期</TableHead>
                      <TableHead className="text-center">权重</TableHead>
                      <TableHead className="text-center">设备</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {c.subscriptions.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="font-medium">
                          <button className="text-blue-600 hover:underline" onClick={() => setDetail({ ...s, customerId: c.id, customer: { email: c.email }, line: undefined, plan: null } as ConsoleSubscription)}>
                            {selectionName(s.config)}
                          </button>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {buildSubscriptionView(s).rows.map((r) =>
                              r.bound ? `${r.product}→#${r.accountId}` : r.level ? `${r.product}→未绑定` : r.product
                            ).join(" · ")}
                          </div>
                        </TableCell>
                        <TableCell>{subStatusBadge(s.status)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{fmtDateTime(s.startsAt)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{fmtDateTime(s.expiresAt)}</TableCell>
                        <TableCell className="text-center">{s.weight}</TableCell>
                        <TableCell className="text-center">{s.deviceLimit}</TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" onClick={() => openSubEdit(s)}>
                            <Pencil className="h-3.5 w-3.5 mr-1" />编辑
                          </Button>
                          {s.status === "ACTIVE" && (
                            <AlertDialog>
                              <AlertDialogTrigger render={<Button variant="ghost" size="sm" className="text-destructive" />}>取消</AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>取消订阅？</AlertDialogTitle>
                                  <AlertDialogDescription>确认取消该订阅「{selectionName(s.config) || s.id}」？取消后对应席位将被释放，客户会收到通知。</AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>返回</AlertDialogCancel>
                                  <AlertDialogAction onClick={() => void revoke(s)}>确认取消</AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </TabsContent>

            <TabsContent value="orders" className="pt-3">
              {c.planOrders.length === 0 ? (
                <div className="text-sm text-muted-foreground py-6 text-center">暂无订单。</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>单号</TableHead>
                      <TableHead>套餐</TableHead>
                      <TableHead className="text-right">金额</TableHead>
                      <TableHead className="text-right">余额抵扣</TableHead>
                      <TableHead>渠道</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>支付时间</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {c.planOrders.map((o) => (
                      <TableRow key={o.id}>
                        <TableCell className="font-mono text-xs">{o.outTradeNo}</TableCell>
                        <TableCell>{selectionName(o.selection)}</TableCell>
                        <TableCell className="text-right">{fmtYuan(o.amountCents)}</TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {o.creditAppliedCents > 0 ? `-${fmtYuan(o.creditAppliedCents)}` : "—"}
                        </TableCell>
                        <TableCell>{PAY_CHANNEL_LABEL[o.payChannel] ?? o.payChannel}</TableCell>
                        <TableCell>{orderStatusBadge(o.status)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{fmtDateTime(o.paidAt)}</TableCell>
                        <TableCell className="text-right flex items-center justify-end gap-1">
                          {(o.status === "PENDING" || o.status === "EXPIRED") && (
                            <Button variant="ghost" size="sm" onClick={() => void syncOrder(o.id)}>
                              <RefreshCw className="h-3.5 w-3.5 mr-1" />查询支付
                            </Button>
                          )}
                          {(() => {
                            const act = orderAction({ payChannel: o.payChannel, status: o.status });
                            if (act.kind === "none") return null;
                            const onConfirm = async () => {
                              try {
                                if (act.kind === "revoke" && o.subscriptionId) await apiRequest(`subscriptions/${o.subscriptionId}/revoke`, { method: "POST" });
                                else await apiRequest(`plan-orders/${o.id}/refund`, { method: "POST" });
                                toast.success(`已${act.label}`);
                                await load();
                              } catch (err) { toast.error(getErrorMessage(err)); }
                            };
                            return (
                              <AlertDialog>
                                <AlertDialogTrigger render={<Button variant="ghost" size="sm" className="text-destructive" />}>{act.label}</AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>{act.label}？</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      {act.kind === "revoke"
                                        ? `订单 ${o.outTradeNo} 为管理员发放(¥0),将撤销授权并取消对应订阅、释放席位,不涉及退款。`
                                        : `确认对订单 ${o.outTradeNo}(${fmtYuan(o.amountCents)})退款?仅未使用的订单可退,原路退回并取消订阅。`}
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>取消</AlertDialogCancel>
                                    <AlertDialogAction onClick={() => void onConfirm()}>确认{act.label}</AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            );
                          })()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </TabsContent>

            <TabsContent value="devices" className="pt-3">
              {c.devices.length === 0 ? (
                <div className="text-sm text-muted-foreground py-6 text-center">暂无设备。</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>设备</TableHead>
                      <TableHead>平台</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>最近活跃</TableHead>
                      <TableHead>最近 IP</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {c.devices.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell>
                          <div className="font-medium">{d.name || "（未命名）"}</div>
                          <div className="font-mono text-xs text-muted-foreground">{d.deviceId}</div>
                        </TableCell>
                        <TableCell>{d.platform ?? "—"}</TableCell>
                        <TableCell>{d.status === "ACTIVE" ? <Badge className="bg-emerald-500 text-white">活跃</Badge> : <Badge variant="outline">已撤销</Badge>}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{fmtDateTime(d.lastSeenAt)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{d.lastIp ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* 编辑备注/额度 */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>编辑客户</DialogTitle>
            <DialogDescription>修改昵称与返佣余额</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div><Label>昵称</Label><Input value={editForm.displayName} onChange={(e) => setEditForm((f) => ({ ...f, displayName: e.target.value }))} className="mt-1" /></div>
            <div><Label>返佣余额（元）</Label><Input type="number" step="0.01" value={editForm.creditYuan} onChange={(e) => setEditForm((f) => ({ ...f, creditYuan: e.target.value }))} className="mt-1" /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>取消</Button>
            <Button onClick={() => void saveEdit()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 编辑订阅到期时间 */}
      <Dialog open={subEditOpen} onOpenChange={setSubEditOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>编辑订阅</DialogTitle>
            <DialogDescription>{editingSub ? selectionName(editingSub.config) : ""}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label htmlFor="subscription-expires-at">到期时间</Label>
              <Input
                id="subscription-expires-at"
                type="datetime-local"
                value={subEditForm.expiresAt}
                onChange={(e) => setSubEditForm({ expiresAt: e.target.value })}
                className="mt-1"
              />
            </div>
            <div className="rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              剩余 {remainingDays(fromDatetimeLocal(subEditForm.expiresAt))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSubEditOpen(false)} disabled={savingSub}>取消</Button>
            <Button onClick={() => void saveSubEdit()} disabled={savingSub}>
              {savingSub ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 手动发放订阅（目录版选配） */}
      <GrantSubscriptionDialog
        open={grantOpen}
        onOpenChange={setGrantOpen}
        customerId={c.id}
        onGranted={load}
      />

      <SubscriptionDetailDrawer sub={detail} open={!!detail} onOpenChange={(o) => !o && setDetail(null)} onChanged={load} />
    </div>
  );
}
