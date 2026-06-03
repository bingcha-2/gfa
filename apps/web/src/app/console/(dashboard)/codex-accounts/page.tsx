"use client";

import { useCallback, useEffect, useState } from "react";
import { BotIcon, ExternalLinkIcon, FileJsonIcon, GaugeIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
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
  boundCardCount: number;
  usedShares: number;
  shareCapacity: number;
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
  const [oauthStarting, setOauthStarting] = useState(false);
  const [oauthLoginId, setOauthLoginId] = useState("");
  const [oauthStatusText, setOauthStatusText] = useState("");
  const [oauthAuthUrl, setOauthAuthUrl] = useState("");
  const [oauthCallbackInput, setOauthCallbackInput] = useState("");
  const [oauthSubmitting, setOauthSubmitting] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<CodexAccount | null>(null);
  // 手动「刷新」(刷 token + 拉额度,一个动作)进行中的账号 id。
  const [busyId, setBusyId] = useState<number | null>(null);

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

  async function handleOAuthStart() {
    setOauthStarting(true);
    try {
      const res = await fetch("/api/rosetta/codex-oauth-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Codex OAuth start failed");
      setOauthLoginId(data.loginId);
      setOauthAuthUrl(data.authUrl || "");
      setOauthCallbackInput("");
      setOauthStatusText("");
      // 尝试自动打开授权页;若被浏览器拦截,下方面板里也有可点击的授权链接兜底。
      window.open(data.authUrl, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Codex OAuth start failed");
      setOauthLoginId("");
      setOauthAuthUrl("");
      setOauthStatusText("");
    } finally {
      setOauthStarting(false);
    }
  }

  async function handleOAuthSubmit() {
    const input = oauthCallbackInput.trim();
    if (!input) {
      toast.error("请粘贴授权后跳转的回调 URL 或其中的 code");
      return;
    }
    setOauthSubmitting(true);
    setOauthStatusText("");
    try {
      const res = await fetch("/api/rosetta/codex-oauth-submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId: oauthLoginId, input }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "完成授权失败");
      toast.success(data.isUpdate ? `OAuth updated ${data.email}` : `OAuth added ${data.email}`);
      setOauthLoginId("");
      setOauthAuthUrl("");
      setOauthCallbackInput("");
      setOauthStatusText("");
      fetchAccounts();
    } catch (error) {
      const msg = error instanceof Error ? error.message : "完成授权失败";
      setOauthStatusText(msg);
      toast.error(msg);
    } finally {
      setOauthSubmitting(false);
    }
  }

  async function handleOAuthCancel() {
    const loginId = oauthLoginId;
    setOauthLoginId("");
    setOauthStatusText("");
    setOauthAuthUrl("");
    setOauthCallbackInput("");
    if (!loginId) return;
    try {
      await fetch("/api/rosetta/codex-oauth-cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId }),
      });
    } catch {
      // Best-effort cleanup only; the server-side session also expires.
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

  // 「刷新」= 强制刷 token + 拉上游额度(后端一个接口)。
  async function handleRefresh(account: CodexAccount) {
    setBusyId(account.id);
    try {
      const res = await fetch("/api/rosetta/codex-refresh-quota", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "刷新失败");
      if (data.quotaError) {
        toast.success(`#${account.id} token 已刷新(额度获取失败:${data.quotaError})`);
      } else {
        toast.success(`#${account.id} 已刷新 · 5h ${Math.round(data.hourlyPercent)}% · 周 ${Math.round(data.weeklyPercent)}%`);
      }
      fetchAccounts(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "刷新失败");
    } finally {
      setBusyId(null);
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
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={handleOAuthStart} disabled={oauthStarting || Boolean(oauthLoginId)}>
            {oauthStarting ? <Spinner size={14} /> : <ExternalLinkIcon className="size-4" />}
            OAuth 登录
          </Button>
          <Button variant="outline" onClick={() => fetchAccounts()} disabled={refreshing}>
          {refreshing ? <Spinner size={14} /> : <RefreshCwIcon className="size-4" />}
          刷新
          </Button>
        </div>
      </div>

      {oauthLoginId ? (
        <div className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-sm">
          <div className="space-y-1">
            <p className="font-medium">完成 Codex OAuth 登录</p>
            <p className="text-muted-foreground">
              1. 在新打开的页面完成授权(没弹出的话，
              {oauthAuthUrl ? (
                <a href={oauthAuthUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">点此打开授权页</a>
              ) : "请重新发起"}
              )。
            </p>
            <p className="text-muted-foreground">
              2. 授权后浏览器会跳到 <code className="rounded bg-muted px-1">localhost:1455/auth/callback?...</code>（页面打不开是正常的），把<strong>整个地址栏 URL</strong> 复制粘贴到下面，点「完成授权」。
            </p>
          </div>
          <Textarea
            rows={3}
            placeholder="http://localhost:1455/auth/callback?code=...&state=..."
            value={oauthCallbackInput}
            onChange={(e) => setOauthCallbackInput(e.target.value)}
          />
          {oauthStatusText ? <p className="text-destructive">{oauthStatusText}</p> : null}
          <div className="flex gap-2">
            <Button size="sm" onClick={handleOAuthSubmit} disabled={oauthSubmitting}>
              {oauthSubmitting ? <Spinner size={14} /> : null}
              完成授权
            </Button>
            <Button size="sm" variant="outline" onClick={handleOAuthCancel} disabled={oauthSubmitting}>取消</Button>
          </div>
        </div>
      ) : null}

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
                  <TableHead>份额用量</TableHead>
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
                      <Badge variant={Number(a.usedShares || 0) >= Number(a.shareCapacity || 4) ? "destructive" : "secondary"}>
                        {Number(a.usedShares || 0)}/{Number(a.shareCapacity || 4)} 份
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Switch checked={a.enabled} onCheckedChange={() => handleToggle(a)} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" title="刷新 token + 获取额度" disabled={busyId === a.id}
                        onClick={() => handleRefresh(a)}>
                        {busyId === a.id ? <Spinner size={14} /> : <GaugeIcon className="size-4" />}
                      </Button>
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
