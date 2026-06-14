"use client";

import { useCallback, useEffect, useState } from "react";
import { BadgeCheckIcon, BotIcon, DownloadIcon, ExternalLinkIcon, FileJsonIcon, GaugeIcon, GitMergeIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { QuotaProfilesCard } from "@/components/console/leasing/quota-profiles-card";
import { AccountStatusCell } from "@/components/console/leasing/account-status-cell";
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

type CodexAccount = {
  id: number;
  email: string;
  enabled: boolean;
  poolEnabled: boolean;
  alias: string;
  planType: string;
  hasToken: boolean;
  boundCardCount: number;
  usedShares: number;
  shareCapacity: number;
  codexHourlyPercent: number;
  codexWeeklyPercent: number;
  modelQuotaRefreshedAt: number;
  proxyUrl: string;
  quotaStatus?: string;
  quotaStatusReason?: string;
};

function pct(value: number) {
  return value < 0 ? "—" : `${Math.round(value)}%`;
}

// 自动上号各步骤的中文文案
const AUTO_STEP_LABELS: Record<string, string> = {
  starting: "准备中…",
  opening_authorize_url: "打开授权页…",
  choose_account: "切换账号…",
  email: "填写邮箱…",
  password: "填写密码…",
  totp: "提交动态验证码(TOTP)…",
  add_phone: "填写手机号…",
  sms_polling: "等待短信验证码…",
  sms_fill: "填写短信验证码…",
  consent: "确认授权…",
  got_code: "拿到授权码…",
  exchanging_token: "换取 token…",
  completed: "完成",
};
function autoStepLabel(step: string) {
  return AUTO_STEP_LABELS[step] || (step?.startsWith("waiting") ? "等待页面跳转…" : step || "");
}

export default function CodexAccountsPage() {
  const [accounts, setAccounts] = useState<CodexAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);

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

  // 自动上号(接码)表单 + 任务状态
  const [autoEmail, setAutoEmail] = useState("");
  const [autoPassword, setAutoPassword] = useState("");
  const [autoTotp, setAutoTotp] = useState("");
  const [autoPhone, setAutoPhone] = useState("");
  const [autoSmsUrl, setAutoSmsUrl] = useState("");
  const [autoProxy, setAutoProxy] = useState("");
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoStep, setAutoStep] = useState("");

  const [deleteTarget, setDeleteTarget] = useState<CodexAccount | null>(null);
  // 手动「刷新」(刷 token + 拉额度,一个动作)进行中的账号 id。
  const [busyId, setBusyId] = useState<number | null>(null);
  // 「刷新无额度账号」批量进行中。
  const [refreshingMissing, setRefreshingMissing] = useState(false);
  // 出口代理行内编辑:正在编辑的账号 id、输入值、保存中。
  const [proxyEditId, setProxyEditId] = useState<number | null>(null);
  const [proxyEditVal, setProxyEditVal] = useState("");
  const [proxySaving, setProxySaving] = useState(false);

  const fetchAccounts = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const res = await fetch(consoleApiPath("rosetta/codex-accounts"), { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list: CodexAccount[] = Array.isArray(data.accounts) ? data.accounts : [];

      // Sort: plan tier priority (pro > plus > others) → weekly quota desc → no data last
      const CODEX_PLAN_ORDER: Record<string, number> = { pro: 0, plus: 1 };
      list.sort((a, b) => {
        const pa = CODEX_PLAN_ORDER[a.planType || ""] ?? 2;
        const pb = CODEX_PLAN_ORDER[b.planType || ""] ?? 2;
        if (pa !== pb) return pa - pb;
        const wa = a.codexWeeklyPercent;
        const wb = b.codexWeeklyPercent;
        if (wa < 0 && wb < 0) return 0;
        if (wa < 0) return 1;
        if (wb < 0) return -1;
        return wb - wa;
      });
      setAccounts(list);
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
      const res = await fetch(consoleApiPath("rosetta/codex-add-account"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), refreshToken: refreshToken.trim(), planType: planType.trim(), alias: alias.trim() }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "添加失败");
      toast.success(data.isUpdate ? "已更新账号" : "已添加账号");
      setEmail(""); setRefreshToken(""); setPlanType(""); setAlias("");
      await refreshQuotaSilently(data.id);
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
      const res = await fetch(consoleApiPath("rosetta/codex-import-account"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: importText }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "导入失败");
      if (data.bulk) {
        const parts = [`新增 ${data.added}`, `更新 ${data.updated}`];
        if (data.failed) parts.push(`失败 ${data.failed}`);
        if (data.disabled) parts.push(`停用 ${data.disabled}`);
        toast.success(`已导入 ${data.added + data.updated} 个账号(${parts.join(" · ")})`);
      } else {
        toast.success(data.isUpdate ? "已更新账号" : "已导入账号");
      }
      setImportText("");
      await refreshQuotaSilently(data.id);
      fetchAccounts();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导入失败");
    } finally {
      setImporting(false);
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      const res = await fetch(consoleApiPath("rosetta/codex-accounts-export"), { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "导出失败");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 10);
      const link = document.createElement("a");
      link.href = url;
      link.download = `codex-accounts-${stamp}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success(`已导出 ${data.count} 个账号`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导出失败");
    } finally {
      setExporting(false);
    }
  }

  async function handleOAuthStart() {
    setOauthStarting(true);
    try {
      const res = await fetch(consoleApiPath("rosetta/codex-oauth-start"), {
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
      const res = await fetch(consoleApiPath("rosetta/codex-oauth-submit"), {
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
      await refreshQuotaSilently(data.accountId);
      fetchAccounts();
    } catch (error) {
      const msg = error instanceof Error ? error.message : "完成授权失败";
      setOauthStatusText(msg);
      toast.error(msg);
    } finally {
      setOauthSubmitting(false);
    }
  }

  // 加/导入/OAuth 入库后自动拉一次额度,免得新账号一直显示「—」。失败不影响入库,用户仍可手动「刷新」。
  async function refreshQuotaSilently(accountId?: number) {
    if (!accountId) return;
    try {
      await fetch(consoleApiPath("rosetta/codex-refresh-quota"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
    } catch {
      // best-effort：失败时账号已入库,用户可手动点「刷新」。
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
      await fetch(consoleApiPath("rosetta/codex-oauth-cancel"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId }),
      });
    } catch {
      // Best-effort cleanup only; the server-side session also expires.
    }
  }

  async function handleAutoLogin() {
    if (!autoEmail.trim() || !autoPassword.trim() || !autoPhone.trim() || !autoSmsUrl.trim() || !autoProxy.trim()) {
      toast.error("请填写邮箱、密码、接码手机号、接码网址、出口代理");
      return;
    }
    setAutoRunning(true);
    setAutoStep("准备中…");
    try {
      const res = await fetch(consoleApiPath("rosetta/codex-auto-login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: autoEmail.trim(),
          password: autoPassword.trim(),
          totpSecret: autoTotp.trim(),
          phoneNumber: autoPhone.trim(),
          smsUrl: autoSmsUrl.trim(),
          proxyUrl: autoProxy.trim(),
        }),
      });
      const data = await res.json();
      if (!data.ok || !data.jobId) throw new Error(data.error || "发起自动上号失败");
      const jobId: string = data.jobId;

      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const sres = await fetch(consoleApiPath(`rosetta/codex-auto-login-status?jobId=${encodeURIComponent(jobId)}`), { cache: "no-store" });
        const s = await sres.json();
        if (!s.ok) {
          if (s.status === "missing") throw new Error(s.error || "任务已丢失");
          continue;
        }
        setAutoStep(autoStepLabel(String(s.step || "")));
        if (s.status === "completed") {
          toast.success(`自动上号成功：${s.email}`);
          setAutoEmail("");
          setAutoPassword("");
          setAutoTotp("");
          setAutoPhone("");
          setAutoSmsUrl("");
          setAutoProxy("");
          fetchAccounts(true);
          return;
        }
        if (s.status === "failed") throw new Error(s.error || `失败于：${autoStepLabel(String(s.step || ""))}`);
      }
      throw new Error("自动上号超时");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "自动上号失败");
    } finally {
      setAutoRunning(false);
      setAutoStep("");
    }
  }

  async function handleToggle(account: CodexAccount) {
    try {
      const res = await fetch(consoleApiPath("rosetta/codex-toggle-account"), {
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

  async function handleTogglePool(account: CodexAccount) {
    try {
      const res = await fetch(consoleApiPath("rosetta/codex-toggle-account-pool"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "操作失败");
      toast.success(`${data.email} ${data.poolEnabled ? "已入池" : "已出池"}`);
      fetchAccounts(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "切换入池状态失败");
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      const res = await fetch(consoleApiPath("rosetta/codex-delete-account"), {
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
      const res = await fetch(consoleApiPath("rosetta/codex-refresh-quota"), {
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

  // 「恢复」= 后台手动清掉 lease 池运行时封禁(需验证/冷却/计数),立即放回候选池。
  async function handleReactivate(account: CodexAccount) {
    setBusyId(account.id);
    try {
      const res = await fetch(consoleApiPath("rosetta/codex-reactivate-account"), {
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

  // 批量刷新所有「额度缺失(列表显示 —)」的账号,逐个走 codex-refresh-quota。
  // 也可当诊断用:点完看 toast 的成功/失败数,就知道拉额度接口通不通。
  async function handleRefreshMissing() {
    const targets = accounts.filter((a) => a.codexHourlyPercent < 0 || a.codexWeeklyPercent < 0);
    if (targets.length === 0) {
      toast.info("没有缺额度的账号");
      return;
    }
    setRefreshingMissing(true);
    let ok = 0;
    let fail = 0;
    for (const acc of targets) {
      try {
        const res = await fetch(consoleApiPath("rosetta/codex-refresh-quota"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId: acc.id }),
        });
        const data = await res.json();
        if (data.ok && !data.quotaError) ok++;
        else fail++;
      } catch {
        fail++;
      }
    }
    setRefreshingMissing(false);
    if (fail) toast.error(`刷新完成:成功 ${ok},失败 ${fail}(共 ${targets.length})`);
    else toast.success(`已刷新 ${ok} 个无额度账号`);
    fetchAccounts(true);
  }

  function startEditProxy(account: CodexAccount) {
    setProxyEditId(account.id);
    setProxyEditVal(account.proxyUrl || "");
  }

  async function handleSaveProxy(account: CodexAccount) {
    setProxySaving(true);
    try {
      const res = await fetch(consoleApiPath("rosetta/account-set-proxy"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "codex", accountId: account.id, proxyUrl: proxyEditVal.trim() }),
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
          <Button variant="outline" onClick={handleRefreshMissing} disabled={refreshingMissing}>
            {refreshingMissing ? <Spinner size={14} /> : <GaugeIcon className="size-4" />}
            刷新无额度账号
          </Button>
          <Button variant="outline" onClick={handleExport} disabled={exporting || !accounts.length}>
            {exporting ? <Spinner size={14} /> : <DownloadIcon className="size-4" />}
            导出全部
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

      <QuotaProfilesCard product="codex" statusUrl="/api/app/lease/codex/status" />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">自动上号（接码）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            浏览器自动完成 OpenAI 登录（邮箱→密码→TOTP→手机短信接码→授权），手机号与出口代理由你填写。整个过程约 1–2 分钟。
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <Field className="min-w-[220px] flex-1">
              <FieldLabel>邮箱</FieldLabel>
              <Input placeholder="account@example.com" value={autoEmail} onChange={(e) => setAutoEmail(e.target.value)} disabled={autoRunning} />
            </Field>
            <Field className="min-w-[180px] flex-1">
              <FieldLabel>密码</FieldLabel>
              <Input placeholder="登录密码" value={autoPassword} onChange={(e) => setAutoPassword(e.target.value)} disabled={autoRunning} />
            </Field>
            <Field className="min-w-[180px] flex-1">
              <FieldLabel>TOTP 密钥（可选）</FieldLabel>
              <Input placeholder="base32 2FA secret" value={autoTotp} onChange={(e) => setAutoTotp(e.target.value)} disabled={autoRunning} />
            </Field>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field className="min-w-[160px]">
              <FieldLabel>接码手机号</FieldLabel>
              <Input placeholder="3527217858" value={autoPhone} onChange={(e) => setAutoPhone(e.target.value)} disabled={autoRunning} />
            </Field>
            <Field className="min-w-[260px] flex-1">
              <FieldLabel>接码网址</FieldLabel>
              <Input placeholder="https://app.yuntl.cc/apisms/..." value={autoSmsUrl} onChange={(e) => setAutoSmsUrl(e.target.value)} disabled={autoRunning} />
            </Field>
            <Field className="min-w-[240px] flex-1">
              <FieldLabel>出口代理</FieldLabel>
              <Input placeholder="socks5://user:pass@host:port 或 host:port:user:pass" value={autoProxy} onChange={(e) => setAutoProxy(e.target.value)} disabled={autoRunning} />
            </Field>
            <Button onClick={handleAutoLogin} disabled={autoRunning}>
              {autoRunning ? <Spinner data-icon className="size-4" /> : <BotIcon data-icon className="size-4" />}
              开始自动上号
            </Button>
          </div>
          {autoRunning && autoStep ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner size={14} /> 当前步骤：{autoStep}
            </p>
          ) : null}
        </CardContent>
      </Card>

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
            <FieldLabel>JSON 导入(支持单条 token JSON,或「导出全部」生成的数据)</FieldLabel>
            <Textarea
              rows={2}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder="粘贴单条 token JSON,或整段导出的 JSON"
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
                  <TableHead>状态</TableHead>
                  <TableHead>出口代理</TableHead>
                  <TableHead>份额用量</TableHead>
                  <TableHead>启用</TableHead>
                  <TableHead>入池</TableHead>
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
                      <AccountStatusCell account={a} />
                    </TableCell>
                    <TableCell>
                      {proxyEditId === a.id ? (
                        <div className="flex items-center gap-1">
                          <Input
                            className="h-7 w-[320px] text-xs"
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
                    <TableCell>
                      <button
                        type="button"
                        title={a.poolEnabled ? "已入池（点击出池）" : "已出池（点击入池）"}
                        className="inline-flex items-center justify-center rounded p-1 hover:bg-muted transition-colors"
                        onClick={() => handleTogglePool(a)}
                      >
                        <GitMergeIcon className={`size-4 ${a.poolEnabled ? "text-blue-500" : "text-muted-foreground"}`} />
                      </button>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" title="刷新 token + 获取额度" disabled={busyId === a.id}
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
