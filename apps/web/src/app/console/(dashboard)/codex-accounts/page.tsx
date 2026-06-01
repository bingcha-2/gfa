"use client";

import { useCallback, useEffect, useState } from "react";
import { BotIcon, FileJsonIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

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

type CodexAccount = {
  id: number;
  email: string;
  enabled: boolean;
  alias: string;
  planType: string;
  hasToken: boolean;
  codexHourlyPercent: number;
  codexWeeklyPercent: number;
  modelQuotaRefreshedAt: number;
};

function pct(value: number) {
  return value < 0 ? "—" : `${Math.round(value)}%`;
}

export default function CodexAccountsPage() {
  const [accounts, setAccounts] = useState<CodexAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [email, setEmail] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [planType, setPlanType] = useState("");
  const [alias, setAlias] = useState("");
  const [adding, setAdding] = useState(false);
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<CodexAccount | null>(null);

  const fetchAccounts = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const res = await fetch("/api/rosetta/codex-accounts", { cache: "no-store" });
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

  async function handleAdd() {
    if (!email.trim() || !refreshToken.trim()) {
      toast.error("email 和 refreshToken 必填");
      return;
    }
    setAdding(true);
    try {
      const res = await fetch("/api/rosetta/codex-add-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), refreshToken: refreshToken.trim(), planType: planType.trim(), alias: alias.trim() }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "添加失败");
      toast.success(data.isUpdate ? "已更新账号" : "已添加账号");
      setEmail(""); setRefreshToken(""); setPlanType(""); setAlias("");
      fetchAccounts();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "添加失败");
    } finally {
      setAdding(false);
    }
  }

  async function handleImport() {
    if (!importText.trim()) {
      toast.error("请粘贴 JSON 文本");
      return;
    }
    setImporting(true);
    try {
      const res = await fetch("/api/rosetta/codex-import-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: importText }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "导入失败");
      toast.success(data.isUpdate ? "已更新账号" : "已导入账号");
      setImportText("");
      fetchAccounts();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导入失败");
    } finally {
      setImporting(false);
    }
  }

  async function handleToggle(account: CodexAccount) {
    try {
      const res = await fetch("/api/rosetta/codex-toggle-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "操作失败");
      fetchAccounts(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      const res = await fetch("/api/rosetta/codex-delete-account", {
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
          <h1 className="text-2xl font-semibold tracking-normal">Codex 账号池</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理独立的 codex-accounts.json(OpenAI OAuth 账号);卡密与用量复用 access-keys.json。
          </p>
        </div>
        <Button variant="outline" onClick={() => fetchAccounts()} disabled={refreshing}>
          {refreshing ? <Spinner size={14} /> : <RefreshCwIcon className="size-4" />}
          刷新
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">添加 / 更新账号</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <Field className="min-w-[200px] flex-1">
              <FieldLabel>Email</FieldLabel>
              <Input placeholder="account@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field className="min-w-[240px] flex-1">
              <FieldLabel>Refresh Token</FieldLabel>
              <Input placeholder="OpenAI refresh_token" value={refreshToken} onChange={(e) => setRefreshToken(e.target.value)} />
            </Field>
            <Field className="min-w-[120px]">
              <FieldLabel>套餐</FieldLabel>
              <Input placeholder="plus / pro" value={planType} onChange={(e) => setPlanType(e.target.value)} />
            </Field>
            <Field className="min-w-[120px]">
              <FieldLabel>别名</FieldLabel>
              <Input placeholder="可选" value={alias} onChange={(e) => setAlias(e.target.value)} />
            </Field>
            <Button onClick={handleAdd} disabled={adding}>
              {adding ? <Spinner data-icon className="size-4" /> : <PlusIcon data-icon className="size-4" />}
              添加
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="rounded-lg border bg-card p-3">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-end">
          <Field className="min-w-0 flex-1">
            <FieldLabel>JSON 导入</FieldLabel>
            <Textarea
              rows={2}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder="粘贴整段文本"
              className="h-14 max-h-20 resize-none overflow-auto font-mono text-xs [field-sizing:fixed]"
            />
          </Field>
          <Button className="lg:mb-0.5" onClick={handleImport} disabled={importing || !importText.trim()}>
            {importing ? <Spinner data-icon className="size-4" /> : <FileJsonIcon data-icon className="size-4" />}
            导入
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <BotIcon className="size-4" /> 账号列表
          </CardTitle>
          <span className="text-sm text-muted-foreground">{enabledCount}/{accounts.length} 启用</span>
        </CardHeader>
        <CardContent>
          {!accounts.length ? (
            <div className="py-8 text-center text-sm text-muted-foreground">暂无 Codex 账号</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>套餐</TableHead>
                  <TableHead>5h 剩余</TableHead>
                  <TableHead>周剩余</TableHead>
                  <TableHead>Token</TableHead>
                  <TableHead>启用</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">#{a.id}</TableCell>
                    <TableCell>
                      <div>{a.email}</div>
                      {a.alias ? <div className="text-xs text-muted-foreground">{a.alias}</div> : null}
                    </TableCell>
                    <TableCell className="text-sm">{a.planType || "—"}</TableCell>
                    <TableCell className="text-sm">{pct(a.codexHourlyPercent)}</TableCell>
                    <TableCell className="text-sm">{pct(a.codexWeeklyPercent)}</TableCell>
                    <TableCell>
                      <Badge variant={a.hasToken ? "default" : "destructive"}>{a.hasToken ? "有" : "无"}</Badge>
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
            <AlertDialogTitle>删除 Codex 账号</AlertDialogTitle>
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
