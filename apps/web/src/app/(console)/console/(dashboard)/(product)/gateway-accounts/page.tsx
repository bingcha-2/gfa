"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiRequest, getErrorMessage } from "@/lib/console/client-api";

type WindowStat = {
  used?: number | null;
  remaining?: number | null;
  resetAt?: number | null;
  freshness?: string | null;
  readingAt?: number | null;
};

type KeyUsage = {
  name?: string;
  share?: { windows?: { "5h"?: WindowStat; "7d"?: WindowStat } } | null;
  usage?: { requests?: number; inputTokens?: number; outputTokens?: number } | null;
};

type MotherAccount = {
  id: string;
  accountName: string;
  accountType: string | null;
  upstreamId: string | null;
  enabled: boolean;
  status: "pending" | "ready" | "key_lost" | "error";
  keyHint: string | null;
  hasKey: boolean;
  lastError: string | null;
  usage: KeyUsage[] | null;
  usageSyncedAt: string | null;
  baseUrl: string;
  totalShares: number;
  allocatedShares: number;
  userCount: number;
  models: string[];
};

type UpstreamSettings = { baseUrl: string; hasOpKey: boolean; opKeyHint: string | null };

const STATUS_LABEL: Record<MotherAccount["status"], { text: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { text: "待开 Key", variant: "secondary" },
  ready: { text: "正常", variant: "default" },
  key_lost: { text: "Key 不可用", variant: "destructive" },
  error: { text: "异常", variant: "destructive" },
};

// 上游比例字段:null 表示未知,不能当 0。
function pct(v: number | null | undefined) {
  return typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "未知";
}

function windowCell(w?: WindowStat) {
  if (!w) return "暂未获取";
  return <div className="flex flex-col gap-1">
    <span>{typeof w.remaining === "number" ? `剩余 ${pct(w.remaining)}` : "暂未获取"}</span>
    {typeof w.resetAt === "number" && <span className="text-muted-foreground">重置 {new Date(w.resetAt).toLocaleString()}</span>}
    <span className="text-muted-foreground">{typeof w.readingAt === "number" ? `更新于 ${new Date(w.readingAt).toLocaleString()}` : "更新时间未知"}</span>
  </div>;
}

