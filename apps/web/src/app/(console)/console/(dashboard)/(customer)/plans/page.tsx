"use client";

import { useState, useEffect, useCallback } from "react";
import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import { toast } from "sonner";
import type { ConsolePlan } from "@/lib/console/types";

import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Plus, Pencil, Trash2 } from "lucide-react";

const PRODUCTS = [
  { key: "antigravity", label: "Antigravity" },
  { key: "codex", label: "Codex" },
  { key: "anthropic", label: "Anthropic" },
];

type FormState = {
  name: string;
  description: string;
  priceYuan: string;
  durationDays: string;
  products: string[];
  weight: string;
  deviceLimit: string;
  weeklyTokenLimit: string;
  windowMs: string;
  bucketLimits: string;
  levels: string;
  active: boolean;
  sortOrder: string;
};

const EMPTY_FORM: FormState = {
  name: "", description: "", priceYuan: "", durationDays: "30",
  products: [], weight: "1", deviceLimit: "1", weeklyTokenLimit: "",
  windowMs: "18000000", bucketLimits: "", levels: "", active: true, sortOrder: "0",
};

function parseProducts(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export default function PlansPage() {
  const [plans, setPlans] = useState<ConsolePlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiRequest<ConsolePlan[]>("plans");
      setPlans([...data].sort((a, b) => a.sortOrder - b.sortOrder));
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditId(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(p: ConsolePlan) {
    setEditId(p.id);
    setForm({
      name: p.name,
      description: p.description ?? "",
      priceYuan: (p.priceCents / 100).toString(),
      durationDays: p.durationDays.toString(),
      products: parseProducts(p.productEntitlements),
      weight: p.weight.toString(),
      deviceLimit: p.deviceLimit.toString(),
      weeklyTokenLimit: p.weeklyTokenLimit != null ? p.weeklyTokenLimit.toString() : "",
      windowMs: p.windowMs.toString(),
      bucketLimits: p.bucketLimits ?? "",
      levels: p.levels ?? "",
      active: p.active,
      sortOrder: p.sortOrder.toString(),
    });
    setDialogOpen(true);
  }

  function buildPayload(): Record<string, unknown> | null {
    const name = form.name.trim();
    if (!name) return toast.error("请填写套餐名称"), null;

    const priceYuan = Number(form.priceYuan);
    if (!Number.isFinite(priceYuan) || priceYuan < 0) return toast.error("价格无效"), null;

    const durationDays = parseInt(form.durationDays, 10);
    if (!Number.isInteger(durationDays) || durationDays < 1) return toast.error("时长需 ≥ 1 天"), null;

    if (form.products.length === 0) return toast.error("请至少选择一个产品线"), null;

    const weight = parseInt(form.weight, 10);
    if (!Number.isInteger(weight) || weight < 1 || weight > 8) return toast.error("拼车权重需在 1–8"), null;

    const deviceLimit = parseInt(form.deviceLimit, 10);
    if (!Number.isInteger(deviceLimit) || deviceLimit < 1) return toast.error("设备上限需 ≥ 1"), null;

    const sortOrder = parseInt(form.sortOrder, 10);
    if (!Number.isInteger(sortOrder)) return toast.error("排序需为整数"), null;

    const windowMs = parseInt(form.windowMs, 10);
    if (!Number.isInteger(windowMs) || windowMs < 60000) return toast.error("窗口需 ≥ 60000ms"), null;

    let bucketLimits: unknown = null;
    if (form.bucketLimits.trim()) {
      try { bucketLimits = JSON.parse(form.bucketLimits); }
      catch { return toast.error("bucketLimits 不是合法 JSON"), null; }
    }
    let levels: unknown = null;
    if (form.levels.trim()) {
      try { levels = JSON.parse(form.levels); }
      catch { return toast.error("levels 不是合法 JSON"), null; }
    }

    const payload: Record<string, unknown> = {
      name,
      description: form.description.trim() || undefined,
      priceCents: Math.round(priceYuan * 100),
      durationDays,
      products: form.products,
      weight,
      deviceLimit,
      windowMs,
      bucketLimits,
      levels,
      active: form.active,
      sortOrder,
    };

    const wtl = form.weeklyTokenLimit.trim();
    if (wtl) {
      const n = parseInt(wtl, 10);
      if (!Number.isInteger(n) || n < 1) return toast.error("周 Token 上限无效"), null;
      payload.weeklyTokenLimit = n;
    } else {
      payload.weeklyTokenLimit = null;
    }
    return payload;
  }

  async function handleSave() {
    const payload = buildPayload();
    if (!payload) return;
    try {
      setSaving(true);
      if (editId) {
        await apiRequest(`plans/${editId}`, { method: "PATCH", body: payload });
        toast.success("套餐已更新");
      } else {
        await apiRequest("plans", { method: "POST", body: payload });
        toast.success("套餐已创建");
      }
      setDialogOpen(false);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(p: ConsolePlan) {
    try {
      await apiRequest(`plans/${p.id}`, { method: "DELETE" });
      toast.success(`套餐「${p.name}」已删除`);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  function toggleProduct(key: string) {
    setForm((f) => ({
      ...f,
      products: f.products.includes(key)
        ? f.products.filter((p) => p !== key)
        : [...f.products, key],
    }));
  }

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>套餐配置</CardTitle>
              <CardDescription>
                管理可购买的订阅套餐：价格、时长、产品线、拼车权重与额度
              </CardDescription>
            </div>
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4 mr-2" />
              新建套餐
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {plans.length === 0 ? (
            <div className="text-sm text-muted-foreground py-10 text-center">
              暂无套餐，点击右上角「新建套餐」。
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>价格</TableHead>
                  <TableHead>时长</TableHead>
                  <TableHead>产品线</TableHead>
                  <TableHead>设备</TableHead>
                  <TableHead>权重</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>排序</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plans.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell>¥{(p.priceCents / 100).toFixed(2)}</TableCell>
                    <TableCell>{p.durationDays} 天</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {parseProducts(p.productEntitlements).map((pr) => (
                          <Badge key={pr} variant="secondary" className="text-xs">
                            {pr}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>{p.deviceLimit}</TableCell>
                    <TableCell>{p.weight}</TableCell>
                    <TableCell>
                      {p.active ? (
                        <Badge className="bg-emerald-500 text-white">启用</Badge>
                      ) : (
                        <Badge variant="outline">停用</Badge>
                      )}
                    </TableCell>
                    <TableCell>{p.sortOrder}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(p)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger
                            render={<Button variant="ghost" size="sm" className="text-destructive" />}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>删除套餐？</AlertDialogTitle>
                              <AlertDialogDescription>
                                确认删除套餐「{p.name}」？被订阅或订单引用的套餐无法删除，请改为「停用」。
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>取消</AlertDialogCancel>
                              <AlertDialogAction onClick={() => void handleDelete(p)}>
                                确认删除
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editId ? "编辑套餐" : "新建套餐"}</DialogTitle>
            <DialogDescription>配置套餐的价格、时长、产品线与拼车参数</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Label>名称</Label>
                <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="mt-1" />
              </div>
              <div className="col-span-2">
                <Label>描述</Label>
                <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} className="mt-1" placeholder="可选" />
              </div>
              <div>
                <Label>价格（元）</Label>
                <Input type="number" min={0} step="0.01" value={form.priceYuan} onChange={(e) => setForm((f) => ({ ...f, priceYuan: e.target.value }))} className="mt-1" />
              </div>
              <div>
                <Label>时长（天）</Label>
                <Input type="number" min={1} value={form.durationDays} onChange={(e) => setForm((f) => ({ ...f, durationDays: e.target.value }))} className="mt-1" />
              </div>
              <div>
                <Label>拼车权重（1–8）</Label>
                <Input type="number" min={1} max={8} value={form.weight} onChange={(e) => setForm((f) => ({ ...f, weight: e.target.value }))} className="mt-1" />
              </div>
              <div>
                <Label>设备上限</Label>
                <Input type="number" min={1} value={form.deviceLimit} onChange={(e) => setForm((f) => ({ ...f, deviceLimit: e.target.value }))} className="mt-1" />
              </div>
              <div>
                <Label>周 Token 上限</Label>
                <Input type="number" min={1} value={form.weeklyTokenLimit} onChange={(e) => setForm((f) => ({ ...f, weeklyTokenLimit: e.target.value }))} className="mt-1" placeholder="可选" />
              </div>
              <div>
                <Label>窗口（ms）</Label>
                <Input type="number" min={60000} value={form.windowMs} onChange={(e) => setForm((f) => ({ ...f, windowMs: e.target.value }))} className="mt-1" />
              </div>
              <div>
                <Label>排序</Label>
                <Input type="number" value={form.sortOrder} onChange={(e) => setForm((f) => ({ ...f, sortOrder: e.target.value }))} className="mt-1" />
              </div>
            </div>

            <div>
              <Label>产品线</Label>
              <div className="flex gap-4 mt-2">
                {PRODUCTS.map((pr) => (
                  <div key={pr.key} className="flex items-center gap-2">
                    <Checkbox
                      id={`prod-${pr.key}`}
                      checked={form.products.includes(pr.key)}
                      onCheckedChange={() => toggleProduct(pr.key)}
                    />
                    <Label htmlFor={`prod-${pr.key}`} className="cursor-pointer">{pr.label}</Label>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <Label>bucketLimits（每模型额度，JSON，可选）</Label>
              <Textarea
                value={form.bucketLimits}
                onChange={(e) => setForm((f) => ({ ...f, bucketLimits: e.target.value }))}
                className="mt-1 font-mono text-xs"
                rows={2}
                placeholder='{"claude-sonnet-4":1000000}'
              />
            </div>
            <div>
              <Label>levels（每产品等级，JSON，可选）</Label>
              <Textarea
                value={form.levels}
                onChange={(e) => setForm((f) => ({ ...f, levels: e.target.value }))}
                className="mt-1 font-mono text-xs"
                rows={2}
                placeholder='{"anthropic":"pro"}'
              />
            </div>

            <div className="flex items-center gap-2">
              <Switch id="active" checked={form.active} onCheckedChange={(v) => setForm((f) => ({ ...f, active: v }))} />
              <Label htmlFor="active" className="cursor-pointer">启用（关闭则不在购买页展示）</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving ? "保存中…" : editId ? "保存" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
