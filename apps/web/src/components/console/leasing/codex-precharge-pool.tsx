"use client";

import { useCallback, useEffect, useState } from "react";
import { CopyIcon, KeyRoundIcon, LogInIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { consoleApiPath } from "@/lib/console/client-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

type PrechargeStatus = "NEW" | "LOGGING_IN" | "SESSION_READY" | "FAILED";

type CodexPrechargeAccount = {
  id: number;
  email: string;
  proxyUrl: string;
  status: PrechargeStatus;
  hasSession: boolean;
  sessionUpdatedAt: string;
  lastError: string;
};

const statusMeta: Record<PrechargeStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  NEW: { label: "待登录", variant: "outline" },
  LOGGING_IN: { label: "登录中", variant: "secondary" },
  SESSION_READY: { label: "Session 已就绪", variant: "default" },
  FAILED: { label: "获取失败", variant: "destructive" },
};

async function post<T>(path: string, body: object): Promise<T> {
  const response = await fetch(consoleApiPath(`rosetta/${path}`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(payload.error || payload.message || "请求失败");
  return payload as T;
}

function displayTime(value: string) {
  if (!value) return "未获取";
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString("zh-CN", { hour12: false });
}

export function CodexPrechargePool({ onAccountsChanged }: { onAccountsChanged?: () => void | Promise<void> }) {
  const [accounts, setAccounts] = useState<CodexPrechargeAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [lines, setLines] = useState("");
  const [proxyUrl, setProxyUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [busyAction, setBusyAction] = useState<"session" | "onboard" | "copy" | "delete" | null>(null);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await fetch(consoleApiPath("rosetta/codex-precharge-accounts"), { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "读取预充值账号失败");
      setAccounts(Array.isArray(payload.accounts) ? payload.accounts : []);
    } catch (error) {
      toast.error("读取 Codex 预充值账号失败", { description: error instanceof Error ? error.message : undefined });
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function importAccounts() {
    if (!lines.trim()) {
      toast.error("请先输入预充值账号");
      return;
    }
    setImporting(true);
    try {
      const result = await post<{ successCount: number; total: number }>("codex-precharge-import", { lines, proxyUrl: proxyUrl.trim() });
      toast.success(`已导入 ${result.successCount}/${result.total} 个预充值账号`);
      setLines("");
      await refresh(true);
    } catch (error) {
      toast.error("导入失败", { description: error instanceof Error ? error.message : undefined });
    } finally {
      setImporting(false);
    }
  }

  async function startSessionLogin(account: CodexPrechargeAccount) {
    setBusyId(account.id);
    setBusyAction("session");
    try {
      const started = await post<{ taskId: string }>("codex-precharge-session-login", { accountId: account.id });
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const response = await fetch(consoleApiPath(`rosetta/codex-precharge-session-login-status?taskId=${encodeURIComponent(started.taskId)}`), { cache: "no-store" });
        const status = await response.json();
        if (!response.ok || !status.ok) throw new Error(status.error || "登录任务已丢失");
        if (status.status === "completed") {
          toast.success(`${account.email} 的 ChatGPT session 已就绪`);
          await refresh(true);
          return;
        }
        if (status.status === "failed") throw new Error(status.error || "登录或读取 session 失败");
      }
      throw new Error("登录任务超时");
    } catch (error) {
      toast.error("获取 ChatGPT session 失败", { description: error instanceof Error ? error.message : undefined });
      await refresh(true);
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  }

  async function startOnboard(account: CodexPrechargeAccount) {
    setBusyId(account.id);
    setBusyAction("onboard");
    try {
      const started = await post<{ jobId: string }>("codex-precharge-onboard", { accountId: account.id });
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const response = await fetch(consoleApiPath(`rosetta/codex-auto-login-status?jobId=${encodeURIComponent(started.jobId)}`), { cache: "no-store" });
        const status = await response.json();
        if (!response.ok || !status.ok) throw new Error(status.error || "上号任务已丢失");
        if (status.status === "completed") {
          toast.success(`${account.email} 已加入 Codex 账号池`);
          await onAccountsChanged?.();
          return;
        }
        if (status.status === "failed") throw new Error(status.error || "Codex 上号失败");
      }
      throw new Error("上号任务超时");
    } catch (error) {
      toast.error("Codex 一键上号失败", { description: error instanceof Error ? error.message : undefined });
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  }

  async function copySession(account: CodexPrechargeAccount) {
    setBusyId(account.id);
    setBusyAction("copy");
    try {
      const result = await post<{ session: string }>("codex-precharge-session", { accountId: account.id });
      await navigator.clipboard.writeText(result.session);
      toast.success("ChatGPT session 已复制，可粘贴到充值工具");
    } catch (error) {
      toast.error("复制 session 失败", { description: error instanceof Error ? error.message : undefined });
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  }

  async function removeAccount(account: CodexPrechargeAccount) {
    setBusyId(account.id);
    setBusyAction("delete");
    try {
      await post("codex-precharge-delete", { accountId: account.id });
      toast.success(`${account.email} 已删除`);
      await refresh(true);
    } catch (error) {
      toast.error("删除预充值账号失败", { description: error instanceof Error ? error.message : undefined });
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="text-base">Codex 预充值账号</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">“获取 Session”用于充值，“一键上号”会完成 OAuth 并加入 Codex 账号池。代理可留空，留空时使用服务器直连。</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          {loading ? <Spinner size={14} /> : <RefreshCwIcon className="size-3.5" />}
          刷新预充值账号
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 lg:grid-cols-[minmax(320px,1fr)_minmax(220px,320px)_auto] lg:items-end">
          <Field>
            <FieldLabel>预充值账号行</FieldLabel>
            <Textarea rows={3} placeholder="email----password" value={lines} onChange={(event) => setLines(event.target.value)} disabled={importing} />
          </Field>
          <Field>
            <FieldLabel>固定出口代理（可选）</FieldLabel>
            <Input placeholder="socks5://user:pass@host:port" value={proxyUrl} onChange={(event) => setProxyUrl(event.target.value)} disabled={importing} />
          </Field>
          <Button onClick={() => void importAccounts()} disabled={importing}>
            {importing ? <Spinner size={14} /> : <PlusIcon className="size-4" />}
            导入预充值账号
          </Button>
        </div>

        {!loading && !accounts.length ? (
          <div className="py-6 text-center text-sm text-muted-foreground">暂无 Codex 预充值账号。导入账号后，点击登录即可取得 session。</div>
        ) : null}

        {accounts.length ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>邮箱</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>出口代理</TableHead>
                  <TableHead>Session 更新时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((account) => {
                  const busy = busyId === account.id;
                  const status = statusMeta[account.status] || statusMeta.NEW;
                  return (
                    <TableRow key={account.id}>
                      <TableCell className="font-medium">#{account.id}</TableCell>
                      <TableCell>
                        <div className="font-medium">{account.email}</div>
                        {account.lastError ? <div className="max-w-[280px] truncate text-xs text-destructive" title={account.lastError}>{account.lastError}</div> : null}
                      </TableCell>
                      <TableCell><Badge variant={status.variant}>{status.label}</Badge></TableCell>
                      <TableCell className="max-w-[240px] truncate text-xs text-muted-foreground" title={account.proxyUrl}>{account.proxyUrl || "未配置"}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{account.hasSession ? displayTime(account.sessionUpdatedAt) : "未获取"}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button variant="outline" size="sm" className="gap-1" title="在服务器 Edge 登录并获取 ChatGPT session" disabled={busy} onClick={() => void startSessionLogin(account)}>
                            {busy && busyAction === "session" ? <Spinner size={14} /> : <KeyRoundIcon className="size-4 text-emerald-600" />}
                            获取 Session
                          </Button>
                          <Button size="sm" className="gap-1" title="完成 Codex OAuth 并加入账号池" disabled={busy} onClick={() => void startOnboard(account)}>
                            {busy && busyAction === "onboard" ? <Spinner size={14} /> : <LogInIcon className="size-4" />}
                            一键上号
                          </Button>
                          <Button variant="ghost" size="icon" title="复制 ChatGPT session" aria-label={`复制 ${account.email} 的 ChatGPT session`} disabled={busy || !account.hasSession} onClick={() => void copySession(account)}>
                            <CopyIcon className="size-4 text-emerald-600" />
                          </Button>
                          <Button variant="ghost" size="icon" title="删除预充值账号" aria-label={`删除 ${account.email}`} disabled={busy} onClick={() => void removeAccount(account)}>
                            <Trash2Icon className="size-4 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
