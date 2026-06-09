"use client";

import { useCallback, useEffect, useState } from "react";
import { BadgeCheckIcon, BotIcon, ExternalLinkIcon, GaugeIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { QuotaProfilesCard } from "@/components/quota-profiles-card";
import { AccountStatusCell } from "@/components/account-status-cell";

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

type ClaudeAccount = {
  id: number;
  email: string;
  enabled: boolean;
  alias: string;
  planType: string;
  hasToken: boolean;
  boundCardCount: number;
  usedShares: number;
  shareCapacity: number;
  claudeHourlyPercent: number;
  claudeWeeklyPercent: number;
  modelQuotaRefreshedAt: number;
  proxyUrl: string;
  quotaStatus?: string;
  quotaStatusReason?: string;
};

function pct(value: number) {
  return value < 0 ? "—" : `${Math.round(value)}%`;
}

export default function ClaudeAccountsPage() {
  const [accounts, setAccounts] = useState<ClaudeAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [email, setEmail] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [planType, setPlanType] = useState("");
  const [alias, setAlias] = useState("");
  const [proxyUrl, setProxyUrl] = useState("");
  const [adding, setAdding] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<ClaudeAccount | null>(null);
  // 手动「刷新」(刷 token + 探测拉额度)进行中的账号 id。
  const [busyId, setBusyId] = useState<number | null>(null);
  // 出口代理行内编辑:正在编辑的账号 id、输入值、保存中。
  const [proxyEditId, setProxyEditId] = useState<number | null>(null);
  const [proxyEditVal, setProxyEditVal] = useState("");
  const [proxySaving, setProxySaving] = useState(false);

  const [oauthStarting, setOauthStarting] = useState(false);
  const [oauthLoginId, setOauthLoginId] = useState("");
  const [oauthAuthUrl, setOauthAuthUrl] = useState("");
  const [oauthCallbackInput, setOauthCallbackInput] = useState("");
  const [oauthStatusText, setOauthStatusText] = useState("");
  const [oauthSubmitting, setOauthSubmitting] = useState(false);

  const fetchAccounts = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const res = await fetch("/api/rosetta/anthropic-accounts", { cache: "no-store" });
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
      const res = await fetch("/api/rosetta/anthropic-add-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), refreshToken: refreshToken.trim(), planType: planType.trim(), alias: alias.trim(), proxyUrl: proxyUrl.trim() }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "添加失败");
      toast.success(data.isUpdate ? "已更新账号" : "已添加账号");
      setEmail(""); setRefreshToken(""); setPlanType(""); setAlias(""); setProxyUrl("");
      fetchAccounts();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "添加失败");
    } finally {
      setAdding(false);
    }
  }

  async function handleOAuthStart() {
    setOauthStarting(true);
    try {
      const res = await fetch("/api/rosetta/anthropic-oauth-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Anthropic OAuth start failed");
      setOauthLoginId(data.loginId);
      setOauthAuthUrl(data.authUrl || "");
      setOauthCallbackInput("");
      setOauthStatusText("");
      window.open(data.authUrl, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Anthropic OAuth start failed");
      setOauthLoginId(""); setOauthAuthUrl(""); setOauthStatusText("");
    } finally {
      setOauthStarting(false);
    }
  }

  async function handleOAuthSubmit() {
    const input = oauthCallbackInput.trim();
    if (!input) {
      toast.error("请粘贴授权后页面显示的 code(或回调 URL)");
      return;
    }
    setOauthSubmitting(true);
    setOauthStatusText("");
    try {
      const res = await fetch("/api/rosetta/anthropic-oauth-submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId: oauthLoginId, input }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "完成授权失败");
      toast.success(data.isUpdate ? `OAuth 已更新 ${data.email}` : `OAuth 已添加 ${data.email}`);
      setOauthLoginId(""); setOauthAuthUrl(""); setOauthCallbackInput(""); setOauthStatusText("");
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
    setOauthLoginId(""); setOauthStatusText(""); setOauthAuthUrl(""); setOauthCallbackInput("");
    if (!loginId) return;
    try {
      await fetch("/api/rosetta/anthropic-oauth-cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId }),
      });
    } catch {
      // best-effort
    }
  }

  async function handleToggle(account: ClaudeAccount) {
    try {
      const res = await fetch("/api/rosetta/anthropic-toggle-account", {
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
      const res = await fetch("/api/rosetta/anthropic-delete-account", {
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

  // 「刷新」= 强制刷 token + 探测拉额度(后端一个接口)。Claude 无独立用量接口,
  // 后端会用该账号 token 向 Anthropic 发一次最小探测请求,从限流响应头解析 5h/周。
  async function handleRefresh(account: ClaudeAccount) {
    setBusyId(account.id);
    try {
      const res = await fetch("/api/rosetta/anthropic-refresh-quota", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "刷新失败");
      if (data.raw) {
        // 打印 /api/oauth/usage 原始返回,便于排查。
        console.log(`[claude-refresh] #${account.id} usage:`, data.raw);
      }
      if (data.quotaError) {
        toast.success(`#${account.id} token 已刷新(${data.quotaError})`);
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

  // 「恢复」= 后台手动清掉 lease 池运行时封禁(需验证/冷却/计数),立即放回候选池。
  async function handleReactivate(account: ClaudeAccount) {
    setBusyId(account.id);
    try {
      const res = await fetch("/api/rosetta/anthropic-reactivate-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "恢复失败");
      toast.success(`#${account.id} 已恢复（清除封禁，放回候选池）`);
      fetchAccounts(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "恢复失败");
    } finally {
      setBusyId(null);
    }
  }

  function startEditProxy(account: ClaudeAccount) {
    setProxyEditId(account.id);
    setProxyEditVal(account.proxyUrl || "");
  }

  async function handleSaveProxy(account: ClaudeAccount) {
    setProxySaving(true);
    try {
      const res = await fetch("/api/rosetta/anthropic-set-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, proxyUrl: proxyEditVal.trim() }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "保存失败");
      toast.success(proxyEditVal.trim() ? `#${account.id} 出口代理已设置` : `#${account.id} 出口代理已清除`);
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
          <h1 className="text-2xl font-semibold tracking-normal">Anthropic 账号池</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理独立的 anthropic-accounts.json(Anthropic 订阅 OAuth 账号);卡密与用量复用 access-keys.json。
            5h/周额度在客户端发起请求并上报后显示。
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
            <p className="font-medium">完成 Anthropic OAuth 登录</p>
            <p className="text-muted-foreground">
              1. 在新打开的页面用 Anthropic 订阅号(Pro/Max)登录并授权(没弹出的话,
              {oauthAuthUrl ? (
                <a href={oauthAuthUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">点此打开授权页</a>
              ) : "请重新发起"}
              )。
            </p>
            <p className="text-muted-foreground">
              2. 授权后页面会显示一段授权码(形如 <code className="rounded bg-muted px-1">code#state</code>),把它整段复制粘贴到下面,点「完成授权」。也可直接粘贴回调 URL。
            </p>
          </div>
          <Textarea
            rows={3}
            placeholder="粘贴页面显示的授权码 code#state,或完整回调 URL"
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

      <QuotaProfilesCard product="anthropic" statusUrl="/api/remote-anthropic/status" />

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
              <Input placeholder="Anthropic refresh_token" value={refreshToken} onChange={(e) => setRefreshToken(e.target.value)} />
            </Field>
            <Field className="min-w-[120px]">
              <FieldLabel>套餐</FieldLabel>
              <Input placeholder="pro / max" value={planType} onChange={(e) => setPlanType(e.target.value)} />
            </Field>
            <Field className="min-w-[120px]">
              <FieldLabel>别名</FieldLabel>
              <Input placeholder="可选" value={alias} onChange={(e) => setAlias(e.target.value)} />
            </Field>
            <Field className="min-w-[240px] flex-1">
              <FieldLabel>出口代理(可选,每号粘性)</FieldLabel>
              <Input placeholder="socks5://user:pass@host:1080" value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)} />
            </Field>
            <Button onClick={handleAdd} disabled={adding}>
              {adding ? <Spinner data-icon className="size-4" /> : <PlusIcon data-icon className="size-4" />}
              添加
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <BotIcon className="size-4" /> 账号列表
          </CardTitle>
          <span className="text-sm text-muted-foreground">{enabledCount}/{accounts.length} 启用</span>
        </CardHeader>
        <CardContent>
          {!accounts.length ? (
            <div className="py-8 text-center text-sm text-muted-foreground">暂无 Anthropic 账号</div>
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
                  <TableHead>状态</TableHead>
                  <TableHead>出口代理</TableHead>
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
                    <TableCell className="text-sm">{pct(a.claudeHourlyPercent)}</TableCell>
                    <TableCell className="text-sm">{pct(a.claudeWeeklyPercent)}</TableCell>
                    <TableCell>
                      <Badge variant={a.hasToken ? "default" : "destructive"}>{a.hasToken ? "有" : "无"}</Badge>
                    </TableCell>
                    <TableCell>
                      <AccountStatusCell account={a} />
                    </TableCell>
                    <TableCell className="max-w-[240px]">
                      {proxyEditId === a.id ? (
                        <div className="flex items-center gap-1">
                          <Input
                            className="h-7 text-xs"
                            autoFocus
                            placeholder="host:port:user:pass 或 http(s)://"
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
                          className="block max-w-[220px] truncate text-left text-xs underline-offset-2 hover:underline"
                          title={a.proxyUrl || "点此设置出口代理"}
                          onClick={() => startEditProxy(a)}
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
                      <Badge variant={Number(a.usedShares || 0) >= Number(a.shareCapacity || 4) ? "destructive" : "secondary"}>
                        {Number(a.usedShares || 0)}/{Number(a.shareCapacity || 4)} 份
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Switch checked={a.enabled} onCheckedChange={() => handleToggle(a)} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" title="刷新 token + 探测额度" disabled={busyId === a.id}
                        onClick={() => handleRefresh(a)}>
                        {busyId === a.id ? <Spinner size={14} /> : <GaugeIcon className="size-4" />}
                      </Button>
                      <Button variant="ghost" size="icon" title="恢复（清除冷却/需验证封禁，放回候选池）" disabled={busyId === a.id}
                        onClick={() => handleReactivate(a)}>
                        <BadgeCheckIcon className="size-4 text-amber-500" />
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
            <AlertDialogTitle>删除 Anthropic 账号</AlertDialogTitle>
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
