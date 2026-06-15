"use client";

import { useCallback, useEffect, useState } from "react";
import {
  DatabaseIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { toast } from "sonner";
import { consoleApiPath } from "@/lib/console/client-api";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type SessionStatus = "unverified" | "usable" | "unusable";

type SessionAccount = {
  id: number;
  email: string;
  enabled: boolean;
  proxyUrl: string;
  hasSessionKey: boolean;
  hasPassword: boolean;
  status: SessionStatus;
  useCount: number;
  orgId: string;
  lastVerifiedAt: string;
  lastUsedAt: string;
  lastError: string;
  createdAt: string;
  updatedAt: string;
};

const STATUS_META: Record<SessionStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  unverified: { label: "未验证", variant: "outline" },
  usable: { label: "能用", variant: "default" },
  unusable: { label: "不能用", variant: "destructive" },
};

function timeAgo(iso: string): string {
  if (!iso) return "从未";
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff) || diff < 0) return iso;
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 时前`;
  return `${Math.floor(diff / 86400_000)} 天前`;
}

function toSocks5(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return "";
  if (/^socks[45]?h?:\/\//i.test(s)) return s;
  if (/^https?:\/\//i.test(s)) return s.replace(/^https?:\/\//i, "socks5://");
  const p = s.split(":");
  if (p.length === 4) return `socks5://${p[2]}:${p[3]}@${p[0]}:${p[1]}`;
  return `socks5://${s}`;
}

