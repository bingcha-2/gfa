"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { apiRequest, getErrorMessage } from "@/lib/console/client-api";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "./status-badge";
import { ConfirmButton } from "./confirm-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/* ================================================================
   Types
   ================================================================ */

interface AccountSummary {
  id: string;
  name: string;
  loginEmail: string;
  status: string;
  loginPassword?: string | null;
  subscriptionExpiresAt?: string | null;
  subscriptionStatus?: string | null;
}

interface GroupSlotInfo {
  id: string;
  accountId: string;
  groupName: string;
  availableSlots: number;
  status: string;
}

interface FamilyGroupInfo {
  id: string;
  groupName: string;
  accountId: string;
  availableSlots: number;
  status: string;
  account?: {
    id: string;
    name: string;
    loginEmail: string;
  };
}

interface PhoneEntry {
  id: string;
  phoneNumber: string;
  countryCode: string;
  smsUrl: string;
  status: string;
  usedCount: number;
  failureCount: number;
  lastUsedAt: string | null;
  lastCode: string | null;
  disabledReason: string | null;
  createdAt: string;
}

interface TaskLog {
  level: string;
  message: string;
  createdAt: string;
}

interface TaskStatus {
  taskId: string;
  type: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  result?: Record<string, unknown>;
  logs: TaskLog[];
}

interface DailyRecord {
  id: string;
  email: string;
  taskStatus: string;
  memberStatus: string | null;
  joinedAt: string | null;
  createdAt: string;
  familyGroupId: string | null;
  familyGroup: {
    id: string;
    groupName: string;
    account: {
      id: string;
      loginEmail: string;
      name: string;
    };
  } | null;
}