export default function GatewayAccountsPage() {
  const [rows, setRows] = useState<MotherAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [upstreamId, setUpstreamId] = useState("");
  const [settings, setSettings] = useState<UpstreamSettings | null>(null);
  const [opKeyInput, setOpKeyInput] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await apiRequest<MotherAccount[]>("gateway-accounts"));
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const st = await apiRequest<UpstreamSettings>("gateway-accounts/settings");
      setSettings(st);
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
      const st = await apiRequest<UpstreamSettings>("gateway-accounts/settings", {
        method: "PUT",
        body: { opKey: opKeyInput.trim() || undefined },
      });
      setSettings(st);
      setOpKeyInput("");
      toast.success("上游连接已保存");
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSavingSettings(false);
    }
  }

  async function add() {
    if (!name.trim()) return;
    setAdding(true);
    try {
      const created = await apiRequest<MotherAccount>("gateway-accounts", {
        method: "POST",
        body: { accountName: name.trim(), upstreamId: upstreamId.trim() || undefined },
      });
      toast[created.status === "ready" ? "success" : "warning"](
        created.status === "ready" ? "已添加并开出 Key" : `已添加,但开 Key 未成功:${created.lastError ?? created.status}`,
      );
      setName("");
      setUpstreamId("");
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setAdding(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    try {
      setRows(await apiRequest<MotherAccount[]>("gateway-accounts/refresh", { method: "POST" }));
      toast.success("已刷新");
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setRefreshing(false);
    }
  }

  async function toggle(row: MotherAccount, enabled: boolean) {
    try {
      await apiRequest(`gateway-accounts/${row.id}`, { method: "PATCH", body: { enabled } });
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  async function patchRow(row: MotherAccount, body: Record<string, unknown>) {
    try {
      await apiRequest(`gateway-accounts/${row.id}`, { method: "PATCH", body });
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  function editBaseUrl(row: MotherAccount) {
    const v = window.prompt("该母号的调用地址(https://…)", row.baseUrl);
    if (v && v.trim() !== row.baseUrl) void patchRow(row, { baseUrl: v.trim() });
  }

  function editShares(row: MotherAccount) {
    const v = window.prompt(`参考承载人数（已分配 ${row.userCount} 人，允许超配）`, String(row.totalShares));
    const n = Number(v);
    if (v && Number.isInteger(n) && n !== row.totalShares) void patchRow(row, { totalShares: n });
  }

  async function remove(row: MotherAccount) {
    if (!window.confirm(`删除母号 ${row.accountName}?\n只删除本地记录和密文,上游已开出的 Key 需另行在上游处理。`)) return;
    try {
      await apiRequest(`gateway-accounts/${row.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>上游运营 Key</CardTitle>
          <CardDescription>
            运营 Key 加密保存,保存后不会再显示。{settings?.hasOpKey ? `当前已配置(${settings.opKeyHint})。` : "当前未配置,添加母号前必须先配置。"}留空表示不修改。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Input className="w-80" type="password" autoComplete="off" placeholder="运营 Key(留空不修改)" value={opKeyInput} onChange={(e) => setOpKeyInput(e.target.value)} />
          <Button onClick={saveSettings} disabled={savingSettings}>
            {savingSettings ? <Spinner /> : null}保存
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>添加母号</CardTitle>
          <CardDescription>
            账号名必须与上游 /teamclaude/status 中的名称完全一致。添加后系统自动向上游开 1 个私有 Key(占账号 100%),Key 加密保存,任何页面都不会显示。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Input className="w-72" placeholder="上游账号名(如邮箱)" value={name} onChange={(e) => setName(e.target.value)} />
          <Input className="w-72" placeholder="上游 accountId(可选,防误操作)" value={upstreamId} onChange={(e) => setUpstreamId(e.target.value)} />
          <Button onClick={add} disabled={adding || !name.trim()}>
            {adding ? <Spinner /> : <PlusIcon />}添加
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>第三方母号({rows.length})</CardTitle>
            <CardDescription>每 5 分钟自动同步用量,也可手动刷新(10 秒内重复点击不会重复请求上游)。</CardDescription>
          </div>
          <Button variant="outline" onClick={refresh} disabled={refreshing}>
            {refreshing ? <Spinner /> : <RefreshCwIcon />}手动刷新
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Spinner />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>账号</TableHead>
                  <TableHead>账号类型</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>调用地址</TableHead>
                  <TableHead>已分配 / 参考人数</TableHead>
                  <TableHead>模型</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>5 小时窗口</TableHead>
                  <TableHead>7 天窗口</TableHead>
                  <TableHead>启用</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const u = r.usage?.[0];
                  const st = STATUS_LABEL[r.status] ?? STATUS_LABEL.error;
                  return (
                    <TableRow key={r.id}>
                      <TableCell>
                        <div className="font-medium">{r.accountName}</div>
                        {r.lastError ? <div className="text-xs text-destructive">{r.lastError}</div> : null}
                      </TableCell>
                      <TableCell>{r.accountType ?? "未知"}</TableCell>
                      <TableCell><Badge variant={st.variant}>{st.text}</Badge></TableCell>
                      <TableCell className="text-xs">
                        <button className="underline-offset-2 hover:underline" onClick={() => editBaseUrl(r)}>{r.baseUrl}</button>
                      </TableCell>
                      <TableCell className="text-xs">
                        <button className="underline-offset-2 hover:underline" onClick={() => editShares(r)}>
                          {r.userCount} / {r.totalShares} 人
                        </button>
                        {r.userCount > r.totalShares && <Badge variant="secondary" className="ml-2">超配 {r.userCount - r.totalShares} 人</Badge>}
                      </TableCell>
                      <TableCell className="text-xs" title={r.models.join("\n")}>{r.models.length} 个</TableCell>
                      <TableCell className="font-mono text-xs">{r.hasKey ? r.keyHint : "—"}</TableCell>
                      <TableCell className="text-xs">{windowCell(u?.share?.windows?.["5h"])}</TableCell>
                      <TableCell className="text-xs">{windowCell(u?.share?.windows?.["7d"])}</TableCell>
                      <TableCell><Switch checked={r.enabled} onCheckedChange={(v) => toggle(r, v)} /></TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" onClick={() => remove(r)} aria-label="删除">
                          <Trash2Icon />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center text-muted-foreground">暂无母号</TableCell>
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
