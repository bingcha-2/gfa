"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PlusIcon, RotateCcwIcon, KeyRoundIcon, Trash2Icon } from "lucide-react";

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
  remainingUsd: number;
  totalUsedUsd: number;
  totalRequests: number;
  lastUsedAt: string | null;
  periodStartedAt: string;
  enabled: boolean;
  keyHint: string;
};

type PoolSettings = { shareUsd: number; defaultUserShares: number; defaultTotalShares: number };

const usd = (v: number) => `$${v.toFixed(2)}`;

export default function GatewayUsersPage() {
  const [rows, setRows] = useState<GatewayUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<PoolSettings | null>(null);
  const [form, setForm] = useState({ shareUsd: "", defaultUserShares: "", defaultTotalShares: "" });
  const [savingSettings, setSavingSettings] = useState(false);
  const [email, setEmail] = useState("");
  const [shares, setShares] = useState("");
  const [assigning, setAssigning] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await apiRequest<GatewayUser[]>("gateway-users"));
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const st = await apiRequest<PoolSettings>("gateway-users/settings");
      setSettings(st);
      setForm({
        shareUsd: String(st.shareUsd),
        defaultUserShares: String(st.defaultUserShares),
        defaultTotalShares: String(st.defaultTotalShares),
      });
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
    void loadSettings();
  }, [load, loadSettings]);

  async function saveSettings() {
    setSavingSettings(true);
    try {
      const st = await apiRequest<PoolSettings>("gateway-users/settings", {
        method: "PUT",
        body: {
          shareUsd: Number(form.shareUsd),
          defaultUserShares: Number(form.defaultUserShares),
          defaultTotalShares: Number(form.defaultTotalShares),
        },
      });
      setSettings(st);
      toast.success("已保存");
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSavingSettings(false);
    }
  }

  async function assign() {
    if (!email.trim()) return;
    setAssigning(true);
    try {
      await apiRequest("gateway-users", {
        method: "POST",
        body: { email: email.trim(), shares: shares.trim() ? Number(shares) : undefined },
      });
      toast.success("已分配");
      setEmail("");
      setShares("");
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setAssigning(false);
    }
  }

  async function act(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      toast.success(ok);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  function editShares(u: GatewayUser) {
    const v = window.prompt(`${u.email} 的份数`, String(u.shares));
    const n = Number(v);
    if (v && Number.isInteger(n) && n !== u.shares) {
      void act(() => apiRequest(`gateway-users/${u.id}`, { method: "PATCH", body: { shares: n } }), "已修改");
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>额度设置</CardTitle>
          <CardDescription>
            每份额度、给用户分配的默认份数、新母号默认分几份。修改每份额度后,所有用户的额度上限立即按新值计算。周期固定 7 天,上游母号窗口重置时同步清零。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            每份额度(美元)
            <Input className="mt-1 w-40" value={form.shareUsd} onChange={(e) => setForm({ ...form, shareUsd: e.target.value })} />
          </label>
          <label className="text-sm">
            用户默认份数
            <Input className="mt-1 w-40" value={form.defaultUserShares} onChange={(e) => setForm({ ...form, defaultUserShares: e.target.value })} />
          </label>
          <label className="text-sm">
            母号默认份数
            <Input className="mt-1 w-40" value={form.defaultTotalShares} onChange={(e) => setForm({ ...form, defaultTotalShares: e.target.value })} />
          </label>
          <Button onClick={saveSettings} disabled={savingSettings || !settings}>
            {savingSettings ? <Spinner /> : null}保存
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>分配用户</CardTitle>
          <CardDescription>按注册邮箱分配。自动选剩余份数最多的可用母号,一个用户只占一个母号。份数留空用默认值。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Input className="w-72" placeholder="用户邮箱" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input className="w-32" placeholder={`份数(默认 ${settings?.defaultUserShares ?? 1})`} value={shares} onChange={(e) => setShares(e.target.value)} />
          <Button onClick={assign} disabled={assigning || !email.trim()}>
            {assigning ? <Spinner /> : <PlusIcon />}分配
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>网关用户({rows.length})</CardTitle>
          <CardDescription>已用按 Anthropic 官方价折算,超出额度的请求会在转发前被拒绝。</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Spinner />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>用户</TableHead>
                  <TableHead>母号</TableHead>
                  <TableHead>份数</TableHead>
                  <TableHead>本周期已用 / 总额度</TableHead>
                  <TableHead>剩余</TableHead>
                  <TableHead>累计</TableHead>
                  <TableHead>最近使用</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>启用</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((u) => {
                  const over = u.remainingUsd <= 0;
                  return (
                    <TableRow key={u.id}>
                      <TableCell className="font-medium">{u.email}</TableCell>
                      <TableCell className="text-xs">{u.motherAccountName}</TableCell>
                      <TableCell>
                        <button className="underline-offset-2 hover:underline" onClick={() => editShares(u)}>{u.shares}</button>
                      </TableCell>
                      <TableCell className="text-xs">{usd(u.usedUsd)} / {usd(u.limitUsd)}</TableCell>
                      <TableCell>
                        <Badge variant={over ? "destructive" : "secondary"}>{usd(u.remainingUsd)}</Badge>
                      </TableCell>
                      <TableCell className="text-xs">{usd(u.totalUsedUsd)}({u.totalRequests} 次)</TableCell>
                      <TableCell className="text-xs">{u.lastUsedAt ? new Date(u.lastUsedAt).toLocaleString() : "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{u.keyHint}</TableCell>
                      <TableCell>
                        <Switch
                          checked={u.enabled}
                          onCheckedChange={(v) =>
                            void act(() => apiRequest(`gateway-users/${u.id}`, { method: "PATCH", body: { enabled: v } }), "已更新")
                          }
                        />
                      </TableCell>
                      <TableCell className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="清零本周期用量"
                          onClick={() => window.confirm(`清零 ${u.email} 的本周期用量?`) && void act(() => apiRequest(`gateway-users/${u.id}/reset`, { method: "POST" }), "已清零")}
                        >
                          <RotateCcwIcon />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="换 Key"
                          onClick={() => window.confirm(`给 ${u.email} 换 Key?旧 Key 立即失效,用户需重新点一键托管。`) && void act(() => apiRequest(`gateway-users/${u.id}/rotate-key`, { method: "POST" }), "已换 Key")}
                        >
                          <KeyRoundIcon />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="删除"
                          onClick={() => window.confirm(`删除 ${u.email}?其用量明细一并删除。`) && void act(() => apiRequest(`gateway-users/${u.id}`, { method: "DELETE" }), "已删除")}
                        >
                          <Trash2Icon />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center text-muted-foreground">暂无用户</TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