interface AgentAccount {
  id: string;
  loginEmail: string;
  loginPassword: string;
  totpSecret: string | null;
  recoveryEmail: string | null;
  status: "REGISTERED" | "PHONE_VERIFIED" | "IN_GROUP" | "UPLOADED" | "REMOVED";
  refreshToken: string | null;
  tokenObtainedAt: string | null;
  familyGroupId: string | null;
  uploadedAt: string | null;
  removedAt: string | null;
  lastTaskId: string | null;
  notes: string | null;
  pool: "pending" | "no_ban" | "ban_risk";
  banned: boolean;
  uploadedToPool: string | null;
  motherAccountId: string | null;
  motherGroupId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AgentAccountStats {
  total: number;
  registered: number;
  phoneVerified: number;
  inGroup: number;
  uploaded: number;
  removed: number;
  pools: {
    pending: number;
    noBan: number;
    noBanActive: number;
    noBanBanned: number;
    banRisk: number;
    banRiskActive: number;
    banRiskBanned: number;
  };
}

type TabId = "accounts-mgmt" | "phone-pool" | "account-tokens";

interface AccountTokenEntry {
  id: string;
  name: string;
  loginEmail: string;
  status: string;
  refreshToken: string | null;
  tokenObtainedAt: string | null;
  tokenStatus: string | null;
  subscriptionPlan: string | null;
  subscriptionStatus: string | null;
  subscriptionExpiresAt: string | null;
}

interface AccountTokenPage {
  items: AccountTokenEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  summary: { unused: number; used: number; noToken: number };
}

/* ================================================================
   Sub-components
   ================================================================ */

function LogStream({ logs, isRunning }: { logs: TaskLog[]; isRunning: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div className="agent-log-stream">
      <div className="agent-log-header">
        <div className="agent-log-dot red" />
        <div className="agent-log-dot yellow" />
        <div className="agent-log-dot green" />
        <span style={{ marginLeft: 8, fontSize: 11, opacity: 0.6 }}>
          {isRunning ? "实时日志" : logs.length > 0 ? "执行完成" : "等待执行…"}
        </span>
      </div>
      <div className="agent-log-body">
        {logs.length === 0 ? (
          <div className="agent-log-empty">等待任务开始…</div>
        ) : (
          logs.map((log, i) => (
            <div key={i} className={`agent-log-line ${log.level === "ERROR" || log.level === "WARN" ? "error" : ""}`}>
              <span className="agent-log-level">{log.level === "ERROR" ? "❌" : log.level === "WARN" ? "⚠️" : "›"}</span>
              <span className="agent-log-time">{new Date(log.createdAt).toLocaleTimeString()}</span>
              <span className="agent-log-msg">{log.message}</span>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

/* ================================================================
   Helpers
   ================================================================ */

/** Format an ISO date string to a human-readable date label. */
function formatDateLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (isSameDay(d, today)) return "今日";
  if (isSameDay(d, yesterday)) return "昨日";
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** Group records by date key (YYYY-MM-DD). */
function groupByDate(records: DailyRecord[]): Map<string, DailyRecord[]> {
  const map = new Map<string, DailyRecord[]>();
  for (const r of records) {
    const key = new Date(r.createdAt).toISOString().slice(0, 10);
    const list = map.get(key) ?? [];
    list.push(r);
    map.set(key, list);
  }
  return map;
}

/** Format subscription expiry date concisely. */
function formatExpiry(iso: string | null | undefined): string {
  if (!iso) return "无";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "无";
  const now = new Date();
  const diffDays = Math.floor((d.getTime() - now.getTime()) / (86400 * 1000));
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (diffDays < 0) return `已过期 (${dateStr})`;
  if (diffDays <= 30) return `${diffDays}天 (${dateStr})`;
  return dateStr;
}

/* ================================================================
   Replace Account Picker — used in replace modal
   ================================================================ */

function ReplaceAccountPicker({ onSelect, onCancel, showToast }: {
  onSelect: (newId: string) => void;
  onCancel: () => void;
  showToast: (type: "success" | "error" | "info", msg: string) => void;
}) {
  const [pendingAccounts, setPendingAccounts] = useState<AgentAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const data = await apiRequest<AgentAccount[]>("agent-accounts", { search: { pool: "pending" } });
        setPendingAccounts(data.filter(a => a.refreshToken && a.familyGroupId));
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, []);

  const filtered = filter
    ? pendingAccounts.filter(a => a.loginEmail.toLowerCase().includes(filter.toLowerCase()))
    : pendingAccounts;

  if (loading) return <div style={{ textAlign: "center", padding: 32 }}><Spinner size={20} color="var(--accent)" /></div>;

  return (
    <div>
      <Input
        className="field-input"
        placeholder="搜索未上号子号…"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        style={{ marginBottom: 12, fontSize: 13 }}
      />
      {filtered.length === 0 ? (
        <p className="muted" style={{ textAlign: "center", padding: 24 }}>没有符合条件的未上号子号（需有Token + 已进组）</p>
      ) : (
        <div style={{ maxHeight: 300, overflow: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
          {filtered.map(acc => (
            <div key={acc.id}
              style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", border: "1px solid var(--border, #e5e5e5)", borderRadius: 8, cursor: "pointer" }}
              onClick={() => onSelect(acc.id)}>
              <code style={{ fontSize: 12, flex: 1 }}>{acc.loginEmail}</code>
              <StatusBadge value={acc.status === "IN_GROUP" ? "已进组" : acc.status} tone="emerald" />
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 16, textAlign: "right" }}>
        <Button variant="outline" type="button" onClick={onCancel}>取消</Button>
      </div>
    </div>
  );
}

/* ================================================================
   Main Component
   ================================================================ */

interface AgentServicePanelProps {
  showToast: (type: "success" | "error" | "info", msg: string) => void;
}

export function AgentServicePanel({ showToast }: AgentServicePanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>("accounts-mgmt");

  // ── Agent Accounts (子号管理) ──
  const [agentAccounts, setAgentAccounts] = useState<AgentAccount[]>([]);
  const [agentStats, setAgentStats] = useState<AgentAccountStats | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentImportText, setAgentImportText] = useState("");
  const [agentImporting, setAgentImporting] = useState(false);
  // agentFilterStatus removed — UI now uses agentSubTab for pool-based nav
  const [agentSelected, setAgentSelected] = useState<Set<string>>(new Set());
  const [agentBatchAction, setAgentBatchAction] = useState(false);
  const [agentDeletingIds, setAgentDeletingIds] = useState<Set<string>>(new Set());
  const [agentSubTab, setAgentSubTab] = useState<"pending" | "no_ban" | "ban_risk">("pending");
  const [agentPage, setAgentPage] = useState(1);
  const [agentPageSize] = useState(20);
  const [agentTotal, setAgentTotal] = useState(0);
  const [agentTotalPages, setAgentTotalPages] = useState(0);
  const [motherOptions, setMotherOptions] = useState<Array<{
    groupId: string; groupName: string; accountId: string; accountName: string; accountEmail: string;
    subscriptionExpiresAt: string | null; subscriptionStatus: string | null;
    memberCount: number; availableSlots: number; poolChildCount: number; pendingChildCount: number;
  }>>([]);
  const [motherLoading, setMotherLoading] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState<string | null>(null); // agentAccountId to join
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadTargetPool, setUploadTargetPool] = useState<"no_ban" | "ban_risk">("no_ban");
  const [showReplaceModal, setShowReplaceModal] = useState<string | null>(null); // oldId
  const [showMigrateModal, setShowMigrateModal] = useState<string | null>(null); // childId
  const [showDetailModal, setShowDetailModal] = useState<AgentAccount | null>(null);
  const [poolTaskPolling, setPoolTaskPolling] = useState<Map<string, { taskId: string; status: string; label: string }>>(new Map());

  // ── Manual account input (shared between accept-invite & phone-verify) ──
  // (REMOVED — migrated to child account management)

  // ── Mother account (母号) selection for accept-invite ──
  // (REMOVED — migrated to child account management)

  // ── Phone pool ──
  const [phones, setPhones] = useState<PhoneEntry[]>([]);
  const [importText, setImportText] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [phoneLoading, setPhoneLoading] = useState(false);

  // ── Daily records ──
  // (REMOVED — migrated to child account management)


  // ── Account Tokens (母号Token) ──
  const [accountTokens, setAccountTokens] = useState<AccountTokenEntry[]>([]);
  const [accountTokenLoading, setAccountTokenLoading] = useState(false);
  const [accountTokenSelected, setAccountTokenSelected] = useState<Set<string>>(new Set());
  const [accountTokenVerifying, setAccountTokenVerifying] = useState<Set<string>>(new Set());
  const [accountTokenTaskMap, setAccountTokenTaskMap] = useState<Map<string, { taskId: string; status: string; errorMessage?: string }>>(new Map());
  const accountTokenPollingRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const [accountTokenPage, setAccountTokenPage] = useState(1);
  const [accountTokenPageSize] = useState(20);
  const [accountTokenTotal, setAccountTokenTotal] = useState(0);
  const [accountTokenTotalPages, setAccountTokenTotalPages] = useState(0);
  const [accountTokenSummary, setAccountTokenSummary] = useState<{ unused: number; used: number; noToken: number } | null>(null);
  const [accountTokenDeleting, setAccountTokenDeleting] = useState<Set<string>>(new Set());

  // ── Task execution state ──
  const [runningTasks, setRunningTasks] = useState<Map<string, { taskId: string; status: string; logs: TaskLog[]; label: string }>>(new Map());
  const pollingRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const [isExecuting, setIsExecuting] = useState(false);

  // ── Load data ──
  const loadPhones = useCallback(async () => {
    setPhoneLoading(true);
    try {
      const data = await apiRequest<PhoneEntry[]>("automation/phone-pool");
      setPhones(data);
    } catch { /* ignore */ }
    setPhoneLoading(false);
  }, []);

  const loadAgentAccounts = useCallback(async (status?: string, page?: number) => {
    setAgentLoading(true);
    try {
      const search: any = { page: page ?? agentPage, pageSize: agentPageSize };
      if (status && status !== "all") search.status = status;
      const data = await apiRequest<{ items: AgentAccount[]; total: number; totalPages: number }>("agent-accounts", { search });
      setAgentAccounts(data.items);
      setAgentTotal(data.total);
      setAgentTotalPages(data.totalPages);
    } catch { /* ignore */ }
    setAgentLoading(false);
  }, [agentPage, agentPageSize]);

  const loadAgentAccountsByPool = useCallback(async (pool: string, page?: number) => {
    setAgentLoading(true);
    try {
      const p = page ?? agentPage;
      const data = await apiRequest<{ items: AgentAccount[]; total: number; totalPages: number }>("agent-accounts", {
        search: { pool, page: p, pageSize: agentPageSize },
      });
      setAgentAccounts(data.items);
      setAgentTotal(data.total);
      setAgentTotalPages(data.totalPages);
    } catch { /* ignore */ }
    setAgentLoading(false);
  }, [agentPage, agentPageSize]);

  const loadAgentStats = useCallback(async () => {
    try {
      const data = await apiRequest<AgentAccountStats>("agent-accounts/stats");
      setAgentStats(data);
    } catch { /* ignore */ }
  }, []);


  const loadAccountTokens = useCallback(async (page?: number) => {
    setAccountTokenLoading(true);
    try {
      const p = page ?? accountTokenPage;
      const data = await apiRequest<AccountTokenPage>("automation/account-tokens", {
        search: { page: p, pageSize: accountTokenPageSize },
      });
      setAccountTokens(data.items);
      setAccountTokenTotal(data.total);
      setAccountTokenTotalPages(data.totalPages);
      setAccountTokenSummary(data.summary);
    } catch { /* ignore */ }
    setAccountTokenLoading(false);
  }, [accountTokenPage, accountTokenPageSize]);


  useEffect(() => {
    loadPhones();
    loadAgentStats();
    return () => {
      pollingRef.current.forEach((interval) => clearInterval(interval));
    };
  }, [loadPhones, loadAgentStats]);

  // Load agent accounts when switching to accounts-mgmt tab or changing filter/page
  useEffect(() => {
    if (activeTab === "accounts-mgmt") {
      loadAgentAccountsByPool(agentSubTab);
    }
  }, [activeTab, agentSubTab, agentPage, loadAgentAccountsByPool]);

  // (daily-records tab removed)


  // Load account tokens when switching to account-tokens tab or changing page
  useEffect(() => {
    if (activeTab === "account-tokens") {
      loadAccountTokens();
    }
    return () => {
      // Clean up polling when leaving tab
      if (activeTab !== "account-tokens") {
        accountTokenPollingRef.current.forEach((interval) => clearInterval(interval));
        accountTokenPollingRef.current.clear();
      }
    };
  }, [activeTab, accountTokenPage, loadAccountTokens]);

  // (manual input / mother account / daily records handlers removed — migrated to child account management)

  // ── Poll task status ──
  const startPolling = useCallback((key: string, taskId: string, label: string) => {
    const existing = pollingRef.current.get(key);
    if (existing) clearInterval(existing);

    const interval = setInterval(async () => {
      try {
        const status = await apiRequest<TaskStatus>(`automation/status/${taskId}`);
        setRunningTasks((prev) => {
          const next = new Map(prev);
          next.set(key, { taskId, status: status.status, logs: status.logs, label });
          return next;
        });

        const terminal = ["SUCCESS", "FAILED_FINAL", "FAILED_RETRYABLE", "CANCELLED", "MANUAL_REVIEW"];
        if (terminal.includes(status.status)) {
          clearInterval(interval);
          pollingRef.current.delete(key);
          if (status.status === "SUCCESS") {
            showToast("success", `${label} 任务完成`);
          } else {
            showToast("error", status.lastErrorMessage ?? `任务失败: ${status.status}`);
          }
        }
      } catch {
        // Polling error — will retry next interval
      }
    }, 3000);

    pollingRef.current.set(key, interval);
  }, [showToast]);

  // (executeAutoJoin / executePhoneVerify removed — migrated to child account management)

  // ── Phone pool actions ──
  const handleImportPhones = async () => {
    if (!importText.trim()) return;
    try {
      const lines = importText.trim().split("\n");
      const result = await apiRequest<{ total: number }>("automation/phone-pool/import", {
        method: "POST",
        body: { lines },
      });
      showToast("success", `成功导入 ${result.total} 个手机号`);
      setImportText("");
      setShowImport(false);
      await loadPhones();
    } catch (err) {
      showToast("error", getErrorMessage(err));
    }
  };

  const handleTogglePhone = async (id: string) => {
    try {
      await apiRequest(`automation/phone-pool/${id}/toggle`, { method: "POST" });
      await loadPhones();
    } catch (err) {
      showToast("error", getErrorMessage(err));
    }
  };

  const handleDeletePhone = async (id: string) => {
    try {
      await apiRequest(`automation/phone-pool/${id}/delete`, { method: "POST" });
      await loadPhones();
    } catch (err) {
      showToast("error", getErrorMessage(err));
    }
  };


  // ── Agent Account handlers ──
  const handleAgentImport = async () => {
    if (!agentImportText.trim()) return;
    setAgentImporting(true);
    try {
      const lines = agentImportText.split("\n");
      const result = await apiRequest<{
        total: number; created: number; skipped: number; errorCount: number;
        createdEmails: string[]; skippedEmails: string[]; errors: string[];
      }>("agent-accounts/import", { method: "POST", body: { lines } });
      showToast(
        result.errorCount > 0 ? "error" : "success",
        `导入完成: 新增 ${result.created}, 跳过 ${result.skipped}, 错误 ${result.errorCount}`
      );
      if (result.created > 0) {
        setAgentImportText("");
        await loadAgentAccountsByPool(agentSubTab);
        await loadAgentStats();
      }
    } catch (err) {
      showToast("error", `导入失败: ${getErrorMessage(err)}`);
    } finally {
      setAgentImporting(false);
    }
  };

  const handleAgentDelete = async (id: string) => {
    setAgentDeletingIds((prev) => new Set(prev).add(id));
    try {
      await apiRequest(`agent-accounts/${id}`, { method: "DELETE" });
      showToast("success", "已删除");
      await loadAgentAccountsByPool(agentSubTab);
      await loadAgentStats();
    } catch (err) {
      showToast("error", getErrorMessage(err));
    } finally {
      setAgentDeletingIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
    }
  };

  const handleAgentBatch = async (action: "phone-verify" | "accept-invite") => {
    if (agentSelected.size === 0) { showToast("error", "请先选择子号"); return; }
    setAgentBatchAction(true);
    try {
      const result = await apiRequest<{ total: number; queued: number; failed: number }>(
        "agent-accounts/batch-action",
        { method: "POST", body: { ids: Array.from(agentSelected), action } }
      );
      showToast(result.failed > 0 ? "error" : "success",
        `已提交 ${result.queued} 个, 失败 ${result.failed} 个`);
      setAgentSelected(new Set());
      await loadAgentAccountsByPool(agentSubTab);
      await loadAgentStats();
    } catch (err) {
      showToast("error", getErrorMessage(err));
    } finally {
      setAgentBatchAction(false);
    }
  };

  const handleAgentTrigger = async (id: string, action: string) => {
    try {
      const result = await apiRequest<{ taskId: string }>(`agent-accounts/${id}/${action}`, { method: "POST" });
      showToast("success", `任务已提交 (${result.taskId.slice(-6)})`);
      setTimeout(() => { loadAgentAccountsByPool(agentSubTab); loadAgentStats(); }, 3000);
    } catch (err) {
      showToast("error", getErrorMessage(err));
    }
  };

  const handleExtractToken = async (id: string) => {
    try {
      const result = await apiRequest<{ success: boolean; message: string; email: string }>(
        `agent-accounts/${id}/extract-token`, { method: "POST" }
      );
      showToast("success", result.message || `Token已提取`);
      await loadAgentAccountsByPool(agentSubTab);
      await loadAgentStats();
    } catch (err) {
      showToast("error", getErrorMessage(err));
    }
  };

  const toggleAgentSelect = (id: string) => {
    setAgentSelected((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const toggleSelectAll = () => {
    if (agentSelected.size === agentAccounts.length) {
      setAgentSelected(new Set());
    } else {
      setAgentSelected(new Set(agentAccounts.map((a) => a.id)));
    }
  };

  // ── Pool management handlers ──

  const loadMotherOptions = async () => {
    setMotherLoading(true);
    try {
      const data = await apiRequest<typeof motherOptions>("agent-accounts/mother-options");
      setMotherOptions(data);
    } catch (err) {
      showToast("error", `加载母号列表失败: ${getErrorMessage(err)}`);
    }
    setMotherLoading(false);
  };

  const handleJoinGroup = async (agentId: string, groupId: string) => {
    try {
      // First we need to trigger the accept-invite for this agent account
      const result = await apiRequest<{ taskId: string }>(`agent-accounts/${agentId}/accept-invite`, { method: "POST" });
      showToast("success", `进组任务已提交 (${result.taskId.slice(-6)})`);
      setShowJoinModal(null);
      // Update the agent account's familyGroupId locally
      await apiRequest(`agent-accounts/${agentId}`, {
        method: "PATCH",
        body: { familyGroupId: groupId },
      }).catch(() => {});
      setTimeout(() => { loadAgentAccountsByPool(agentSubTab); loadAgentStats(); }, 3000);
    } catch (err) {
      showToast("error", getErrorMessage(err));
    }
  };

  const handleBatchUpload = async () => {
    if (agentSelected.size === 0) { showToast("error", "请先选择子号"); return; }
    try {
      const result = await apiRequest<{
        total: number; moved: number; failed: number;
        tokenText: string; errors: Array<{ email: string; error: string }>;
      }>("agent-accounts/batch-upload", {
        method: "POST",
        body: { ids: Array.from(agentSelected), targetPool: uploadTargetPool },
      });

      if (result.tokenText) {
        navigator.clipboard.writeText(result.tokenText);
      }

      showToast(
        result.failed > 0 ? "error" : "success",
        `上号 ${result.moved} 个，失败 ${result.failed} 个${result.tokenText ? '，Token 已复制' : ''}`
      );

      if (result.errors.length > 0) {
        for (const e of result.errors.slice(0, 5)) {
          showToast("error", `${e.email}: ${e.error}`);
        }
      }

      setAgentSelected(new Set());
      setShowUploadModal(false);
      await loadAgentAccountsByPool(agentSubTab);
      await loadAgentStats();
    } catch (err) {
      showToast("error", `上号失败: ${getErrorMessage(err)}`);
    }
  };

  const handleUploadToRosetta = async () => {
    if (agentSelected.size === 0) { showToast("error", "请先选择子号"); return; }
    try {
      const result = await apiRequest<{
        total: number; added: number; updated: number; failed: number;
        errors: Array<{ email: string; error: string }>;
      }>("agent-accounts/upload-rosetta", {
        method: "POST",
        body: { ids: Array.from(agentSelected) },
      });

      showToast(
        result.failed > 0 ? "error" : "success",
        `Rosetta入池: 新增 ${result.added} 个，更新 ${result.updated} 个${result.failed > 0 ? `，失败 ${result.failed} 个` : ''}`
      );

      if (result.errors?.length > 0) {
        for (const e of result.errors.slice(0, 5)) {
          showToast("error", `${e.email}: ${e.error}`);
        }
      }

      setAgentSelected(new Set());
      await loadAgentAccountsByPool(agentSubTab);
      await loadAgentStats();
    } catch (err) {
      showToast("error", `Rosetta入池失败: ${getErrorMessage(err)}`);
    }
  };

  const handleToggleBanned = async (id: string) => {
    try {
      const result = await apiRequest<{ banned: boolean; email: string }>(
        `agent-accounts/${id}/toggle-banned`, { method: "POST" }
      );
      showToast("success", `${result.email} ${result.banned ? '已标记封号' : '已标记未封'}`);
      await loadAgentAccountsByPool(agentSubTab);
    } catch (err) {
      showToast("error", getErrorMessage(err));
    }
  };

  const handleReplace = async (oldId: string, newId: string) => {
    try {
      const result = await apiRequest<{ taskId: string; oldEmail: string; newEmail: string }>(
        `agent-accounts/${oldId}/replace`, { method: "POST", body: { newAccountId: newId } }
      );
      showToast("success", `替换任务已提交: ${result.oldEmail} → ${result.newEmail}`);
      setShowReplaceModal(null);
      // Start polling
      setPoolTaskPolling(prev => {
        const next = new Map(prev);
        next.set(oldId, { taskId: result.taskId, status: "PENDING", label: `替换 ${result.oldEmail}` });
        return next;
      });
      startPoolTaskPolling(oldId, result.taskId, `替换 ${result.oldEmail}`);
    } catch (err) {
      showToast("error", getErrorMessage(err));
    }
  };

  const handleMigrate = async (childId: string, newGroupId: string) => {
    try {
      const result = await apiRequest<{ taskId: string; childEmail: string; newMotherEmail: string }>(
        `agent-accounts/${childId}/migrate`, { method: "POST", body: { newGroupId } }
      );
      showToast("success", `迁移任务已提交: ${result.childEmail} → ${result.newMotherEmail}`);
      setShowMigrateModal(null);
      setPoolTaskPolling(prev => {
        const next = new Map(prev);
        next.set(childId, { taskId: result.taskId, status: "PENDING", label: `迁移 ${result.childEmail}` });
        return next;
      });
      startPoolTaskPolling(childId, result.taskId, `迁移 ${result.childEmail}`);
    } catch (err) {
      showToast("error", getErrorMessage(err));
    }
  };

  const startPoolTaskPolling = (key: string, taskId: string, label: string) => {
    const interval = setInterval(async () => {
      try {
        const status = await apiRequest<TaskStatus>(`automation/status/${taskId}`);
        setPoolTaskPolling(prev => {
          const next = new Map(prev);
          next.set(key, { taskId, status: status.status, label });
          return next;
        });
        const terminal = ["SUCCESS", "FAILED_FINAL", "FAILED_RETRYABLE", "CANCELLED", "MANUAL_REVIEW"];
        if (terminal.includes(status.status)) {
          clearInterval(interval);
          if (status.status === "SUCCESS") {
            showToast("success", `${label} 完成`);
          } else {
            showToast("error", `${label} 失败: ${status.lastErrorMessage ?? status.status}`);
          }
          setTimeout(() => {
            setPoolTaskPolling(prev => { const next = new Map(prev); next.delete(key); return next; });
            loadAgentAccountsByPool(agentSubTab);
            loadAgentStats();
          }, 2000);
        }
      } catch { /* ignore */ }
    }, 3000);
  };

  // ── Computed ──
  const isAnyRunning = runningTasks.size > 0 && Array.from(runningTasks.values()).some((t) => t.status === "RUNNING" || t.status === "PENDING");
  const availablePhones = phones.filter((p) => p.status === "available").length;
  const disabledPhones = phones.filter((p) => p.status !== "available").length;

  // (filteredMotherAccounts, dailyGrouped, dailyDates removed)

  /* ================================================================
     Render
     ================================================================ */

  const TABS: { id: TabId; label: string; emoji: string }[] = [
    { id: "accounts-mgmt", label: "子号管理", emoji: "👤" },
    { id: "account-tokens", label: "母号Token", emoji: "🔑" },
    { id: "phone-pool", label: "手机号池", emoji: "☎️" },
  ];

  return (
    <div className="panel-stack">
      <div className="section-copy">
        <p className="label">Agent Service</p>
        <h2 className="panel-title">代理服务</h2>
        <p className="muted">统一子号生命周期管理 — 录入 → 验证 → 进组 → 上号</p>
      </div>

      {/* Tab bar */}
      <div className="agent-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`agent-tab${activeTab === tab.id ? " active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
            type="button"
          >
            <span>{tab.emoji}</span>
            <span>{tab.label}</span>
            {tab.id === "accounts-mgmt" && agentStats && agentStats.total > 0 && (
              <span className="agent-tab-badge">{agentStats.total}</span>
            )}
          </button>
        ))}
      </div>

      {/* ─── Agent Accounts Management Tab ─── */}
      {activeTab === "accounts-mgmt" && (
        <div className="agent-workspace">
          {/* Pool Stats Overview */}
          {agentStats && (
            <div className="agent-stats-grid">
              {([
                { key: "pending" as const, label: "未上号", count: agentStats.pools?.pending ?? 0, emoji: "📝", color: "#6366f1" },
                { key: "no_ban" as const, label: "不封号池", count: agentStats.pools?.noBan ?? 0, emoji: "✅", color: "#22c55e" },
                { key: "ban_risk" as const, label: "封号池", count: agentStats.pools?.banRisk ?? 0, emoji: "⚠️", color: "#f59e0b" },
              ] as const).map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className={`agent-stat-card${agentSubTab === s.key ? " active" : ""}`}
                  onClick={() => { setAgentSubTab(s.key); setAgentSelected(new Set()); setAgentPage(1); }}
                  style={{ "--stat-color": s.color } as React.CSSProperties}
                >
                  <span className="agent-stat-emoji">{s.emoji}</span>
                  <span className="agent-stat-count">{s.count}</span>
                  <span className="agent-stat-label">{s.label}</span>
                </button>
              ))}
            </div>
          )}

          {/* ═══ 未上号号池 ═══ */}
          {agentSubTab === "pending" && (
            <>
              {/* Bulk Import */}
              <details className="agent-import-details">
                <summary className="agent-section-header" style={{ cursor: "pointer", userSelect: "none" }}>
                  <span className="agent-step-badge">📥</span>
                  <span>批量导入子号</span>
                </summary>
                <div className="agent-import-box" style={{ marginTop: 10 }}>
                  <p className="muted" style={{ marginBottom: 8, fontSize: 12 }}>
                    每行一个子号，格式：<code>邮箱---密码---2FA密钥</code>（或用 <code>——</code> / <code>|</code> 分隔）
                  </p>
                  <Textarea
                    className="field-input"
                    value={agentImportText}
                    onChange={(e) => setAgentImportText(e.target.value)}
                    placeholder={"child1@gmail.com----password1----TOTPKEY1\nchild2@gmail.com|password2|TOTPKEY2"}
                    style={{ minHeight: 80, fontFamily: "var(--mono)", fontSize: 12, resize: "vertical" }}
                  />
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8, alignItems: "center" }}>
                    <span className="muted" style={{ fontSize: 11, marginRight: "auto" }}>
                      {agentImportText.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).length} 行
                    </span>
                    <Button
                      onClick={handleAgentImport}
                      disabled={!agentImportText.trim() || agentImporting}
                      type="button"
                    >
                      {agentImporting && <Spinner size={14} color="currentColor" />}
                      导入凭证
                    </Button>
                  </div>
                </div>
              </details>

              {/* Batch Action Bar */}
              {agentSelected.size > 0 && (
                <div className="agent-execute-bar">
                  <div className="agent-execute-summary">
                    <span>已选 <strong>{agentSelected.size}</strong> 个子号</span>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Button type="button" disabled={agentBatchAction}
                      onClick={() => handleAgentBatch("phone-verify")} size="sm">
                      {agentBatchAction && <Spinner size={12} color="currentColor" />} 📱 批量验证
                    </Button>
                    <Button type="button" disabled={agentBatchAction}
                      onClick={() => handleAgentBatch("accept-invite")} size="sm">
                      {agentBatchAction && <Spinner size={12} color="currentColor" />} 📨 批量进组
                    </Button>
                    <Button type="button"
                      onClick={() => setShowUploadModal(true)}
                      size="sm"
                      style={{ background: "var(--emerald, #059669)", color: "white" }}>
                      🚀 一键上号 ({agentSelected.size})
                    </Button>
                    <Button type="button" disabled={agentBatchAction}
                      onClick={handleUploadToRosetta}
                      size="sm"
                      style={{ background: "var(--blue, #2563eb)", color: "white" }}>
                      {agentBatchAction && <Spinner size={12} color="currentColor" />} 🔄 上号Rosetta ({agentSelected.size})
                    </Button>
                  </div>
                </div>
              )}

              {/* Pending Account List */}
              <div className="agent-section-header">
                <span className="agent-step-badge">📋</span>
                <span>未上号列表 ({agentTotal})</span>
                <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                  <Button variant="outline" size="sm" type="button"
                    onClick={() => { setAgentPage(1); loadAgentAccountsByPool("pending", 1); loadAgentStats(); }}
                    disabled={agentLoading}>
                    {agentLoading ? <Spinner size={12} color="currentColor" /> : "刷新"}
                  </Button>
                </div>
              </div>

              {agentLoading && agentAccounts.length === 0 ? (
                <div style={{ textAlign: "center", padding: 48 }}>
                  <Spinner size={24} color="var(--accent)" />
                  <p className="muted" style={{ marginTop: 12 }}>加载中…</p>
                </div>
              ) : agentAccounts.length === 0 ? (
                <div style={{ textAlign: "center", padding: 48, opacity: 0.5 }}>
                  <p style={{ fontSize: 32, marginBottom: 8 }}>👤</p>
                  <p>暂无未上号子号</p>
                  <p style={{ fontSize: 12 }}>展开上方「批量导入子号」添加</p>
                </div>
              ) : (
                <div style={{ overflow: "auto" }}>
                  <table className="data-table" style={{ width: "100%" }}>
                    <thead>
                      <tr>
                        <th style={{ width: 36 }}>
                          <input type="checkbox" checked={agentSelected.size === agentAccounts.length && agentAccounts.length > 0}
                            onChange={toggleSelectAll} style={{ accentColor: "var(--accent)", cursor: "pointer" }} />
                        </th>
                        <th>邮箱</th>
                        <th>状态</th>
                        <th>Token</th>
                        <th>家庭组</th>
                        <th style={{ width: 200 }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agentAccounts.map((acc) => {
                        const hasToken = !!acc.refreshToken;
                        const isDeleting = agentDeletingIds.has(acc.id);
                        return (
                          <tr key={acc.id}>
                            <td>
                              <input type="checkbox" checked={agentSelected.has(acc.id)}
                                onChange={() => toggleAgentSelect(acc.id)}
                                style={{ accentColor: "var(--accent)", cursor: "pointer" }} />
                            </td>
                            <td>
                              <code style={{ fontSize: 12 }}>{acc.loginEmail}</code>
                              {acc.totpSecret && <span title="有2FA密钥" style={{ marginLeft: 4, fontSize: 10 }}>🔐</span>}
                            </td>
                            <td>
                              <StatusBadge
                                value={acc.status === "REGISTERED" ? "已录入" : acc.status === "PHONE_VERIFIED" ? "已验证" : acc.status === "IN_GROUP" ? "已进组" : acc.status}
                                tone={acc.status === "IN_GROUP" ? "emerald" : acc.status === "PHONE_VERIFIED" ? "sky" : "amber"}
                              />
                            </td>
                            <td>
                              {hasToken ? (
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                                  <span style={{ color: "var(--green)", fontSize: 12 }}>✅</span>
                                  <Button variant="outline" size="sm" type="button" title="复制 Token"
                                    style={{ fontSize: 10, padding: "1px 5px", lineHeight: 1, minWidth: 0 }}
                                    onClick={() => { navigator.clipboard.writeText(acc.refreshToken!); showToast("success", "已复制 Token"); }}>
                                    📋
                                  </Button>
                                </span>
                              ) : (
                                <span style={{ color: "var(--red)", fontSize: 12, opacity: 0.6 }}>❌</span>
                              )}
                            </td>
                            <td style={{ fontSize: 12, opacity: acc.familyGroupId ? 1 : 0.3 }}>
                              {acc.familyGroupId ? acc.familyGroupId.slice(-6) : "-"}
                            </td>
                            <td>
                              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                                <Button variant="outline" size="sm" type="button"
                                  onClick={() => handleAgentTrigger(acc.id, "phone-verify")}
                                  style={{ fontSize: 10, padding: "2px 8px" }}>📱 验证</Button>
                                {!acc.refreshToken && acc.lastTaskId && (
                                  <Button variant="outline" size="sm" type="button"
                                    onClick={() => handleExtractToken(acc.id)}
                                    style={{ fontSize: 10, padding: "2px 8px" }}>📥 提取Token</Button>
                                )}
                                <Button variant="outline" size="sm" type="button"
                                  onClick={() => { setShowJoinModal(acc.id); loadMotherOptions(); }}
                                  style={{ fontSize: 10, padding: "2px 8px" }}>🏠 进组</Button>
                                <ConfirmButton
                                  className="button"
                                  style={{ fontSize: 10, padding: "2px 8px", color: "var(--red)" }}
                                  confirmLabel="确定？"
                                  onConfirm={() => handleAgentDelete(acc.id)}>
                                  {isDeleting ? <Spinner size={10} color="currentColor" /> : "删除"}
                                </ConfirmButton>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Pagination */}
              {agentTotalPages > 1 && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginTop: 12, fontSize: 13 }}>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={agentPage <= 1 || agentLoading}
                    onClick={() => { setAgentPage((p) => Math.max(1, p - 1)); setAgentSelected(new Set()); }}
                    type="button"
                  >
                    ← 上一页
                  </Button>
                  <span className="muted">
                    第 {agentPage} / {agentTotalPages} 页 · 共 {agentTotal} 条
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={agentPage >= agentTotalPages || agentLoading}
                    onClick={() => { setAgentPage((p) => Math.min(agentTotalPages, p + 1)); setAgentSelected(new Set()); }}
                    type="button"
                  >
                    下一页 →
                  </Button>
                </div>
              )}
            </>
          )}

          {/* ═══ 已上号池 (不封号 / 封号) ═══ */}
          {(agentSubTab === "no_ban" || agentSubTab === "ban_risk") && (
            <>
              <div className="agent-section-header">
                <span className="agent-step-badge">{agentSubTab === "no_ban" ? "✅" : "⚠️"}</span>
                <span>{agentSubTab === "no_ban" ? "不封号号池" : "封号号池"} ({agentTotal})</span>
                <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                  <Button variant="outline" size="sm" type="button"
                    onClick={() => { setAgentPage(1); loadAgentAccountsByPool(agentSubTab, 1); loadAgentStats(); }}
                    disabled={agentLoading}>
                    {agentLoading ? <Spinner size={12} color="currentColor" /> : "刷新"}
                  </Button>
                </div>
              </div>

              {/* Pool task progress */}
              {poolTaskPolling.size > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10, padding: "8px 12px", background: "var(--surface-2, #f5f5f4)", borderRadius: 8 }}>
                  {Array.from(poolTaskPolling.entries()).map(([key, info]) => (
                    <div key={key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                      <Spinner size={12} color="var(--accent)" />
                      <span>{info.label}</span>
                      <StatusBadge value={info.status} tone={info.status === "SUCCESS" ? "emerald" : info.status.includes("FAIL") ? "crimson" : "amber"} />
                    </div>
                  ))}
                </div>
              )}

              {agentLoading && agentAccounts.length === 0 ? (
                <div style={{ textAlign: "center", padding: 48 }}>
                  <Spinner size={24} color="var(--accent)" />
                </div>
              ) : agentAccounts.length === 0 ? (
                <div style={{ textAlign: "center", padding: 48, opacity: 0.5 }}>
                  <p>暂无{agentSubTab === "no_ban" ? "不封号" : "封号"}池子号</p>
                </div>
              ) : (
                <div style={{ overflow: "auto" }}>
                  <table className="data-table" style={{ width: "100%" }}>
                    <thead>
                      <tr>
                        <th>邮箱</th>
                        <th>关联母号</th>
                        <th>封号状态</th>
                        <th>上号时间</th>
                        <th style={{ width: 220 }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agentAccounts.map((acc) => {
                        const taskInfo = poolTaskPolling.get(acc.id);
                        return (
                          <tr key={acc.id} style={taskInfo ? { background: "rgba(99,102,241,0.06)" } : undefined}>
                            <td>
                              <code style={{ fontSize: 12 }}>{acc.loginEmail}</code>
                              {acc.totpSecret && <span style={{ marginLeft: 4, fontSize: 10 }}>🔐</span>}
                            </td>
                            <td style={{ fontSize: 12 }}>
                              {acc.motherAccountId
                                ? <span title={acc.motherGroupId ?? ""}>{acc.motherGroupId?.slice(-6) ?? "-"}</span>
                                : <span style={{ opacity: 0.3 }}>-</span>
                              }
                            </td>
                            <td>
                              <StatusBadge
                                value={acc.banned ? "已封" : "未封"}
                                tone={acc.banned ? "crimson" : "emerald"}
                              />
                            </td>
                            <td style={{ fontSize: 11, opacity: 0.7 }}>
                              {acc.uploadedToPool
                                ? new Date(acc.uploadedToPool).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
                                : "-"}
                            </td>
                            <td>
                              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                                <Button variant="outline" size="sm" type="button"
                                  onClick={() => setShowDetailModal(acc)}
                                  style={{ fontSize: 10, padding: "2px 8px" }}>📄 详情</Button>
                                <Button variant="outline" size="sm" type="button"
                                  onClick={() => { setShowReplaceModal(acc.id); loadAgentAccountsByPool("pending"); }}
                                  style={{ fontSize: 10, padding: "2px 8px" }}>🔄 替换</Button>
                                <Button variant="outline" size="sm" type="button"
                                  onClick={() => { setShowMigrateModal(acc.id); loadMotherOptions(); }}
                                  style={{ fontSize: 10, padding: "2px 8px" }}>↗️ 迁移</Button>
                                <Button variant="outline" size="sm" type="button"
                                  onClick={() => handleToggleBanned(acc.id)}
                                  style={{ fontSize: 10, padding: "2px 8px", color: acc.banned ? "var(--green)" : "var(--red)" }}>
                                  {acc.banned ? "✅ 标记未封" : "🚫 标记封号"}
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Pagination */}
              {agentTotalPages > 1 && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginTop: 12, fontSize: 13 }}>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={agentPage <= 1 || agentLoading}
                    onClick={() => { setAgentPage((p) => Math.max(1, p - 1)); setAgentSelected(new Set()); }}
                    type="button"
                  >
                    ← 上一页
                  </Button>
                  <span className="muted">
                    第 {agentPage} / {agentTotalPages} 页 · 共 {agentTotal} 条
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={agentPage >= agentTotalPages || agentLoading}
                    onClick={() => { setAgentPage((p) => Math.min(agentTotalPages, p + 1)); setAgentSelected(new Set()); }}
                    type="button"
                  >
                    下一页 →
                  </Button>
                </div>
              )}
            </>
          )}

          {/* ═══ Modal: 进组选母号 ═══ */}
          {showJoinModal && (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
              onClick={() => setShowJoinModal(null)}>
              <div style={{ background: "var(--surface-1, white)", borderRadius: 12, padding: 24, maxWidth: 600, width: "90%", maxHeight: "80vh", overflow: "auto" }}
                onClick={e => e.stopPropagation()}>
                <h3 style={{ margin: "0 0 16px 0", fontSize: 16 }}>🏠 选择母号（进组）</h3>
                {motherLoading ? (
                  <div style={{ textAlign: "center", padding: 32 }}><Spinner size={20} color="var(--accent)" /></div>
                ) : motherOptions.length === 0 ? (
                  <p className="muted">没有可用母号</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {motherOptions.map(opt => (
                      <div key={opt.groupId} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", border: "1px solid var(--border, #e5e5e5)", borderRadius: 8, cursor: "pointer" }}
                        onClick={() => handleJoinGroup(showJoinModal!, opt.groupId)}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{opt.accountName}</div>
                          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{opt.accountEmail}</div>
                        </div>
                        <div style={{ textAlign: "right", fontSize: 11 }}>
                          <div>号池: <strong>{opt.poolChildCount}</strong> · 待上号: <strong>{opt.pendingChildCount}</strong></div>
                          <div>成员: {opt.memberCount} · 空位: <strong style={{ color: opt.availableSlots > 0 ? "var(--green)" : "var(--red)" }}>{opt.availableSlots}</strong></div>
                          <div style={{ opacity: 0.7 }}>到期: {opt.subscriptionExpiresAt ? new Date(opt.subscriptionExpiresAt).toLocaleDateString("zh-CN") : "未知"}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ marginTop: 16, textAlign: "right" }}>
                  <Button variant="outline" type="button" onClick={() => setShowJoinModal(null)}>取消</Button>
                </div>
              </div>
            </div>
          )}

          {/* ═══ Modal: 一键上号 ═══ */}
          {showUploadModal && (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
              onClick={() => setShowUploadModal(false)}>
              <div style={{ background: "var(--surface-1, white)", borderRadius: 12, padding: 24, maxWidth: 400, width: "90%" }}
                onClick={e => e.stopPropagation()}>
                <h3 style={{ margin: "0 0 16px 0", fontSize: 16 }}>🚀 一键上号</h3>
                <p style={{ fontSize: 13, marginBottom: 12 }}>将 <strong>{agentSelected.size}</strong> 个子号移入已上号池，Token 将自动复制到剪贴板。</p>
                <div style={{ marginBottom: 16 }}>
                  <label style={{ fontSize: 13, fontWeight: 600, display: "block", marginBottom: 8 }}>选择目标号池：</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button
                      variant={uploadTargetPool === "no_ban" ? "default" : "outline"}
                      type="button"
                      onClick={() => setUploadTargetPool("no_ban")}
                      style={{ flex: 1, fontSize: 13 }}
                    >
                      ✅ 不封号池
                    </Button>
                    <Button
                      variant={uploadTargetPool === "ban_risk" ? "default" : "outline"}
                      type="button"
                      onClick={() => setUploadTargetPool("ban_risk")}
                      style={{ flex: 1, fontSize: 13 }}
                    >
                      ⚠️ 封号池
                    </Button>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <Button variant="outline" type="button" onClick={() => setShowUploadModal(false)}>取消</Button>
                  <Button type="button" onClick={handleBatchUpload}>确认上号</Button>
                </div>
              </div>
            </div>
          )}

          {/* ═══ Modal: 详情 ═══ */}
          {showDetailModal && (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
              onClick={() => setShowDetailModal(null)}>
              <div style={{ background: "var(--surface-1, white)", borderRadius: 12, padding: 24, maxWidth: 500, width: "90%" }}
                onClick={e => e.stopPropagation()}>
                <h3 style={{ margin: "0 0 16px 0", fontSize: 16 }}>📄 子号详情</h3>
                <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: "8px 12px", fontSize: 13 }}>
                  <span style={{ fontWeight: 600, opacity: 0.7 }}>邮箱</span>
                  <code>{showDetailModal.loginEmail}</code>
                  <span style={{ fontWeight: 600, opacity: 0.7 }}>状态</span>
                  <span>{showDetailModal.status}</span>
                  <span style={{ fontWeight: 600, opacity: 0.7 }}>号池</span>
                  <span>{showDetailModal.pool === "no_ban" ? "✅ 不封号池" : "⚠️ 封号池"}</span>
                  <span style={{ fontWeight: 600, opacity: 0.7 }}>封号状态</span>
                  <StatusBadge value={showDetailModal.banned ? "已封" : "未封"} tone={showDetailModal.banned ? "crimson" : "emerald"} />
                  <span style={{ fontWeight: 600, opacity: 0.7 }}>上号时间</span>
                  <span>{showDetailModal.uploadedToPool ? new Date(showDetailModal.uploadedToPool).toLocaleString("zh-CN") : "-"}</span>
                  <span style={{ fontWeight: 600, opacity: 0.7 }}>关联母号</span>
                  <span>{showDetailModal.motherAccountId ? showDetailModal.motherGroupId?.slice(-6) : "-"}</span>
                  <span style={{ fontWeight: 600, opacity: 0.7 }}>Token</span>
                  <span>{showDetailModal.refreshToken ? "✅ 有" : "❌ 无"}</span>
                  <span style={{ fontWeight: 600, opacity: 0.7 }}>Token获取</span>
                  <span>{showDetailModal.tokenObtainedAt ? new Date(showDetailModal.tokenObtainedAt).toLocaleString("zh-CN") : "-"}</span>
                </div>
                <div style={{ marginTop: 16, textAlign: "right" }}>
                  <Button variant="outline" type="button" onClick={() => setShowDetailModal(null)}>关闭</Button>
                </div>
              </div>
            </div>
          )}

          {/* ═══ Modal: 替换 ═══ */}
          {showReplaceModal && (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
              onClick={() => setShowReplaceModal(null)}>
              <div style={{ background: "var(--surface-1, white)", borderRadius: 12, padding: 24, maxWidth: 600, width: "90%", maxHeight: "80vh", overflow: "auto" }}
                onClick={e => e.stopPropagation()}>
                <h3 style={{ margin: "0 0 8px 0", fontSize: 16 }}>🔄 替换子号</h3>
                <p className="muted" style={{ fontSize: 12, marginBottom: 16 }}>从未上号池选择新子号。流程：移除旧号 → 邀请新号 → 新号自动进组 → 旧号标记封号</p>
                <ReplaceAccountPicker
                  onSelect={(newId) => handleReplace(showReplaceModal!, newId)}
                  onCancel={() => setShowReplaceModal(null)}
                  showToast={showToast}
                />
              </div>
            </div>
          )}

          {/* ═══ Modal: 迁移 ═══ */}
          {showMigrateModal && (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
              onClick={() => setShowMigrateModal(null)}>
              <div style={{ background: "var(--surface-1, white)", borderRadius: 12, padding: 24, maxWidth: 600, width: "90%", maxHeight: "80vh", overflow: "auto" }}
                onClick={e => e.stopPropagation()}>
                <h3 style={{ margin: "0 0 8px 0", fontSize: 16 }}>↗️ 迁移子号</h3>
                <p className="muted" style={{ fontSize: 12, marginBottom: 16 }}>选择新母号。流程：从旧母号移除 → 新母号邀请 → 子号自动进组</p>
                {motherLoading ? (
                  <div style={{ textAlign: "center", padding: 32 }}><Spinner size={20} color="var(--accent)" /></div>
                ) : motherOptions.length === 0 ? (
                  <p className="muted">没有可用母号</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {motherOptions.map(opt => (
                      <div key={opt.groupId} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", border: "1px solid var(--border, #e5e5e5)", borderRadius: 8, cursor: "pointer" }}
                        onClick={() => handleMigrate(showMigrateModal!, opt.groupId)}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{opt.accountName}</div>
                          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{opt.accountEmail}</div>
                        </div>
                        <div style={{ textAlign: "right", fontSize: 11 }}>
                          <div>号池: <strong>{opt.poolChildCount}</strong></div>
                          <div>成员: {opt.memberCount} · 空位: <strong style={{ color: opt.availableSlots > 0 ? "var(--green)" : "var(--red)" }}>{opt.availableSlots}</strong></div>
                          <div style={{ opacity: 0.7 }}>到期: {opt.subscriptionExpiresAt ? new Date(opt.subscriptionExpiresAt).toLocaleDateString("zh-CN") : "未知"}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ marginTop: 16, textAlign: "right" }}>
                  <Button variant="outline" type="button" onClick={() => setShowMigrateModal(null)}>取消</Button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─── Account Tokens Tab (母号Token) ─── */}
      {activeTab === "account-tokens" && (
        <div className="agent-workspace">
          <div className="agent-toolbar">
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <Button
                variant="outline"
                onClick={() => loadAccountTokens()}
                disabled={accountTokenLoading}
                type="button"
              >
                {accountTokenLoading ? "加载中…" : "🔄 刷新"}
              </Button>
              {accountTokenSelected.size > 0 && (
                <>
                  <Button
                    size="sm"
                    style={{ background: 'var(--accent, #6366f1)' }}
                    onClick={() => {
                      const emails = accountTokens
                        .filter(a => accountTokenSelected.has(a.id))
                        .map(a => a.loginEmail)
                        .join('\n');
                      navigator.clipboard.writeText(emails);
                      showToast("success", `已复制 ${accountTokenSelected.size} 个邮箱`);
                    }}
                    type="button"
                  >
                    📋 复制邮箱 ({accountTokenSelected.size})
                  </Button>
                  <Button
                    size="sm"
                    style={{ background: 'var(--emerald, #059669)' }}
                    onClick={() => {
                      const tokens = accountTokens
                        .filter(a => accountTokenSelected.has(a.id) && a.refreshToken)
                        .map(a => a.refreshToken!)
                        .join('\n');
                      if (!tokens) {
                        showToast("error", "选中的账号没有可复制的 Token");
                        return;
                      }
                      navigator.clipboard.writeText(tokens);
                      const count = tokens.split('\n').length;
                      showToast("success", `已复制 ${count} 个 Token`);
                    }}
                    type="button"
                  >
                    🔑 复制Token ({accountTokens.filter(a => accountTokenSelected.has(a.id) && a.refreshToken).length})
                  </Button>
                  <Button
                    size="sm"
                    style={{ background: 'var(--blue, #2563eb)' }}
                    onClick={() => {
                      const lines = accountTokens
                        .filter(a => accountTokenSelected.has(a.id) && a.refreshToken)
                        .map(a => `${a.loginEmail}|${a.refreshToken}`)
                        .join('\n');
                      if (!lines) {
                        showToast("error", "选中的账号没有可复制的 Token");
                        return;
                      }
                      navigator.clipboard.writeText(lines);
                      const count = lines.split('\n').length;
                      showToast("success", `已复制 ${count} 条 邮箱|Token`);
                    }}
                    type="button"
                  >
                    📄 复制邮箱|Token
                  </Button>
                  <Button
                    onClick={async () => {
                      const ids = Array.from(accountTokenSelected);
                      try {
                        const result = await apiRequest<{
                          total: number;
                          queued: number;
                          failed: number;
                          results: Array<{ accountId: string; email: string; taskId?: string; error?: string }>;
                        }>("automation/account-token/batch-verify", {
                          method: "POST",
                          body: { accountIds: ids },
                        });
                        showToast("success", `已提交 ${result.queued} 个验证任务`);

                        for (const r of result.results) {
                          if (r.taskId) {
                            setAccountTokenVerifying((prev) => new Set([...prev, r.accountId]));
                            setAccountTokenTaskMap((prev) => {
                              const next = new Map(prev);
                              next.set(r.accountId, { taskId: r.taskId!, status: "PENDING" });
                              return next;
                            });
                            const pollInterval = setInterval(async () => {
                              try {
                                const taskStatus = await apiRequest<TaskStatus>(`automation/status/${r.taskId}`);
                                setAccountTokenTaskMap((prev) => {
                                  const next = new Map(prev);
                                  const errMsg = taskStatus.status === "FAILED_FINAL"
                                    ? (taskStatus.lastErrorMessage || taskStatus.logs?.[taskStatus.logs.length - 1]?.message || "验证失败")
                                    : undefined;
                                  next.set(r.accountId, { taskId: r.taskId!, status: taskStatus.status, errorMessage: errMsg });
                                  return next;
                                });
                                if (taskStatus.status === "SUCCESS" || taskStatus.status === "FAILED_FINAL") {
                                  clearInterval(pollInterval);
                                  accountTokenPollingRef.current.delete(r.accountId);
                                  setAccountTokenVerifying((prev) => {
                                    const next = new Set(prev);
                                    next.delete(r.accountId);
                                    return next;
                                  });
                                  if (taskStatus.status === "SUCCESS") {
                                    try {
                                      await apiRequest(`automation/account-token/extract/${r.taskId}`, { method: "POST" });
                                      showToast("success", `${r.email} Token 提取成功`);
                                      loadAccountTokens();
                                    } catch (err) {
                                      showToast("error", `${r.email} Token 提取失败: ${getErrorMessage(err)}`);
                                    }
                                  }
                                }
                              } catch { /* ignore */ }
                            }, 3000);
                            accountTokenPollingRef.current.set(r.accountId, pollInterval);
                          }
                        }
                        setAccountTokenSelected(new Set());
                      } catch (err) {
                        showToast("error", `批量验证失败: ${getErrorMessage(err)}`);
                      }
                    }}
                    type="button"
                  >
                    📱 批量验证 ({accountTokenSelected.size})
                  </Button>
                </>
              )}
            </div>
            <span className="muted" style={{ fontSize: 12 }}>
              共 {accountTokenTotal} 个母号
              {accountTokenSummary && (
                <>
                  {" "}· {accountTokenSummary.unused} 未用
                  {" "}· {accountTokenSummary.used} 已用
                  {" "}· {accountTokenSummary.noToken} 无Token
                </>
              )}
            </span>
          </div>

          {accountTokenLoading && accountTokens.length === 0 ? (
            <div style={{ textAlign: "center", padding: 48 }}>
              <Spinner size={24} color="var(--accent)" />
              <p className="muted" style={{ marginTop: 12 }}>加载中…</p>
            </div>
          ) : accountTokens.length === 0 ? (
            <div className="empty-state">
              <p>没有配置了密码的母号</p>
            </div>
          ) : (
            <>
              <div className="agent-table-wrap">
                <table className="agent-table">
                  <thead>
                    <tr>
                      <th style={{ width: 30 }}>
                        <input
                          type="checkbox"
                          checked={accountTokenSelected.size === accountTokens.length && accountTokens.length > 0}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setAccountTokenSelected(new Set(accountTokens.map((a) => a.id)));
                            } else {
                              setAccountTokenSelected(new Set());
                            }
                          }}
                        />
                      </th>
                      <th>母号邮箱</th>
                      <th>名称</th>
                      <th>订阅计划</th>
                      <th>订阅到期</th>
                      <th>Token 状态</th>
                      <th>获取时间</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accountTokens.map((account) => {
                      const taskInfo = accountTokenTaskMap.get(account.id);
                      const isVerifying = accountTokenVerifying.has(account.id);
                      const isTokenDeleting = accountTokenDeleting.has(account.id);
                      return (
                        <tr key={account.id} style={isVerifying ? { background: "rgba(var(--accent-rgb), 0.05)" } : undefined}>
                          <td>
                            <input
                              type="checkbox"
                              checked={accountTokenSelected.has(account.id)}
                              onChange={(e) => {
                                setAccountTokenSelected((prev) => {
                                  const next = new Set(prev);
                                  if (e.target.checked) next.add(account.id);
                                  else next.delete(account.id);
                                  return next;
                                });
                              }}
                            />
                          </td>
                          <td style={{ fontFamily: "monospace", fontSize: 12 }}>{account.loginEmail}</td>
                          <td>{account.name}</td>
                          <td style={{ fontSize: 11 }}>
                            {account.subscriptionPlan ? (
                              <span style={{
                                color: account.subscriptionPlan.toLowerCase().includes("ultra") ? "var(--accent)" : "var(--text-secondary)",
                                fontWeight: account.subscriptionPlan.toLowerCase().includes("ultra") ? 600 : 400,
                              }}>
                                {account.subscriptionPlan.toLowerCase().includes("ultra") ? "⭐ " : ""}
                                {account.subscriptionPlan}
                              </span>
                            ) : (
                              <span style={{ opacity: 0.4 }}>—</span>
                            )}
                            {account.subscriptionStatus && account.subscriptionStatus !== "ACTIVE" && (
                              <span style={{ fontSize: 10, color: "var(--red)", marginLeft: 4 }}>
                                ({account.subscriptionStatus})
                              </span>
                            )}
                          </td>
                          <td style={{ fontSize: 11, whiteSpace: "nowrap" }}>
                            {account.subscriptionExpiresAt ? (() => {
                              const exp = new Date(account.subscriptionExpiresAt);
                              const now = new Date();
                              const daysLeft = Math.ceil((exp.getTime() - now.getTime()) / 86400000);
                              const isExpired = daysLeft < 0;
                              const isExpiringSoon = daysLeft >= 0 && daysLeft <= 7;
                              return (
                                <span style={{
                                  color: isExpired ? "var(--red)" : isExpiringSoon ? "var(--amber)" : "var(--green)",
                                  fontWeight: (isExpired || isExpiringSoon) ? 600 : 400,
                                }}>
                                  {exp.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}
                                  <span style={{ fontSize: 10, marginLeft: 2, opacity: 0.8 }}>
                                    {isExpired ? `(已过期${Math.abs(daysLeft)}天)` : `(${daysLeft}天)`}
                                  </span>
                                </span>
                              );
                            })() : (
                              <span style={{ opacity: 0.4 }}>—</span>
                            )}
                          </td>
                          <td>
                            {isVerifying ? (
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                                <Spinner size={12} color="var(--accent)" />
                                <span style={{ color: "var(--accent)" }}>
                                  {taskInfo?.status === "RUNNING" ? "验证中…" : "等待中…"}
                                </span>
                              </span>
                            ) : taskInfo?.status === "FAILED_FINAL" ? (
                              <span style={{ color: "var(--red)", fontSize: 12 }} title={taskInfo.errorMessage}>
                                ❌ {(taskInfo.errorMessage || "失败").slice(0, 30)}
                              </span>
                            ) : account.refreshToken ? (
                              account.tokenStatus === "used" ? (
                                <span style={{ color: "var(--blue)", fontSize: 12 }}>🟥 已使用</span>
                              ) : (
                                <span style={{ color: "var(--green)", fontSize: 12 }}>🟢 未使用</span>
                              )
                            ) : (
                              <span style={{ opacity: 0.5, fontSize: 12 }}>⚪ 无 Token</span>
                            )}
                          </td>
                          <td style={{ fontSize: 11, opacity: 0.7 }}>
                            {account.tokenObtainedAt
                              ? new Date(account.tokenObtainedAt).toLocaleString("zh-CN", {
                                  month: "numeric", day: "numeric",
                                  hour: "2-digit", minute: "2-digit",
                                })
                              : "—"}
                          </td>
                          <td>
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                              {/* Copy Token */}
                              {account.refreshToken && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  style={{ fontSize: 11, padding: "2px 8px" }}
                                  onClick={() => {
                                    navigator.clipboard.writeText(account.refreshToken!);
                                    showToast("success", "已复制 Token");
                                  }}
                                  type="button"
                                >
                                  📋 复制
                                </Button>
                              )}
                              {/* Toggle used/unused */}
                              {account.refreshToken && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  style={{
                                    fontSize: 11,
                                    padding: "2px 8px",
                                    color: account.tokenStatus === "used" ? "var(--green)" : "var(--blue)",
                                  }}
                                  onClick={async () => {
                                    const newStatus = account.tokenStatus === "used" ? "unused" : "used";
                                    try {
                                      await apiRequest(`automation/account-token/${account.id}/status`, {
                                        method: "POST",
                                        body: { status: newStatus },
                                      });
                                      setAccountTokens((prev) =>
                                        prev.map((a) =>
                                          a.id === account.id ? { ...a, tokenStatus: newStatus } : a
                                        )
                                      );
                                      showToast("success", `已标记为${newStatus === "used" ? "已用" : "未用"}`);
                                    } catch (err) {
                                      showToast("error", getErrorMessage(err));
                                    }
                                  }}
                                  type="button"
                                >
                                  {account.tokenStatus === "used" ? "↩ 标记未用" : "✓ 标记已用"}
                                </Button>
                              )}
                              {/* Trigger verify */}
                              {!isVerifying && (
                                <Button
                                  size="sm"
                                  style={{ fontSize: 11, padding: "2px 8px" }}
                                  onClick={async () => {
                                    try {
                                      const result = await apiRequest<{
                                        taskId: string;
                                        email: string;
                                        status: string;
                                      }>(`automation/account-token/trigger-verify/${account.id}`, {
                                        method: "POST",
                                      });
                                      showToast("info", `${account.loginEmail} 验证任务已提交`);
                                      setAccountTokenVerifying((prev) => new Set([...prev, account.id]));
                                      setAccountTokenTaskMap((prev) => {
                                        const next = new Map(prev);
                                        next.set(account.id, { taskId: result.taskId, status: "PENDING" });
                                        return next;
                                      });
                                      const pollInterval = setInterval(async () => {
                                        try {
                                          const taskStatus = await apiRequest<TaskStatus>(`automation/status/${result.taskId}`);
                                          setAccountTokenTaskMap((prev) => {
                                            const next = new Map(prev);
                                            const errMsg = taskStatus.status === "FAILED_FINAL"
                                              ? (taskStatus.lastErrorMessage || taskStatus.logs?.[taskStatus.logs.length - 1]?.message || "验证失败")
                                              : undefined;
                                            next.set(account.id, { taskId: result.taskId, status: taskStatus.status, errorMessage: errMsg });
                                            return next;
                                          });
                                          if (taskStatus.status === "SUCCESS" || taskStatus.status === "FAILED_FINAL") {
                                            clearInterval(pollInterval);
                                            accountTokenPollingRef.current.delete(account.id);
                                            setAccountTokenVerifying((prev) => {
                                              const next = new Set(prev);
                                              next.delete(account.id);
                                              return next;
                                            });
                                            if (taskStatus.status === "SUCCESS") {
                                              try {
                                                await apiRequest(`automation/account-token/extract/${result.taskId}`, { method: "POST" });
                                                showToast("success", `${account.loginEmail} Token 提取成功`);
                                                loadAccountTokens();
                                              } catch (err) {
                                                showToast("error", `Token 提取失败: ${getErrorMessage(err)}`);
                                              }
                                            }
                                          }
                                        } catch { /* ignore */ }
                                      }, 3000);
                                      accountTokenPollingRef.current.set(account.id, pollInterval);
                                    } catch (err) {
                                      showToast("error", `提交失败: ${getErrorMessage(err)}`);
                                    }
                                  }}
                                  type="button"
                                >
                                  📱 验证
                                </Button>
                              )}
                              {/* Delete Token */}
                              {account.refreshToken && (
                                <ConfirmButton
                                  className="button"
                                  style={{ fontSize: 11, padding: "2px 8px", color: "var(--red)" }}
                                  confirmLabel="确定删除？"
                                  onConfirm={async () => {
                                    setAccountTokenDeleting((prev) => new Set(prev).add(account.id));
                                    try {
                                      await apiRequest(`automation/account-token/${account.id}`, { method: "DELETE" });
                                      showToast("success", `已删除 ${account.loginEmail} 的 Token`);
                                      loadAccountTokens();
                                    } catch (err) {
                                      showToast("error", getErrorMessage(err));
                                    } finally {
                                      setAccountTokenDeleting((prev) => { const n = new Set(prev); n.delete(account.id); return n; });
                                    }
                                  }}
                                >
                                  {isTokenDeleting ? <Spinner size={10} color="currentColor" /> : "🗑️ 删除"}
                                </ConfirmButton>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {accountTokenTotalPages > 1 && (
                <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 8, marginTop: 16, fontSize: 13 }}>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={accountTokenPage <= 1}
                    onClick={() => setAccountTokenPage((p) => Math.max(1, p - 1))}
                    type="button"
                  >
                    ← 上一页
                  </Button>
                  <span className="muted">
                    {accountTokenPage} / {accountTokenTotalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={accountTokenPage >= accountTokenTotalPages}
                    onClick={() => setAccountTokenPage((p) => Math.min(accountTokenTotalPages, p + 1))}
                    type="button"
                  >
                    下一页 →
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ─── Phone Pool Tab ─── */}
      {activeTab === "phone-pool" && (
        <div className="agent-workspace">
          <div className="agent-toolbar">
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className="agent-phone-badge success">✅ {availablePhones} 可用</span>
              {disabledPhones > 0 && <span className="agent-phone-badge danger">❌ {disabledPhones} 不可用</span>}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Button variant="outline" onClick={() => loadPhones()} type="button">
                {phoneLoading ? <Spinner size={14} color="currentColor" /> : "刷新"}
              </Button>
              <Button onClick={() => setShowImport(!showImport)} type="button">
                批量导入
              </Button>
            </div>
          </div>

          {showImport && (
            <div className="agent-import-box">
              <p className="muted" style={{ marginBottom: 8 }}>
                每行一个，格式：<code>手机号|SMS验证码URL</code>
                <br />
                示例：<code>12345678901|https://sms222.us/?token=abc123</code>
              </p>
              <Textarea
                className="field-input"
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={"12345678901|https://sms222.us/?token=xxx\n12345678902|https://sms222.us/?token=yyy"}
                style={{ minHeight: 100, fontFamily: "var(--mono)", fontSize: 12, resize: "vertical" }}
              />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
                <Button variant="outline" onClick={() => setShowImport(false)} type="button">取消</Button>
                <Button onClick={handleImportPhones} disabled={!importText.trim()} type="button">导入</Button>
              </div>
            </div>
          )}

          {phones.length === 0 ? (
            <div style={{ textAlign: "center", padding: 48, opacity: 0.5 }}>
              <p style={{ fontSize: 32, marginBottom: 8 }}>☎️</p>
              <p>暂无手机号</p>
              <p style={{ fontSize: 12 }}>点击「批量导入」添加手机号</p>
            </div>
          ) : (
            <div style={{ overflow: "auto" }}>
              <table className="data-table" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th>手机号</th>
                    <th>国家码</th>
                    <th>SMS URL</th>
                    <th>使用次数</th>
                    <th>失败次数</th>
                    <th>最后验证码</th>
                    <th>状态</th>
                    <th style={{ width: 120 }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {phones.map((phone) => (
                    <tr key={phone.id}>
                      <td><code style={{ fontSize: 12 }}>{phone.phoneNumber}</code></td>
                      <td>{phone.countryCode}</td>
                      <td>
                        <span style={{ fontSize: 11, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block" }} title={phone.smsUrl}>
                          {phone.smsUrl}
                        </span>
                      </td>
                      <td>{phone.usedCount}</td>
                      <td>{phone.failureCount ?? 0}/2</td>
                      <td><code style={{ fontSize: 11 }}>{phone.lastCode ?? "-"}</code></td>
                      <td>
                        <StatusBadge
                          value={phone.status === "available" ? "可用" : phone.status === "used" ? "已使用" : "不可用"}
                          tone={phone.status === "available" ? "emerald" : phone.status === "used" ? "amber" : "crimson"}
                        />
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 4 }}>
                          <Button
                            variant="outline"
                            size="sm"
                            style={{ fontSize: 11, padding: "2px 8px", ...(phone.status === "used" ? { opacity: 0.5 } : {}) }}
                            onClick={() => handleTogglePhone(phone.id)}
                            disabled={phone.status === "used"}
                            title={phone.status === "used" ? "已使用的号码不能重新启用" : undefined}
                            type="button"
                          >
                            {phone.status === "available" ? "禁用" : phone.status === "used" ? "已使用" : "启用"}
                          </Button>
                          <ConfirmButton
                            className="button"
                            style={{ fontSize: 11, padding: "2px 8px", color: "var(--red)" }}
                            confirmLabel="确定删除？"
                            onConfirm={() => handleDeletePhone(phone.id)}
                          >
                            删除
                          </ConfirmButton>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