export default function AnthropicWebAccountsPage() {
  const [accounts, setAccounts] = useState<SessionAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // import form
  const [importLines, setImportLines] = useState("");
  const [importProxy, setImportProxy] = useState("");
  const [importing, setImporting] = useState(false);

  // single add
  const [addEmail, setAddEmail] = useState("");
  const [addPassword, setAddPassword] = useState("");
  const [addSessionKey, setAddSessionKey] = useState("");
  const [addProxy, setAddProxy] = useState("");
  const [adding, setAdding] = useState(false);

  // inline proxy edit
  const [proxyEditId, setProxyEditId] = useState<number | null>(null);
  const [proxyEditVal, setProxyEditVal] = useState("");
  const [proxySaving, setProxySaving] = useState(false);

  // delete
  const [deleteTarget, setDeleteTarget] = useState<SessionAccount | null>(null);

  const fetchAccounts = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const res = await fetch(consoleApiPath("rosetta/claude-session-accounts"), { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
    } catch (error) {
      if (!silent) toast.error(`获取失败: ${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await fetchAccounts(true);
      setLoading(false);
    })();
  }, [fetchAccounts]);

  // ── batch import ───────────────────────────────────────────────────────
  async function handleBatchImport() {
    if (!importLines.trim()) {
      toast.error("请粘贴至少一行: email----password----sessionKey");
      return;
    }
    setImporting(true);
    try {
      const res = await fetch(consoleApiPath("rosetta/claude-session-batch-import"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines: importLines, proxyUrl: toSocks5(importProxy) }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "导入失败");
      const failed = (data.results || []).filter((r: any) => !r.ok);
      if (failed.length) {
        toast.warning(`导入 ${data.success}/${data.total} 成功, ${failed.length} 失败`);
      } else {
        toast.success(`全部 ${data.success} 条导入成功`);
      }
      setImportLines("");
      fetchAccounts();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导入失败");
    } finally {
      setImporting(false);
    }
  }

  // ── single add ─────────────────────────────────────────────────────────
  async function handleAdd() {
    if (!addEmail.trim() || !addSessionKey.trim()) {
      toast.error("email 和 sessionKey 必填");
      return;
    }
    setAdding(true);
    try {
      const res = await fetch(consoleApiPath("rosetta/claude-session-add-account"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: addEmail.trim(),
          password: addPassword.trim(),
          sessionKey: addSessionKey.trim(),
          proxyUrl: toSocks5(addProxy),
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "添加失败");
      toast.success(data.isUpdate ? "已更新" : "已添加");
      setAddEmail(""); setAddPassword(""); setAddSessionKey(""); setAddProxy("");
      fetchAccounts();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "添加失败");
    } finally {
      setAdding(false);
    }
  }

  // ── toggle ─────────────────────────────────────────────────────────────
  async function handleToggle(acc: SessionAccount) {
    try {
      const res = await fetch(consoleApiPath("rosetta/claude-session-toggle-account"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: acc.id }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "操作失败");
      fetchAccounts(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    }
  }

  // ── delete ─────────────────────────────────────────────────────────────
  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      const res = await fetch(consoleApiPath("rosetta/claude-session-delete-account"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: deleteTarget.id }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "删除失败");
      toast.success("已删除");
      setDeleteTarget(null);
      fetchAccounts();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    }
  }

  // ── proxy edit ─────────────────────────────────────────────────────────
  async function handleSaveProxy(acc: SessionAccount) {
    setProxySaving(true);
    try {
      const res = await fetch(consoleApiPath("rosetta/claude-session-set-proxy"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: acc.id, proxyUrl: proxyEditVal.trim() }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "保存失败");
      toast.success(proxyEditVal.trim() ? `#${acc.id} 代理已设置` : `#${acc.id} 代理已清除`);
      setProxyEditId(null);
      fetchAccounts(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setProxySaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <Spinner size={24} />
      </div>
    );
  }

  const enabledCount = accounts.filter((a) => a.enabled).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">白号登录号池</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理 claude.ai sessionKey 白号池。这些账号通过客户端 MITM Cookie 注入实现借号,
            与 OAuth 号池(Anthropic 账号池)互不干扰。每个号需配静态出口代理(一号一 IP)。
            状态由客户端接管时实测回报驱动:未验证 → 能用 / 不能用(不能用的不再下发)。
          </p>
        </div>
        <Button variant="outline" onClick={() => fetchAccounts()} disabled={refreshing}>
          {refreshing ? <Spinner size={14} /> : <RefreshCwIcon className="size-4" />}
          刷新
        </Button>
      </div>

      {/* ── 批量导入 ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UploadIcon className="size-4" /> 批量导入
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            每行一个账号,格式: <code className="rounded bg-muted px-1.5 py-0.5 text-xs">邮箱----密码----sessionKey</code>。
            代理在右侧单独填入(所有账号共用)。
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field className="flex-1">
              <FieldLabel>账号行(每行一个)</FieldLabel>
              <Textarea
                placeholder={"email1----password1----sk-ant-sid02-...\nemail2----password2----sk-ant-sid02-..."}
                value={importLines}
                onChange={(e) => setImportLines(e.target.value)}
                rows={4}
              />
            </Field>
            <Field className="sm:w-72">
              <FieldLabel>出口代理(共用)</FieldLabel>
              <Input
                placeholder="host:port:user:pass"
                value={importProxy}
                onChange={(e) => setImportProxy(e.target.value)}
              />
            </Field>
            <Button onClick={handleBatchImport} disabled={importing}>
              {importing ? <Spinner size={14} /> : <UploadIcon className="size-4" />}
              导入
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── 单条添加 ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">添加 / 更新白号</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <Field className="min-w-[200px] flex-1">
              <FieldLabel>Email</FieldLabel>
              <Input placeholder="account@example.com" value={addEmail} onChange={(e) => setAddEmail(e.target.value)} />
            </Field>
            <Field className="min-w-[140px]">
              <FieldLabel>密码</FieldLabel>
              <Input type="password" placeholder="登录密码" value={addPassword} onChange={(e) => setAddPassword(e.target.value)} />
            </Field>
            <Field className="min-w-[300px] flex-1">
              <FieldLabel>SessionKey</FieldLabel>
              <Input placeholder="sk-ant-sid02-..." value={addSessionKey} onChange={(e) => setAddSessionKey(e.target.value)} />
            </Field>
            <Field className="min-w-[220px]">
              <FieldLabel>出口代理</FieldLabel>
              <Input placeholder="host:port:user:pass" value={addProxy} onChange={(e) => setAddProxy(e.target.value)} />
            </Field>
            <Button onClick={handleAdd} disabled={adding}>
              {adding ? <Spinner data-icon className="size-4" /> : <PlusIcon data-icon className="size-4" />}
              添加
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── 账号列表 ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <DatabaseIcon className="size-4" /> 白号列表
          </CardTitle>
          <span className="text-sm text-muted-foreground">{enabledCount}/{accounts.length} 启用</span>
        </CardHeader>
        <CardContent>
          {!accounts.length ? (
            <div className="py-8 text-center text-sm text-muted-foreground">暂无白号</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>使用人数</TableHead>
                  <TableHead>SessionKey</TableHead>
                  <TableHead>密码</TableHead>
                  <TableHead>出口代理</TableHead>
                  <TableHead>启用</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">#{a.id}</TableCell>
                    <TableCell>
                      <div className="text-sm">{a.email}</div>
                      {a.orgId ? <div className="text-[10px] text-muted-foreground">org: {a.orgId.slice(0, 8)}…</div> : null}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <Badge
                          variant={STATUS_META[a.status]?.variant ?? "outline"}
                          title={a.status === "unusable" && a.lastError ? a.lastError : undefined}
                        >
                          {STATUS_META[a.status]?.label ?? "未验证"}
                        </Badge>
                        {a.lastVerifiedAt ? (
                          <span className="text-[10px] text-muted-foreground" title={new Date(a.lastVerifiedAt).toLocaleString()}>
                            回报 {timeAgo(a.lastVerifiedAt)}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">{a.useCount || 0}</TableCell>
                    <TableCell>
                      <Badge variant={a.hasSessionKey ? "default" : "destructive"}>
                        {a.hasSessionKey ? "有" : "无"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={a.hasPassword ? "secondary" : "outline"}>
                        {a.hasPassword ? "有" : "无"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {proxyEditId === a.id ? (
                        <div className="flex items-center gap-1">
                          <Input
                            className="h-7 w-[280px] text-xs"
                            autoFocus
                            placeholder="host:port:user:pass（强制 SOCKS5）"
                            value={proxyEditVal}
                            onChange={(e) => setProxyEditVal(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleSaveProxy(a);
                              if (e.key === "Escape") setProxyEditId(null);
                            }}
                          />
                          <Button size="sm" className="h-7 px-2" disabled={proxySaving} onClick={() => handleSaveProxy(a)}>
                            {proxySaving ? <Spinner size={12} /> : "保存"}
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setProxyEditId(null)}>
                            取消
                          </Button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="block max-w-[200px] truncate text-left text-xs underline-offset-2 hover:underline"
                          title={a.proxyUrl || "点此设置出口代理"}
                          onClick={() => { setProxyEditId(a.id); setProxyEditVal(a.proxyUrl || ""); }}
                        >
                          {a.proxyUrl ? (
                            <span className="text-muted-foreground">{a.proxyUrl}</span>
                          ) : (
                            <span className="text-destructive">未配置·点此设置</span>
                          )}
                        </button>
                      )}
                    </TableCell>
                    <TableCell>
                      <Switch checked={a.enabled} onCheckedChange={() => handleToggle(a)} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" onClick={() => setDeleteTarget(a)}>
                        <Trash2Icon className="size-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除白号</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除 #{deleteTarget?.id} {deleteTarget?.email}?此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
