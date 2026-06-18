"use client";

import { useCallback, useEffect, useState } from "react";
import { BadgeCheckIcon, BotIcon, ExternalLinkIcon, GaugeIcon, GitMergeIcon, KeyRoundIcon, MailIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
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

type ClaudeAccount = {
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
  claudeHourlyPercent: number;
  claudeWeeklyPercent: number;
  claudeHourlyResetTime: string;
  claudeWeeklyResetTime: string;
  modelQuotaRefreshedAt: number;
  proxyUrl: string;
  adspowerProfileId: string;
  hasMailPassword?: boolean;
  quotaStatus?: string;
  quotaStatusReason?: string;
};

function pct(value: number) {
  return value < 0 ? "—" : `${Math.round(value)}%`;
}

// 距某个 ISO 重置时间还剩多久。空/已过 → "" / "已重置"。
function timeUntil(iso: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = t - Date.now();
  if (diff <= 0) return "已重置";
  const mins = Math.floor(diff / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h >= 24) return `${Math.floor(h / 24)}天${h % 24}时后`;
  if (h >= 1) return `${h}时${m}分后`;
  return `${m}分后`;
}

// 额度最后刷新于多久前。0 → "从未"。
function refreshAgo(ms: number): string {
  if (!ms) return "从未";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 时前`;
  return `${Math.floor(diff / 86400_000)} 天前`;
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
  const [adspowerProfileId, setAdspowerProfileId] = useState("k1bvbavq");
  const [importProxyUrl, setImportProxyUrl] = useState("");
  const [adding, setAdding] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<ClaudeAccount | null>(null);
  // 手动「刷新」(刷 token + 探测拉额度)进行中的账号 id。
  const [busyId, setBusyId] = useState<number | null>(null);
  // 出口代理行内编辑:正在编辑的账号 id、输入值、保存中。
  const [proxyEditId, setProxyEditId] = useState<number | null>(null);
  const [proxyEditVal, setProxyEditVal] = useState("");
  const [proxySaving, setProxySaving] = useState(false);
  // 邮箱密码行内编辑(token 失效自动重登用)。
  const [pwEditId, setPwEditId] = useState<number | null>(null);
  const [pwEditVal, setPwEditVal] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  // 指纹浏览器号行内编辑。
  const [adspowerEditId, setAdspowerEditId] = useState<number | null>(null);
  const [adspowerEditVal, setAdspowerEditVal] = useState("");
  const [adspowerSaving, setAdspowerSaving] = useState(false);

  const [oauthStarting, setOauthStarting] = useState(false);
  const [oauthLoginId, setOauthLoginId] = useState("");
  // 本次尝试的起始时刻(点「发起 OAuth」时记)。抓邮件时只接受此刻之后到达的登录邮件,
  // 避免捞到上一次登录留下的旧链接(magic link 约 15 分钟过期)。
  const [attemptStartedAt, setAttemptStartedAt] = useState(0);
  const [oauthCallbackInput, setOauthCallbackInput] = useState("");
  const [oauthStatusText, setOauthStatusText] = useState("");
  const [oauthSubmitting, setOauthSubmitting] = useState(false);

  // 一键导入：支持原 mail 格式与新 gmail 格式的多行或单行导入
  const [importLine, setImportLine] = useState("");
  const [importParsed, setImportParsed] = useState<{ email: string; password: string; recoveryEmail?: string; totpSecret?: string; sessionKey: string; proxyUrl: string; adspowerProfileId?: string } | null>(null);
  const [imapFetching, setImapFetching] = useState(false);
  const [imapResult, setImapResult] = useState<{ url?: string; error?: string; date?: string } | null>(null);
  const [followingLink, setFollowingLink] = useState(false);
  const [followResult, setFollowResult] = useState<{ ok: boolean; email?: string; error?: string; bodySnippet?: string } | null>(null);
  const [probeInfo, setProbeInfo] = useState<{ status: number; location?: string; bodySnippet?: string } | null>(null);
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoPhase, setAutoPhase] = useState("");
  const [autoResult, setAutoResult] = useState<{ ok: boolean; email?: string; error?: string; phase?: string } | null>(null);

  const fetchAccounts = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const res = await fetch(consoleApiPath("rosetta/anthropic-accounts"), { cache: "no-store" });
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
      const res = await fetch(consoleApiPath("rosetta/anthropic-add-account"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          refreshToken: refreshToken.trim(),
          planType: planType.trim(),
          alias: alias.trim(),
          proxyUrl: proxyUrl.trim(),
          adspowerProfileId: adspowerProfileId.trim(),
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "添加失败");
      toast.success(data.isUpdate ? "已更新账号" : "已添加账号");
      setEmail(""); setRefreshToken(""); setPlanType(""); setAlias(""); setProxyUrl(""); setAdspowerProfileId("");
      fetchAccounts();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "添加失败");
    } finally {
      setAdding(false);
    }
  }

  async function handleOAuthStart() {
    setOauthStarting(true);
    setProbeInfo(null);
    setFollowResult(null);
    setAttemptStartedAt(Date.now());
    try {
      const res = await fetch(consoleApiPath("rosetta/anthropic-oauth-start"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyUrl: importParsed?.proxyUrl || "" }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Anthropic OAuth start failed");
      setOauthLoginId(data.loginId);
     
      setOauthCallbackInput("");
      setOauthStatusText("");
      if (data.probeInfo) setProbeInfo(data.probeInfo);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Anthropic OAuth start failed");
      setOauthLoginId(""); setOauthStatusText("");
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
      const res = await fetch(consoleApiPath("rosetta/anthropic-oauth-submit"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId: oauthLoginId, input }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "完成授权失败");
      toast.success(data.isUpdate ? `OAuth 已更新 ${data.email}` : `OAuth 已添加 ${data.email}`);
      setOauthLoginId(""); setOauthCallbackInput(""); setOauthStatusText("");
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
    setOauthLoginId(""); setOauthStatusText(""); setOauthCallbackInput("");
    if (!loginId) return;
    try {
      await fetch(consoleApiPath("rosetta/anthropic-oauth-cancel"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId }),
      });
    } catch {
      // best-effort
    }
  }

  // 出口统一走 SOCKS5：把代理串归一成 socks5://user:pass@host:port，
  // 不管它原来写的是 http:// / 裸 host:port:user:pass / 还是已经是 socks。
  function toSocks5(raw: string): string {
    const s = (raw || "").trim();
    if (!s) return "";
    // 已经是 socks(4/5)就原样保留
    if (/^socks[45]?h?:\/\//i.test(s)) return s;
    // 带 http(s):// 前缀 → 换成 socks5://
    if (/^https?:\/\//i.test(s)) return s.replace(/^https?:\/\//i, "socks5://");
    // 裸 host:port:user:pass
    const p = s.split(":");
    if (p.length === 4) return `socks5://${p[2]}:${p[3]}@${p[0]}:${p[1]}`;
    // 裸 host:port（无鉴权）或 user:pass@host:port（无 scheme）
    return `socks5://${s}`;
  }

  function parseImportLine(line: string) {
    const text = line.trim();
    if (!text) return null;

    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;

    let email = "";
    let password = "";
    let recoveryEmail = "";
    let totpSecret = "";
    let sessionKey = "";

    // 1. Detect if any line is a sessionKey
    const sessionKeyLine = lines.find(l => l.startsWith("sk-ant-") || l.includes("sk-ant-"));
    if (sessionKeyLine) {
      sessionKey = sessionKeyLine.match(/sk-ant-sid02-[A-Za-z0-9\-_]+/)?.[0] || sessionKeyLine;
    }

    // 2. Parse the credentials line
    const credsLine = lines.find(l => l.includes("@") && !l.startsWith("sk-ant-")) || lines[0];
    if (credsLine) {
      const parts = credsLine.split(/----+|---+|--/);
      if (parts.length >= 2) {
        email = parts[0]?.trim() || "";
        password = parts[1]?.trim() || "";

        for (let i = 2; i < parts.length; i++) {
          const part = parts[i].trim();
          if (!part) continue;

          if (part.startsWith("sk-ant-")) {
            sessionKey = part;
          } else if (part.includes("@")) {
            recoveryEmail = part;
          } else if (part.length >= 16 && part.length <= 40 && /^[a-zA-Z2-7]+$/.test(part)) {
            totpSecret = part;
          } else {
            if (parts.length === 3 && i === 2 && !sessionKey) {
              sessionKey = part;
            }
          }
        }
      }
    }

    if (!sessionKey && lines.length > 1) {
      const lastLine = lines[lines.length - 1];
      if (lastLine.startsWith("sk-ant-") || lastLine.length > 50) {
        sessionKey = lastLine;
      }
    }

    return {
      email,
      password,
      recoveryEmail,
      totpSecret,
      sessionKey,
      proxyUrl: toSocks5(importProxyUrl),
      adspowerProfileId: "k1bvbavq", // 固定选择 k1bvbavq
    };
  }

  function handleImportParse() {
    const parsed = parseImportLine(importLine);
    if (!parsed || !parsed.email || !parsed.password) {
      toast.error("格式不对，必须至少包含：邮箱----密码");
      return;
    }
    setImportParsed(parsed);
    toast.success(`已解析: ${parsed.email}`);
  }

  async function handleFetchMagicLink() {
    if (!importParsed) {
      toast.error("请先粘贴并解析账号行");
      return;
    }
    setImapFetching(true);
    setImapResult(null);
    try {
      // 只接受「本次尝试开始」之后到达的邮件;并且无论如何不取超过 15 分钟的旧链接(必已过期)。
      // 同时轮询等待邮件到达(触发后投递有几秒延迟)。
      const since = Math.max(attemptStartedAt || 0, Date.now() - 15 * 60 * 1000);
      const res = await fetch(consoleApiPath("rosetta/anthropic-fetch-magic-link"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: importParsed.email,
          password: importParsed.password,
          sinceMs: since,
          waitMs: 30000,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setImapResult({ error: data.error || "获取失败" });
        toast.error(data.error || "获取失败");
      } else {
        setImapResult({ url: data.url, date: data.date });
        toast.success("已获取登录链接");
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "请求失败";
      setImapResult({ error: msg });
      toast.error(msg);
    } finally {
      setImapFetching(false);
    }
  }

  async function handleFollowMagicLink() {
    if (!imapResult?.url || !oauthLoginId) {
      toast.error("请先获取邮件链接并发起 OAuth");
      return;
    }
    setFollowingLink(true);
    setFollowResult(null);
    try {
      const res = await fetch(consoleApiPath("rosetta/anthropic-follow-magic-link"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId: oauthLoginId, url: imapResult.url }),
      });
      const data = await res.json();
      if (data.ok && data.status === "completed") {
        setFollowResult({ ok: true, email: data.email });
        toast.success(data.isUpdate ? `OAuth 已更新 ${data.email}` : `OAuth 已添加 ${data.email}`);
        setOauthLoginId(""); setOauthCallbackInput(""); setOauthStatusText("");
        setImapResult(null);
        fetchAccounts();
      } else {
        setFollowResult({ ok: false, error: data.error, bodySnippet: data.bodySnippet });
        toast.error(data.error || "跟随链接失败");
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "请求失败";
      setFollowResult({ ok: false, error: msg });
      toast.error(msg);
    } finally {
      setFollowingLink(false);
    }
  }

  async function handleAutoOAuth() {
    if (!importParsed) {
      toast.error("请先粘贴并解析账号行");
      return;
    }
    if (!importParsed.proxyUrl && !importParsed.adspowerProfileId) {
      toast.error("全自动需要 SOCKS5 代理（或使用指纹浏览器号）");
      return;
    }
    if (!importParsed.password) {
      toast.error("全自动需要邮箱密码(用于抓取 magic link)");
      return;
    }
    setAutoRunning(true);
    setAutoResult(null);
    setAutoPhase("starting");
    try {
      // 1. Fire the async job — returns taskId immediately
      const res = await fetch(consoleApiPath("rosetta/anthropic-auto-oauth"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: importParsed.email,
          password: importParsed.password,
          proxyUrl: importParsed.proxyUrl,
          adspowerProfileId: importParsed.adspowerProfileId,
          sessionKey: importParsed.sessionKey,
          recoveryEmail: importParsed.recoveryEmail,
          totpSecret: importParsed.totpSecret,
        }),
      });
      const start = await res.json().catch(() => ({ ok: false, error: "响应解析失败" }));
      if (!start.ok || !start.taskId) {
        setAutoResult({ ok: false, error: start.error || "启动失败" });
        toast.error(start.error || "启动失败");
        setAutoRunning(false);
        return;
      }

      // 2. Poll for status every 2s
      const taskId = start.taskId;
      const poll = async (): Promise<void> => {
        for (;;) {
          await new Promise((r) => setTimeout(r, 2000));
          try {
            const sr = await fetch(consoleApiPath(`rosetta/anthropic-auto-oauth-status?taskId=${taskId}`));
            const st = await sr.json().catch(() => null);
            if (!st) continue;
            setAutoPhase(st.phase || "");
            if (st.status === "done") {
              setAutoResult({ ok: true, email: st.email });
              toast.success(st.isUpdate ? `全自动已更新 ${st.email}` : `全自动已添加 ${st.email}`);
              fetchAccounts();
              return;
            }
            if (st.status === "error") {
              setAutoResult({ ok: false, error: st.error, phase: st.phase });
              toast.error(st.error || "全自动失败");
              return;
            }
            // still running — loop
          } catch {
            // network blip — keep polling
          }
        }
      };
      await poll();
    } catch (error) {
      const msg = error instanceof Error ? error.message : "请求失败";
      setAutoResult({ ok: false, error: msg });
      toast.error(msg);
    } finally {
      setAutoRunning(false);
      setAutoPhase("");
    }
  }

  async function handleToggle(account: ClaudeAccount) {
    try {
      const res = await fetch(consoleApiPath("rosetta/anthropic-toggle-account"), {
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

  async function handleTogglePool(account: ClaudeAccount) {
    try {
      const res = await fetch(consoleApiPath("rosetta/anthropic-toggle-account-pool"), {
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
      const res = await fetch(consoleApiPath("rosetta/anthropic-delete-account"), {
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
      const res = await fetch(consoleApiPath("rosetta/anthropic-refresh-quota"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id }),
      });
      const data = await res.json();
      if (!data.ok) {
        if (data.autoReauth && data.reauthTaskId) {
          toast.info(`#${account.id} token 已失效，正在自动重新登录授权…`);
          // Poll the re-auth task
          const tid = data.reauthTaskId;
          const pollReauth = async () => {
            for (;;) {
              await new Promise((r) => setTimeout(r, 3000));
              try {
                const sr = await fetch(consoleApiPath(`rosetta/anthropic-auto-oauth-status?taskId=${tid}`));
                const st = await sr.json().catch(() => null);
                if (!st) continue;
                if (st.status === "done") {
                  toast.success(`#${account.id} 自动重新授权成功: ${st.email}`);
                  fetchAccounts();
                  return;
                }
                if (st.status === "error") {
                  toast.error(`#${account.id} 自动重新授权失败: ${st.error}`);
                  return;
                }
              } catch { /* keep polling */ }
            }
          };
          pollReauth();
          return;
        }
        throw new Error(data.error || "刷新失败");
      }
      if (data.raw) {
        // 打印 /api/oauth/usage 原始返回,便于排查。
        console.log(`[claude-refresh] #${account.id} usage:`, data.raw);
      }
      // 刷 token 成功且该号此前被判「已失效」→ 后端已顺手清掉死号判决并放回候选池。
      const recovered = data.reactivated ? " · 已自动恢复(放回候选池)" : "";
      if (data.quotaError) {
        toast.success(`#${account.id} token 已刷新(${data.quotaError})${recovered}`);
      } else {
        toast.success(`#${account.id} 已刷新 · 5h ${pct(Number(data.hourlyPercent))} · 周 ${pct(Number(data.weeklyPercent))}${recovered}`);
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
      const res = await fetch(consoleApiPath("rosetta/anthropic-reactivate-account"), {
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
      const res = await fetch(consoleApiPath("rosetta/anthropic-set-proxy"), {
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

  function startEditPw(account: ClaudeAccount) {
    setPwEditId(account.id);
    setPwEditVal("");
  }

  async function handleSavePw(account: ClaudeAccount) {
    setPwSaving(true);
    try {
      const res = await fetch(consoleApiPath("rosetta/anthropic-set-mail-password"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, mailPassword: pwEditVal }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "保存失败");
      toast.success(pwEditVal ? `#${account.id} 邮箱密码已设置(token 失效将自动重登)` : `#${account.id} 邮箱密码已清除`);
      setPwEditId(null);
      fetchAccounts(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setPwSaving(false);
    }
  }

  function startEditAdspower(account: ClaudeAccount) {
    setAdspowerEditId(account.id);
    setAdspowerEditVal(account.adspowerProfileId || "");
  }

  async function handleSaveAdspower(account: ClaudeAccount) {
    setAdspowerSaving(true);
    try {
      const res = await fetch(consoleApiPath("rosetta/anthropic-set-adspower-profile"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id, adspowerProfileId: adspowerEditVal.trim() }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "保存失败");
      toast.success(adspowerEditVal.trim() ? `#${account.id} AdsPower 浏览器号已设置` : `#${account.id} AdsPower 浏览器号已清除`);
      setAdspowerEditId(null);
      fetchAccounts(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setAdspowerSaving(false);
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MailIcon className="size-4" /> 一键导入 &amp; 获取登录链接
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            粘贴账号行（支持 3 段或 5 段格式，中间 2 段为无效内容，代理在右侧单独框填入），自动解析后使用 AdsPower (k1bvbavq) 与出口代理抓取 Anthropic 登录并换绑 token。
          </p>

          {/* Step 1: 粘贴解析 */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field className="flex-1">
              <FieldLabel>账号行 (支持多行/多格式粘贴)</FieldLabel>
              <Textarea
                placeholder="支持格式如：&#10;邮箱---密码---恢复邮箱---TOTP密钥&#10;sessionKey"
                value={importLine}
                onChange={(e) => setImportLine(e.target.value)}
                onBlur={() => { if (importLine) handleImportParse(); }}
                rows={3}
              />
            </Field>
            <Field className="sm:w-80">
              <FieldLabel>代理 URL (单独填入)</FieldLabel>
              <Input
                placeholder="http://user:pass@ip:port 或 qhBGD...:443"
                value={importProxyUrl}
                onChange={(e) => setImportProxyUrl(e.target.value)}
                onBlur={() => { if (importLine) handleImportParse(); }}
              />
            </Field>
            <Button variant="outline" onClick={handleImportParse}>解析</Button>
          </div>

          {importParsed ? (
            <div className="space-y-3 rounded-md border p-3 text-sm">
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground">
                <span>邮箱: <span className="text-foreground">{importParsed.email}</span></span>
                <span>密码: <span className="text-foreground">***</span></span>
                {importParsed.recoveryEmail ? (
                  <span>恢复邮箱: <span className="text-foreground">{importParsed.recoveryEmail}</span></span>
                ) : null}
                {importParsed.totpSecret ? (
                  <span>TOTP密钥: <span className="text-foreground">{importParsed.totpSecret}</span></span>
                ) : null}
                <span>代理: <span className="text-foreground">{importParsed.proxyUrl || "无"}</span></span>
                {importParsed.adspowerProfileId ? (
                  <span>浏览器号: <span className="text-foreground">{importParsed.adspowerProfileId}</span></span>
                ) : null}
              </div>

              {/* Full auto: Playwright headless browser through SOCKS5 */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">全自动（无头浏览器）</span>
                <Button size="sm" variant="default" onClick={handleAutoOAuth} disabled={autoRunning}>
                  {autoRunning ? <Spinner size={14} /> : null}
                  {autoRunning ? "自动化中…" : "一键全自动"}
                </Button>
              </div>
              {autoRunning ? (
                <p className="text-xs text-muted-foreground">
                  Chromium 无头浏览器通过 SOCKS5 代理执行中… 当前阶段: <span className="font-medium text-foreground">{autoPhase || "starting"}</span>
                </p>
              ) : null}
              {autoResult?.ok ? (
                <p className="text-xs text-green-600">全自动成功: {autoResult.email}</p>
              ) : null}
              {autoResult && !autoResult.ok ? (
                <div className="space-y-1">
                  <p className="text-xs text-destructive">全自动失败{autoResult.phase ? `（阶段: ${autoResult.phase}）` : ""}: {autoResult.error}</p>
                </div>
              ) : null}

              <hr className="my-2 border-dashed" />
              <p className="text-xs text-muted-foreground">以下为分步手动操作（全自动失败时回退）：</p>

              {/* Step 2: 发起 OAuth（通过代理请求 authorize URL） */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">① 发起 OAuth（代理）</span>
                <Button size="sm" variant="outline" onClick={handleOAuthStart} disabled={oauthStarting || Boolean(oauthLoginId)}>
                  {oauthStarting ? <Spinner size={14} /> : <ExternalLinkIcon className="size-3.5" />}
                  发起授权
                </Button>
                {oauthLoginId ? <span className="text-xs text-green-600">已就绪</span> : null}
              </div>
              {probeInfo ? (
                <div className="rounded-md border bg-muted/50 p-2 text-xs text-muted-foreground">
                  <p>代理探测: HTTP {probeInfo.status}{probeInfo.location ? ` → ${probeInfo.location}` : ""}</p>
                  {probeInfo.bodySnippet ? <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap">{probeInfo.bodySnippet.slice(0, 500)}</pre> : null}
                </div>
              ) : null}

              {/* Step 3: 网页登录邮箱抓取登录链接 */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">② 获取邮件链接</span>
                <Button size="sm" onClick={handleFetchMagicLink} disabled={imapFetching}>
                  {imapFetching ? <Spinner size={14} /> : <MailIcon className="size-3.5" />}
                  网页抓取
                </Button>
              </div>
              {imapResult?.url ? (
                <div className="rounded-md border bg-muted/50 p-2">
                  <p className="mb-1 text-xs font-medium text-green-600">
                    登录链接{imapResult.date ? `（邮件时间 ${new Date(imapResult.date).toLocaleString()}）` : ""}：
                  </p>
                  <p className="break-all text-xs text-muted-foreground">{imapResult.url}</p>
                </div>
              ) : null}
              {imapResult?.error ? <p className="text-xs text-destructive">{imapResult.error}</p> : null}

              {/* Step 4: 通过代理跟随 magic link，自动拿 code 换 token */}
              {oauthLoginId && imapResult?.url ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">③ 代理完成授权</span>
                    <Button size="sm" onClick={handleFollowMagicLink} disabled={followingLink}>
                      {followingLink ? <Spinner size={14} /> : null}
                      跟随链接换 Token
                    </Button>
                  </div>
                  {followResult?.ok ? (
                    <p className="text-xs text-green-600">授权成功: {followResult.email}</p>
                  ) : null}
                  {followResult?.error ? (
                    <div className="space-y-1">
                      <p className="text-xs text-destructive">{followResult.error}</p>
                      {followResult.bodySnippet ? <pre className="max-h-24 overflow-auto rounded bg-muted p-1 text-xs">{followResult.bodySnippet}</pre> : null}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* 回退: 手动粘贴 code（代理跟随失败时用） */}
              {oauthLoginId ? (
                <details className="text-sm">
                  <summary className="cursor-pointer text-xs text-muted-foreground">手动粘贴 code（回退）</summary>
                  <div className="mt-2 space-y-2">
                    <Textarea
                      rows={2}
                      placeholder="粘贴授权码 code#state 或回调 URL"
                      value={oauthCallbackInput}
                      onChange={(e) => setOauthCallbackInput(e.target.value)}
                    />
                    {oauthStatusText ? <p className="text-xs text-destructive">{oauthStatusText}</p> : null}
                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleOAuthSubmit} disabled={oauthSubmitting}>
                        {oauthSubmitting ? <Spinner size={14} /> : null}
                        完成授权
                      </Button>
                      <Button size="sm" variant="outline" onClick={handleOAuthCancel} disabled={oauthSubmitting}>取消</Button>
                    </div>
                  </div>
                </details>
              ) : null}
            </div>
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
            <Field className="min-w-[140px]">
              <FieldLabel>浏览器号(可选)</FieldLabel>
              <Input placeholder="AdsPower ID" value={adspowerProfileId} onChange={(e) => setAdspowerProfileId(e.target.value)} />
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
                  <TableHead>刷新</TableHead>
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
                    <TableCell className="text-sm">
                      <div>{pct(a.claudeHourlyPercent)}</div>
                      {a.claudeHourlyResetTime ? (
                        <div className="text-[10px] text-muted-foreground">{timeUntil(a.claudeHourlyResetTime)}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">
                      <div>{pct(a.claudeWeeklyPercent)}</div>
                      {a.claudeWeeklyResetTime ? (
                        <div className="text-[10px] text-muted-foreground">{timeUntil(a.claudeWeeklyResetTime)}</div>
                      ) : null}
                    </TableCell>
                    <TableCell
                      className="text-xs text-muted-foreground whitespace-nowrap"
                      title={a.modelQuotaRefreshedAt ? new Date(a.modelQuotaRefreshedAt).toLocaleString() : "从未刷新"}
                    >
                      {refreshAgo(a.modelQuotaRefreshedAt)}
                    </TableCell>
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
                            placeholder="host:port:user:pass（强制走 SOCKS5）"
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
                      {pwEditId === a.id ? (
                        <div className="flex items-center justify-end gap-1">
                          <Input
                            type="password"
                            className="h-7 w-[180px] text-xs"
                            autoFocus
                            placeholder="邮箱密码（留空=清除）"
                            value={pwEditVal}
                            onChange={(e) => setPwEditVal(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleSavePw(a);
                              if (e.key === "Escape") setPwEditId(null);
                            }}
                          />
                          <Button size="sm" className="h-7 px-2" disabled={pwSaving} onClick={() => handleSavePw(a)}>
                            {pwSaving ? <Spinner size={12} /> : "保存"}
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setPwEditId(null)}>取消</Button>
                        </div>
                      ) : (
                        <>
                          <Button variant="ghost" size="icon"
                            title={a.hasMailPassword ? "已存邮箱密码（token 失效自动重登）· 点击修改" : "设置邮箱密码（token 失效自动重登）"}
                            onClick={() => startEditPw(a)}>
                            <KeyRoundIcon className={`size-4 ${a.hasMailPassword ? "text-green-600" : "text-muted-foreground"}`} />
                          </Button>
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
                        </>
                      )}
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
