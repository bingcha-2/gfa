"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  RefreshCw,
  Search,
  ShieldOff,
  Lock,
  Unlock,
  Plus,
  X,
  Save,
  Trash2,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
} from "lucide-react";

// ── Types ──

type Credits = {
  known?: boolean;
  available?: boolean;
  creditAmount?: number;
  minCreditAmount?: number;
  creditsRefreshedAt?: string;
};

type BlockedModel = {
  modelKey: string;
  reason: string;
  blockedUntil: number;
  accountId?: number;
};

type RequestStats = {
  total: number;
  successes: number;
  failures: number;
};

type QuotaAccount = {
  id: number | string;
  email?: string;
  enabled?: boolean;
  planType?: string;
  projectId?: string;
  quotaStatus?: string;
  quotaStatusReason?: string;
  blockedUntil?: number;
  credits?: Credits;
  requestStats?: RequestStats;
  successRate?: number | null;
  lastConversationOkAt?: string;
  lastStatus?: string;
  activeLeases?: number;
  blockedModels?: BlockedModel[];
  modelQuotaFractions?: Record<string, number>;
  modelQuotaResetTimes?: Record<string, string>;
  modelQuotaRefreshedAt?: number;
};

type DailyStats = {
  date?: string;
  leases?: number;
  successes?: number;
  errors?: number;
  tokensUsed?: number;
};

type AccountStats = {
  totalLeases?: number;
  successCount?: number;
  errorCount?: number;
  totalTokensUsed?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  locationFailures?: number;
  lastStatus?: string;
  blockedUntil?: number;
  recentResults?: Array<{ ok?: boolean }>;
};

type ModelGate = {
  modelKey: string;
  accountId: number;
  reason: string;
  blockedUntil: number;
};

type EnterpriseProbeGroup = {
  weight: number;
  rate: number | null;
  emergency: boolean;
  successes: number;
  failures: number;
  cycleMinutesLeft: number;
};

type Scheduler = {
  activeLeaseCounts?: Record<string, number>;
  accountStats?: Record<string, AccountStats>;
  modelGates?: ModelGate[];
  affinityClients?: number;
};

type StatusData = {
  running?: boolean;
  port?: number;
  activeLeases?: number;
  totalLeases?: number;
  totalReports?: number;
  affinityClients?: number;
  daily?: DailyStats;
  quota?: { accounts?: QuotaAccount[] };
  scheduler?: Scheduler;
  enterpriseProbe?: Record<string, EnterpriseProbeGroup>;
};

type ThrottleEmergency = {
  enabled: boolean;
  maxAttempts: number;
  baseDelayMs: number;
  message: string;
};

type ThrottleGlobal = {
  maxAttempts?: number;
  baseDelayMs?: number;
  capacityWaitMs?: number;
  backoffMultiplier?: number;
};

type ThrottleModelOverride = {
  baseDelayMs?: number;
  capacityWaitMs?: number;
  maxAttempts?: number;
  backoffMultiplier?: number;
};

type ThrottleEscalationThreshold = {
  rate503: number;
  addDelayMs: number;
};

type ThrottleConfig = {
  emergency?: ThrottleEmergency;
  global?: ThrottleGlobal;
  models?: Record<string, ThrottleModelOverride>;
  autoEscalation?: {
    enabled: boolean;
    thresholds: ThrottleEscalationThreshold[];
  };
};

type ModelRow = {
  id: string;
  name: string;
  baseDelayMs: string;
  capacityWaitMs: string;
  maxAttempts: string;
  backoffMultiplier: string;
};

type EscalationRow = {
  id: string;
  rate503: string;
  addDelayMs: string;
};

// ── Helpers ──

function formatMs(ms: number | undefined | null): string {
  const n = Number(ms || 0);
  if (!n) return "-";
  if (n < 60000) return `${Math.round(n / 1000)} 秒`;
  const mins = Math.round(n / 60000);
  if (mins < 60) return `${mins} 分钟`;
  const hrs = Math.round((mins / 60) * 10) / 10;
  return `${hrs} 小时`;
}

function formatTokenCount(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}



function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(iso);
  }
}

function successRateColor(rate: number | null | undefined): string {
  if (rate == null) return "text-muted-foreground";
  if (rate >= 70) return "text-green-500";
  if (rate >= 50) return "text-yellow-500";
  return "text-red-500";
}

function pressureColor(pct: number): string {
  if (pct > 60) return "bg-red-500";
  if (pct > 30) return "bg-yellow-500";
  return "bg-green-500";
}

const PAGE_SIZE = 20;

const REASON_LABELS: Record<string, string> = {
  quota: "额度",
  location_unsupported: "地区",
  location_permanent_ban: "地区永封",
  token_refresh_failed: "Token失效",
  phone_verification_required: "手机验证",
  auth_forbidden: "认证拒",
  capacity: "容量",
  unknown: "未知",
};

let nextId = 0;
function uid() {
  return String(++nextId);
}

// ── Canonical model mapping (aligned with cockpit-tools) ──

interface CanonicalModel {
  id: string;
  displayName: string;
  aliases: string[];
}

const CANONICAL_MODELS: CanonicalModel[] = [
  {
    id: "gemini-3.1-pro-high",
    displayName: "Gemini 3.1 Pro (High)",
    aliases: ["gemini-3-pro-high", "MODEL_PLACEHOLDER_M37", "MODEL_PLACEHOLDER_M8"],
  },
  {
    id: "gemini-3.1-pro-low",
    displayName: "Gemini 3.1 Pro (Low)",
    aliases: ["gemini-3-pro-low", "MODEL_PLACEHOLDER_M36", "MODEL_PLACEHOLDER_M7"],
  },
  {
    id: "gemini-3-flash",
    displayName: "Gemini 3 Flash",
    aliases: ["MODEL_PLACEHOLDER_M18"],
  },
  {
    id: "gemini-3.5-flash-low",
    displayName: "Gemini 3.5 Flash (Low)",
    aliases: [],
  },
  {
    id: "gemini-3.5-flash-extra-low",
    displayName: "Gemini 3.5 Flash (Extra Low)",
    aliases: [],
  },
  {
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    aliases: ["claude-sonnet-4-6-thinking", "claude-sonnet-4-5", "claude-sonnet-4-5-thinking", "MODEL_PLACEHOLDER_M35"],
  },
  {
    id: "claude-opus-4-6-thinking",
    displayName: "Claude Opus 4.6",
    aliases: ["claude-opus-4-6", "claude-opus-4-5-thinking", "MODEL_PLACEHOLDER_M26", "MODEL_PLACEHOLDER_M12"],
  },
];

const _normalizeKey = (v: string) => (v || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

const CANONICAL_ALIAS_MAP = (() => {
  const map = new Map<string, CanonicalModel>();
  for (const item of CANONICAL_MODELS) {
    for (const v of [item.id, item.displayName, ...item.aliases]) {
      const key = _normalizeKey(v);
      if (key && !map.has(key)) map.set(key, item);
    }
  }
  return map;
})();

function resolveCanonicalModel(name: string): CanonicalModel | undefined {
  const key = _normalizeKey(name);
  return key ? CANONICAL_ALIAS_MAP.get(key) : undefined;
}

type QuotaDisplayItem = {
  key: string;
  label: string;
  percentage: number;
  resetTime: string;
};

function getQuotaDisplayItem(
  modelId: string,
  fractions: Record<string, number>,
  resetTimes?: Record<string, string>,
): QuotaDisplayItem | null {
  for (const [modelKey, fraction] of Object.entries(fractions)) {
    const canonical = resolveCanonicalModel(modelKey);
    if (!canonical || canonical.id !== modelId) continue;
    return {
      key: modelKey,
      label: canonical.displayName,
      percentage: Math.round(Math.min(1, Math.max(0, fraction)) * 100),
      resetTime: resetTimes?.[modelKey] || "",
    };
  }
  return null;
}

function quotaBarColor(pct: number): string {
  if (pct > 60) return "bg-emerald-500";
  if (pct > 25) return "bg-amber-500";
  return "bg-red-500";
}

function quotaTextColor(pct: number): string {
  if (pct > 60) return "text-emerald-500";
  if (pct > 25) return "text-amber-500";
  return "text-red-500";
}

function formatResetTime(rt: string): string {
  if (!rt) return "";
  try {
    const d = new Date(rt);
    const diff = d.getTime() - Date.now();
    if (diff <= 0) return "已重置";
    const dayMs = 24 * 3600000;
    if (diff >= dayMs) {
      const days = Math.floor(diff / dayMs);
      const hours = Math.floor((diff % dayMs) / 3600000);
      return hours > 0 ? `${days}天 ${hours}小时` : `${days}天`;
    }
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  } catch { return ""; }
}

function formatQuotaRefreshedAt(ts: number | undefined | null): string {
  const n = Number(ts || 0);
  if (!n) return "";
  try {
    return new Date(n).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function ModelQuotaCell({
  item,
  refreshedAt,
}: {
  item: QuotaDisplayItem | null;
  refreshedAt?: number;
}) {
  if (!item) {
    return <span className="text-xs text-muted-foreground">暂无</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger className="flex min-w-[140px] flex-col gap-1 text-left">
        <div className="flex items-center justify-between gap-2">
          <span className={cn("text-xs font-semibold tabular-nums", quotaTextColor(item.percentage))}>
            {item.percentage}%
          </span>
          <span className="text-[10px] text-muted-foreground">
            {item.resetTime ? formatResetTime(item.resetTime) : "未记录重置"}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500",
              quotaBarColor(item.percentage),
            )}
            style={{ width: `${item.percentage}%` }}
          />
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {item.label}
        <br />
        重置: {item.resetTime ? formatResetTime(item.resetTime) : "未记录"}
        <br />
        更新: {formatQuotaRefreshedAt(refreshedAt) || "未刷新"}
      </TooltipContent>
    </Tooltip>
  );
}

// ── Column configuration ──

const COLUMN_CONFIG: { key: string; label: string }[] = [
  { key: "account", label: "账号" },
  { key: "plan", label: "套餐" },
  { key: "credits", label: "AI积分" },
  { key: "modelQuota", label: "模型额度" },
  { key: "quotaStatus", label: "额度状态" },
  { key: "reason", label: "封禁原因" },
  { key: "cooldown", label: "冷却/剩余" },
  { key: "blockedModels", label: "阻断模型" },
  { key: "lease", label: "Lease" },
  { key: "totalTokens", label: "累计Token" },
  { key: "successRate", label: "成功率" },
  { key: "reqFail", label: "请求/失败" },
  { key: "locationFail", label: "地区失败" },
  { key: "lastConversation", label: "最近对话" },
  { key: "lastCode", label: "最近码" },
];

const DEFAULT_VISIBLE_COLS = new Set<string>([
  "account",
  "plan",
  "modelQuota",
  "quotaStatus",
  "reason",
  "lease",
  "successRate",
]);

const MODEL_QUOTA_OPTIONS = CANONICAL_MODELS.filter((model) =>
  model.id.startsWith("gemini-3") || model.id.startsWith("claude-"),
);

const DEFAULT_VISIBLE_MODEL_QUOTAS = new Set<string>(
  MODEL_QUOTA_OPTIONS.map((model) => model.id),
);

const COLUMN_KEYS = new Set(COLUMN_CONFIG.map((col) => col.key));

function migrateVisibleColumns(values: string[]): Set<string> {
  const next = new Set(values.filter((key) => COLUMN_KEYS.has(key)));
  next.add("modelQuota");
  next.delete("blockedModels");
  return next.size > 0 ? next : new Set(DEFAULT_VISIBLE_COLS);
}

// ── Component ──

export default function RosettaLoadPage() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [visibleCols, setVisibleCols] = useState<Set<string>>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("rosetta-load-visible-cols");
        if (saved) {
          const arr = JSON.parse(saved) as string[];
          if (Array.isArray(arr) && arr.length > 0) return migrateVisibleColumns(arr);
        }
      } catch { /* ignore */ }
    }
    return new Set(DEFAULT_VISIBLE_COLS);
  });
  const [visibleModelQuotaIds, setVisibleModelQuotaIds] = useState<Set<string>>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("rosetta-load-visible-model-quotas");
        if (saved) {
          const arr = JSON.parse(saved) as string[];
          const allowed = new Set(MODEL_QUOTA_OPTIONS.map((model) => model.id));
          const filtered = arr.filter((id) => allowed.has(id));
          if (filtered.length > 0) return new Set(filtered);
        }
      } catch { /* ignore */ }
    }
    return new Set(DEFAULT_VISIBLE_MODEL_QUOTAS);
  });
  useEffect(() => {
    try {
      localStorage.setItem("rosetta-load-visible-cols", JSON.stringify([...visibleCols]));
    } catch { /* ignore */ }
  }, [visibleCols]);
  useEffect(() => {
    try {
      localStorage.setItem("rosetta-load-visible-model-quotas", JSON.stringify([...visibleModelQuotaIds]));
    } catch { /* ignore */ }
  }, [visibleModelQuotaIds]);

  const [refreshingQuota, setRefreshingQuota] = useState(false);
  const [refreshingStatus, setRefreshingStatus] = useState(false);
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());

  // Throttle config state
  const [throttleLoaded, setThrottleLoaded] = useState(false);
  const [throttlePath, setThrottlePath] = useState("");
  const [hasThrottleConfig, setHasThrottleConfig] = useState(false);
  const [emergencyEnabled, setEmergencyEnabled] = useState(false);
  const [emergencyMaxAttempts, setEmergencyMaxAttempts] = useState("3");
  const [emergencyBaseDelay, setEmergencyBaseDelay] = useState("5000");
  const [emergencyMessage, setEmergencyMessage] = useState("");
  const [globalMaxAttempts, setGlobalMaxAttempts] = useState("");
  const [globalBaseDelay, setGlobalBaseDelay] = useState("");
  const [globalCapacityWait, setGlobalCapacityWait] = useState("");
  const [globalBackoff, setGlobalBackoff] = useState("");
  const [modelRows, setModelRows] = useState<ModelRow[]>([]);
  const [escalationEnabled, setEscalationEnabled] = useState(true);
  const [escalationRows, setEscalationRows] = useState<EscalationRow[]>([
    { id: uid(), rate503: "0.3", addDelayMs: "500" },
    { id: uid(), rate503: "0.5", addDelayMs: "1500" },
    { id: uid(), rate503: "0.8", addDelayMs: "3000" },
  ]);
  const [savingThrottle, setSavingThrottle] = useState(false);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Data fetching ──

  const fetchStatus = useCallback(async (silent = false) => {
    if (!silent) setRefreshingStatus(true);
    try {
      const res = await fetch("/api/remote-token/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: StatusData = await res.json();
      setStatus(data);
    } catch (err) {
      if (!silent) toast.error(`获取状态失败: ${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      if (!silent) setRefreshingStatus(false);
    }
  }, []);

  const fetchThrottleConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/rosetta/throttle-config");
      if (!res.ok) return;
      const data = await res.json();
      setThrottleLoaded(true);
      setThrottlePath(data.path || "");
      populateThrottleState(data.config);
    } catch {
      // non-critical
    }
  }, []);

  function populateThrottleState(config: ThrottleConfig | null | undefined) {
    const c = config || ({} as ThrottleConfig);
    setHasThrottleConfig(!!config);
    setEmergencyEnabled(!!c.emergency?.enabled);
    setEmergencyMaxAttempts(String(c.emergency?.maxAttempts || 3));
    setEmergencyBaseDelay(String(c.emergency?.baseDelayMs || 5000));
    setEmergencyMessage(c.emergency?.message || "");
    setGlobalMaxAttempts(c.global?.maxAttempts != null ? String(c.global.maxAttempts) : "");
    setGlobalBaseDelay(c.global?.baseDelayMs != null ? String(c.global.baseDelayMs) : "");
    setGlobalCapacityWait(c.global?.capacityWaitMs != null ? String(c.global.capacityWaitMs) : "");
    setGlobalBackoff(c.global?.backoffMultiplier != null ? String(c.global.backoffMultiplier) : "");
    if (c.models) {
      setModelRows(
        Object.entries(c.models).map(([name, cfg]) => ({
          id: uid(),
          name,
          baseDelayMs: cfg.baseDelayMs != null ? String(cfg.baseDelayMs) : "",
          capacityWaitMs: cfg.capacityWaitMs != null ? String(cfg.capacityWaitMs) : "",
          maxAttempts: cfg.maxAttempts != null ? String(cfg.maxAttempts) : "",
          backoffMultiplier: cfg.backoffMultiplier != null ? String(cfg.backoffMultiplier) : "",
        }))
      );
    } else {
      setModelRows([]);
    }
    setEscalationEnabled(c.autoEscalation?.enabled !== false);
    const thresholds = c.autoEscalation?.thresholds || [
      { rate503: 0.3, addDelayMs: 500 },
      { rate503: 0.5, addDelayMs: 1500 },
      { rate503: 0.8, addDelayMs: 3000 },
    ];
    setEscalationRows(
      thresholds.map((t) => ({
        id: uid(),
        rate503: String(t.rate503),
        addDelayMs: String(t.addDelayMs),
      }))
    );
  }

  useEffect(() => {
    async function init() {
      setLoading(true);
      await Promise.all([fetchStatus(true), fetchThrottleConfig()]);
      setLoading(false);
    }
    init();
    intervalRef.current = setInterval(() => fetchStatus(true), 30_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchStatus, fetchThrottleConfig]);

  // ── Actions ──


  async function handleRefreshQuota() {
    setRefreshingQuota(true);
    try {
      const res = await fetch("/api/rosetta/refresh-quota", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      toast.success(
        `额度刷新完成: ${data.refreshed || 0} 成功, ${data.errors || 0} 失败 (共 ${data.total || 0})`
      );
      await fetchStatus(true);
    } catch (err) {
      toast.error(`额度刷新失败: ${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setRefreshingQuota(false);
    }
  }

  async function handleUnblockLocation() {
    try {
      const res = await fetch("/api/rosetta/unblock-location", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        toast.success(`已解封 ${data.unblocked || 0} 个账号`);
        await fetchStatus(true);
      } else {
        toast.error("解封失败: " + (data.error || "未知错误"));
      }
    } catch (err) {
      toast.error(`请求失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
  }

  async function handleToggleAccount(accountId: string, currentlyEnabled: boolean) {
    setTogglingIds((prev) => new Set(prev).add(accountId));
    const action = currentlyEnabled ? "禁用" : "解封";
    try {
      const res = await fetch("/api/rosetta/toggle-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: Number(accountId), enabled: !currentlyEnabled }),
      });
      const data = await res.json();
      if (data.ok) {
        toast.success(`账号 #${accountId} 已${action}`);
        await fetchStatus(true);
      } else {
        toast.error(`${action}失败: ${data.error || "未知错误"}`);
      }
    } catch (err) {
      toast.error(`${action}请求失败: ${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setTogglingIds((prev) => {
        const s = new Set(prev);
        s.delete(accountId);
        return s;
      });
    }
  }

  async function handleSaveThrottle() {
    setSavingThrottle(true);
    const config: ThrottleConfig = {};
    if (emergencyEnabled) {
      config.emergency = {
        enabled: true,
        maxAttempts: Number(emergencyMaxAttempts) || 3,
        baseDelayMs: Number(emergencyBaseDelay) || 5000,
        message: emergencyMessage,
      };
    }
    const global: ThrottleGlobal = {};
    if (globalMaxAttempts !== "") global.maxAttempts = Number(globalMaxAttempts);
    if (globalBaseDelay !== "") global.baseDelayMs = Number(globalBaseDelay);
    if (globalCapacityWait !== "") global.capacityWaitMs = Number(globalCapacityWait);
    if (globalBackoff !== "") global.backoffMultiplier = Number(globalBackoff);
    if (Object.keys(global).length) config.global = global;
    const models: Record<string, ThrottleModelOverride> = {};
    for (const row of modelRows) {
      if (!row.name.trim()) continue;
      const entry: ThrottleModelOverride = {};
      if (row.baseDelayMs !== "") entry.baseDelayMs = Number(row.baseDelayMs);
      if (row.capacityWaitMs !== "") entry.capacityWaitMs = Number(row.capacityWaitMs);
      if (row.maxAttempts !== "") entry.maxAttempts = Number(row.maxAttempts);
      if (row.backoffMultiplier !== "") entry.backoffMultiplier = Number(row.backoffMultiplier);
      if (Object.keys(entry).length) models[row.name.trim()] = entry;
    }
    if (Object.keys(models).length) config.models = models;
    const thresholds: ThrottleEscalationThreshold[] = escalationRows
      .filter((r) => r.rate503 !== "" && r.addDelayMs !== "")
      .map((r) => ({ rate503: Number(r.rate503), addDelayMs: Number(r.addDelayMs) }))
      .sort((a, b) => a.rate503 - b.rate503);
    if (thresholds.length || !escalationEnabled) {
      config.autoEscalation = { enabled: escalationEnabled, thresholds };
    }
    try {
      await fetch("/api/rosetta/throttle-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      toast.success("节流配置已保存，立即对新请求生效");
      await fetchThrottleConfig();
    } catch (err) {
      toast.error("保存失败: " + (err instanceof Error ? err.message : "未知错误"));
    } finally {
      setSavingThrottle(false);
    }
  }

  async function handleDeleteThrottle() {
    try {
      await fetch("/api/rosetta/throttle-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete: true }),
      });
      toast.success("已恢复自动模式");
      await fetchThrottleConfig();
    } catch (err) {
      toast.error("删除失败: " + (err instanceof Error ? err.message : "未知错误"));
    }
  }

  // ── Derived data ──

  const scheduler = status?.scheduler || {};
  const leaseCounts = scheduler.activeLeaseCounts || {};
  const accountStatsMap = scheduler.accountStats || {};
  const quotaAccounts = status?.quota?.accounts || [];
  const daily = status?.daily || {};

  const allAccounts = useMemo(() => {
    const now = Date.now();
    const gateMap = new Map<number, ModelGate[]>();
    if (scheduler.modelGates) {
      for (const g of scheduler.modelGates) {
        if (!gateMap.has(g.accountId)) gateMap.set(g.accountId, []);
        gateMap.get(g.accountId)!.push(g);
      }
    }

    return quotaAccounts.map((account) => {
      const id = String(account.id ?? "");
      const s = accountStatsMap[id] || {};
      const activeLeases = Number(leaseCounts[id] ?? account.activeLeases ?? 0);
      const reqStats = account.requestStats || { total: 0, successes: 0, failures: 0 };
      const total = Number(reqStats.total ?? s.totalLeases ?? 0);
      const successes = Number(reqStats.successes ?? s.successCount ?? 0);
      const failures = Number(reqStats.failures ?? s.errorCount ?? 0);
      const successRate =
        account.successRate != null
          ? Number(account.successRate)
          : total > 0
            ? Math.round((successes / total) * 100)
            : null;
      const blockedUntil = Number(account.blockedUntil ?? s.blockedUntil ?? 0);
      const cooldownMs = blockedUntil > now ? blockedUntil - now : 0;
      const allBlockedModels = [
        ...(account.blockedModels || []),
        ...(gateMap.get(Number(account.id)) || []),
      ].filter((m) => m.blockedUntil > now);
      const locationFailures = Number(s.locationFailures || 0);
      const totalTokensUsed = Number(s.totalTokensUsed || 0);
      const totalInputTokens = Number(s.totalInputTokens || 0);
      const totalOutputTokens = Number(s.totalOutputTokens || 0);

      return {
        ...account,
        _id: id,
        _activeLeases: activeLeases,
        _total: total,
        _successes: successes,
        _failures: failures,
        _successRate: successRate,
        _cooldownMs: cooldownMs,
        _blockedModels: allBlockedModels,
        _locationFailures: locationFailures,
        _totalTokensUsed: totalTokensUsed,
        _totalInputTokens: totalInputTokens,
        _totalOutputTokens: totalOutputTokens,
        _lastStatus: s.lastStatus || account.lastStatus || "",
      };
    });
  }, [quotaAccounts, accountStatsMap, leaseCounts, scheduler.modelGates]);

  const summaryReasons = useMemo(() => {
    const reasons: Record<string, number> = {};
    let okCount = 0;
    for (const a of allAccounts) {
      if (a.quotaStatus === "exhausted") {
        const r = a.quotaStatusReason || "unknown";
        reasons[r] = (reasons[r] || 0) + 1;
      } else {
        okCount++;
      }
    }
    return { okCount, reasons };
  }, [allAccounts]);

  const filteredAccounts = useMemo(() => {
    if (!search.trim()) return allAccounts;
    const q = search.trim().toLowerCase();
    return allAccounts.filter((a) => {
      const blockedModelStr = (a._blockedModels || [])
        .map((m) => `${m.modelKey} ${m.reason}`)
        .join(" ");
      const hay = [
        a.email,
        a.planType,
        a.quotaStatus,
        a.quotaStatusReason,
        String(a.id),
        blockedModelStr,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [allAccounts, search]);

  const totalPages = Math.max(1, Math.ceil(filteredAccounts.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageAccounts = filteredAccounts.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const modelPressure = useMemo(() => {
    const now = Date.now();
    const gates = (scheduler.modelGates || []).filter((g) => g.blockedUntil > now);
    const byModel: Record<string, number> = {};
    gates.forEach((g) => {
      byModel[g.modelKey] = (byModel[g.modelKey] || 0) + 1;
    });
    const totalEnabled = quotaAccounts.filter((a) => a.enabled !== false && a.projectId).length;
    return Object.entries(byModel)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([model, count]) => ({
        model: model.replace(/^(tab_|models\/)/, "").replace(/_preview$/, ""),
        count,
        total: totalEnabled,
        pct: totalEnabled > 0 ? Math.round((count / totalEnabled) * 100) : 0,
      }));
  }, [scheduler.modelGates, quotaAccounts]);

  const overviewStats = useMemo(() => {
    const activeLeases = Object.values(leaseCounts).reduce((s, v) => s + Number(v || 0), 0);
    const clients = Number(status?.affinityClients || 0);
    let totalSuccess = 0;
    let totalErr = 0;
    let totalAllTokens = 0;
    for (const s of Object.values(accountStatsMap)) {
      totalSuccess += Number(s.successCount || 0);
      totalErr += Number(s.errorCount || 0);
      totalAllTokens += Number(s.totalTokensUsed || 0);
    }
    const totalReqs = totalSuccess + totalErr;
    const successRate = totalReqs > 0 ? Math.round((totalSuccess / totalReqs) * 100) : 0;
    const dailyRate =
      (daily.leases || 0) > 0
        ? Math.round(((daily.successes || 0) / (daily.leases || 1)) * 100)
        : 0;
    return { activeLeases, clients, successRate, totalAllTokens, dailyRate };
  }, [leaseCounts, status?.affinityClients, accountStatsMap, daily]);

  const enterpriseProbe = status?.enterpriseProbe || {};
  const enterpriseGroups = Object.entries(enterpriseProbe);

  // ── Select / column helpers ──

  function toggleSelectAll(checked: boolean) {
    if (checked) {
      setSelectedIds(new Set(pageAccounts.map((a) => String(a.id))));
    } else {
      setSelectedIds(new Set());
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  }

  function toggleCol(key: string) {
    setVisibleCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleModelQuota(id: string) {
    setVisibleModelQuotaIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    setPage(1);
  }, [search]);

  const show = (key: string) => visibleCols.has(key);
  const visibleModelQuotaOptions = MODEL_QUOTA_OPTIONS.filter((model) =>
    visibleModelQuotaIds.has(model.id),
  );

  // ── Render ──

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-20 justify-center text-muted-foreground">
        <Spinner size={18} />
        <span className="text-sm">加载中...</span>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-4">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-semibold">账号负载</h1>
          <p className="text-sm text-muted-foreground">
            来自 Remote Token Server 调度器的 lease 与账号统计。
          </p>
        </div>

        {/* ── 1. Server Overview Panel ── */}
        {status?.running && (
          <div className="grid gap-3 md:grid-cols-2">
            {/* Left: 服务器概况 */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">服务器概况</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="text-2xl font-bold text-primary">
                      {overviewStats.activeLeases}
                    </div>
                    <div className="text-xs text-muted-foreground">活跃 Lease</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-primary">
                      {overviewStats.clients}
                    </div>
                    <div className="text-xs text-muted-foreground">绑定客户端</div>
                  </div>
                  <div>
                    <div
                      className={`text-2xl font-bold ${successRateColor(overviewStats.successRate)}`}
                    >
                      {overviewStats.successRate}%
                    </div>
                    <div className="text-xs text-muted-foreground">总成功率</div>
                  </div>
                </div>
                <Separator />
                <div>
                  <div className="text-xs font-semibold text-muted-foreground mb-2">
                    今日统计 ({daily.date || "-"})
                  </div>
                  <div className="grid grid-cols-5 gap-1 text-center text-xs">
                    <div>
                      <div className="font-semibold">{daily.leases || 0}</div>
                      <div className="text-muted-foreground">租号</div>
                    </div>
                    <div>
                      <div className="font-semibold text-green-500">{daily.successes || 0}</div>
                      <div className="text-muted-foreground">成功</div>
                    </div>
                    <div>
                      <div className="font-semibold text-red-500">{daily.errors || 0}</div>
                      <div className="text-muted-foreground">失败</div>
                    </div>
                    <div>
                      <div className="font-semibold">{overviewStats.dailyRate}%</div>
                      <div className="text-muted-foreground">成功率</div>
                    </div>
                    <div>
                      <div className="font-semibold">
                        {formatTokenCount(daily.tokensUsed || 0)}
                      </div>
                      <div className="text-muted-foreground">Token</div>
                    </div>
                  </div>
                </div>
                <div className="text-right text-[11px] text-muted-foreground">
                  累计 Token: {formatTokenCount(overviewStats.totalAllTokens)}
                </div>
              </CardContent>
            </Card>

            {/* Right: 模型压力 */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  模型压力{" "}
                  <span className="font-normal text-muted-foreground text-xs">
                    (cooling 中的账号数)
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {modelPressure.length === 0 ? (
                  <span className="text-xs text-muted-foreground">无阻断</span>
                ) : (
                  modelPressure.map((m) => (
                    <div key={m.model} className="flex items-center gap-2 text-xs">
                      <span className="min-w-[120px] text-muted-foreground truncate">
                        {m.model}
                      </span>
                      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${pressureColor(m.pct)}`}
                          style={{ width: `${m.pct}%` }}
                        />
                      </div>
                      <span className="min-w-[60px] text-right tabular-nums">
                        {m.count}/{m.total}{" "}
                        <span className="text-muted-foreground">({m.pct}%)</span>
                      </span>
                    </div>
                  ))
                )}

                {/* Enterprise probe */}
                {enterpriseGroups.length > 0 && (
                  <>
                    <Separator className="my-1" />
                    <div className="text-xs font-semibold text-muted-foreground mb-1">
                      企业号探测
                    </div>
                    {enterpriseGroups.map(([name, g]) => {
                      const wColor =
                        g.weight >= 6
                          ? "text-green-500"
                          : g.weight >= 3
                            ? "text-primary"
                            : g.weight >= 1.5
                              ? "text-yellow-500"
                              : "text-red-500";
                      const statusText = g.emergency
                        ? "⚠️ 紧急降权"
                        : g.rate !== null
                          ? `${g.rate}% 成功`
                          : "探测中…";
                      return (
                        <div key={name} className="flex items-center gap-2 text-xs">
                          <span className="min-w-[50px] font-semibold">{name}</span>
                          <span className={`${wColor} font-bold min-w-[60px]`}>
                            权重 {g.weight.toFixed(1)}
                          </span>
                          <span className="text-muted-foreground">{statusText}</span>
                          <span className="text-muted-foreground text-[10px]">
                            {g.successes}ok/{g.failures}fail
                          </span>
                          <span className="ml-auto text-muted-foreground text-[10px]">
                            {g.cycleMinutesLeft}min
                          </span>
                        </div>
                      );
                    })}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* ── 2. Action Bar ── */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Left: search + count */}
          <div className="relative flex-1 min-w-[200px] max-w-[320px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              placeholder="搜索账号 / 状态 / 原因…"
              value={search}
              onChange={(e) => setSearch((e.target as HTMLInputElement).value)}
              className="pl-8 h-8 text-sm"
            />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {search.trim()
              ? `${filteredAccounts.length} / ${allAccounts.length}`
              : `${allAccounts.length} 条`}
          </span>

          {/* Middle: column settings */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" size="sm">
                  <SlidersHorizontal data-icon className="size-3.5" />
                  列设置
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>显示列</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {COLUMN_CONFIG.map((col) => (
                  <DropdownMenuCheckboxItem
                    key={col.key}
                    checked={visibleCols.has(col.key)}
                    onCheckedChange={() => toggleCol(col.key)}
                  >
                    {col.label}
                  </DropdownMenuCheckboxItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>模型额度</DropdownMenuLabel>
                {MODEL_QUOTA_OPTIONS.map((model) => (
                  <DropdownMenuCheckboxItem
                    key={model.id}
                    checked={visibleModelQuotaIds.has(model.id)}
                    onCheckedChange={() => toggleModelQuota(model.id)}
                    disabled={!visibleCols.has("modelQuota")}
                  >
                    {model.displayName}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Right: action buttons */}
          <div className="flex items-center gap-1.5 ml-auto">
            {/* Maintenance group */}
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefreshQuota}
              disabled={refreshingQuota}
            >
              {refreshingQuota ? (
                <Spinner size={14} className="mr-1" />
              ) : (
                <RefreshCw data-icon className="size-3.5" />
              )}
              刷新额度
            </Button>
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button variant="outline" size="sm">
                    <ShieldOff data-icon className="size-3.5" />
                    解封地区
                  </Button>
                }
              />
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确认解封地区</AlertDialogTitle>
                  <AlertDialogDescription>
                    确定解封所有 location_unsupported 封禁的账号？
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={handleUnblockLocation}>确认解封</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <Separator orientation="vertical" className="mx-1 h-6" />

            {/* Status group */}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="px-2"
                    onClick={() => fetchStatus()}
                    disabled={refreshingStatus}
                  />
                }
              >
                {refreshingStatus ? (
                  <Spinner size={14} />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
              </TooltipTrigger>
              <TooltipContent>刷新状态</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* ── 3. Summary Bar ── */}
        {allAccounts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary" className="tabular-nums">
              <span className="font-bold text-primary">{summaryReasons.okCount}</span>
              &nbsp;正常
            </Badge>
            {Object.entries(summaryReasons.reasons)
              .sort((a, b) => b[1] - a[1])
              .map(([r, count]) => (
                <Badge key={r} variant="secondary" className="tabular-nums">
                  <span className="font-bold text-red-400">{count}</span>
                  &nbsp;{REASON_LABELS[r] || r}
                </Badge>
              ))}
          </div>
        )}

        {/* ── 4. Accounts ── */}
        {filteredAccounts.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              {search.trim() ? "没有匹配的负载数据" : "暂无账号负载数据"}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-8">
                          <Checkbox
                            checked={
                              pageAccounts.length > 0 &&
                              pageAccounts.every((a) => selectedIds.has(String(a.id)))
                            }
                            onCheckedChange={(checked) => toggleSelectAll(!!checked)}
                          />
                        </TableHead>
                        {show("account") && <TableHead>账号</TableHead>}
                        {show("plan") && <TableHead>套餐</TableHead>}
                        {show("credits") && <TableHead>AI积分</TableHead>}
                        {show("modelQuota") &&
                          visibleModelQuotaOptions.map((model) => (
                            <TableHead key={model.id}>{model.displayName}</TableHead>
                          ))}
                        {show("quotaStatus") && <TableHead>额度状态</TableHead>}
                        {show("reason") && <TableHead>封禁原因</TableHead>}
                        {show("cooldown") && <TableHead>冷却/剩余</TableHead>}
                        {show("blockedModels") && <TableHead>阻断模型</TableHead>}
                        {show("lease") && <TableHead>Lease</TableHead>}
                        {show("totalTokens") && <TableHead>累计Token</TableHead>}
                        {show("successRate") && <TableHead>成功率</TableHead>}
                        {show("reqFail") && <TableHead>请求/失败</TableHead>}
                        {show("locationFail") && <TableHead>地区失败</TableHead>}
                        {show("lastConversation") && <TableHead>最近对话</TableHead>}
                        {show("lastCode") && <TableHead>最近码</TableHead>}
                        <TableHead>操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pageAccounts.map((account) => {
                        const id = String(account.id);
                        const isDisabled = account.enabled === false;
                        const reason = account.quotaStatusReason || "";
                        const reasonLabel = ({
                          quota: "额度耗尽",
                          capacity: "容量限制",
                          location_unsupported: "地区不支持",
                          location_permanent_ban: "地区永封",
                          token_refresh_failed: "Token失效",
                          phone_verification_required: "手机验证",
                          auth_forbidden: "认证被拒",
                          auth_failed: "认证失败",
                          verification_required: "需验证",
                          quota_cooling: "冷却中",
                        } as Record<string, string>)[reason] || reason || "-";
                        const reasonDot =
                          reason.includes("permanent") || reason.includes("token_refresh")
                            ? "bg-red-500"
                            : reason
                              ? "bg-yellow-500"
                              : "bg-green-500";
                        const quotaStatus = String(account.quotaStatus || "").toLowerCase();
                        const quotaDotClass =
                          isDisabled || quotaStatus === "error"
                            ? "bg-red-500"
                            : quotaStatus === "exhausted" || quotaStatus === "cooling"
                              ? "bg-yellow-500"
                              : "bg-green-500";
                        const credits = account.credits || ({} as Credits);
                        const creditsDotClass = credits.available ? "bg-green-500" : "bg-red-500";
                        const modelQuotaFractions = account.modelQuotaFractions || {};

                        return (
                          <TableRow
                            key={id}
                            className={isDisabled ? "opacity-50" : undefined}
                          >
                            <TableCell>
                              <Checkbox
                                checked={selectedIds.has(id)}
                                onCheckedChange={() => toggleSelect(id)}
                              />
                            </TableCell>
                            {show("account") && (
                              <TableCell className="font-mono text-xs whitespace-nowrap">
                                <span className="text-muted-foreground">#{id}</span>
                                <br />
                                {account.email || ""}
                              </TableCell>
                            )}
                            {show("plan") && (
                              <TableCell className="text-xs">{account.planType || "-"}</TableCell>
                            )}
                            {show("credits") && (
                              <TableCell className="text-xs">
                                {credits.known ? (
                                  <Tooltip>
                                    <TooltipTrigger className="inline-flex items-center gap-1">
                                      <span
                                        className={`inline-block size-1.5 rounded-full ${creditsDotClass}`}
                                      />
                                      <span className={credits.available ? "" : "text-red-500"}>
                                        {Number(credits.creditAmount || 0).toLocaleString(
                                          undefined,
                                          { maximumFractionDigits: 0 },
                                        )}
                                        <span className="text-muted-foreground">/{credits.minCreditAmount || 0}</span>
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      余额: {credits.creditAmount} / 最低:{" "}
                                      {credits.minCreditAmount || 0}
                                      {!credits.available && <><br />低于最低使用门槛</>}
                                      <br />
                                      刷新:{" "}
                                      {credits.creditsRefreshedAt
                                        ? new Date(credits.creditsRefreshedAt).toLocaleString()
                                        : "未刷新"}
                                    </TooltipContent>
                                  </Tooltip>
                                ) : (
                                  <Tooltip>
                                    <TooltipTrigger className="inline-flex items-center gap-1 text-muted-foreground">
                                      <span className="inline-block size-1.5 rounded-full bg-muted-foreground/40" />
                                      未知
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      Google 未返回 AI 积分数据
                                      <br />
                                      刷新:{" "}
                                      {credits.creditsRefreshedAt
                                        ? new Date(credits.creditsRefreshedAt).toLocaleString()
                                        : "未刷新"}
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </TableCell>
                            )}
                            {show("modelQuota") &&
                              visibleModelQuotaOptions.map((model) => (
                                <TableCell key={model.id}>
                                  <ModelQuotaCell
                                    item={getQuotaDisplayItem(
                                      model.id,
                                      modelQuotaFractions,
                                      account.modelQuotaResetTimes,
                                    )}
                                    refreshedAt={account.modelQuotaRefreshedAt}
                                  />
                                </TableCell>
                              ))}
                            {show("quotaStatus") && (
                              <TableCell className="text-xs">
                                <span className="inline-flex items-center gap-1">
                                  <span
                                    className={`inline-block size-1.5 rounded-full ${quotaDotClass}`}
                                  />
                                  {account.quotaStatus || "unknown"}
                                </span>
                              </TableCell>
                            )}
                            {show("reason") && (
                              <TableCell className="text-xs">
                                <span className="inline-flex items-center gap-1">
                                  <span
                                    className={`inline-block size-1.5 rounded-full ${reasonDot}`}
                                  />
                                  {reasonLabel}
                                </span>
                              </TableCell>
                            )}
                            {show("cooldown") && (
                              <TableCell className="text-xs tabular-nums">
                                {formatMs(account._cooldownMs || 0)}
                              </TableCell>
                            )}
                            {show("blockedModels") && (
                              <TableCell className="text-xs max-w-[180px]">
                                {account._blockedModels.length > 0 ? (
                                  <div className="flex flex-col gap-0.5">
                                    {account._blockedModels.slice(0, 3).map((m, i) => {
                                      const short = (m.modelKey || "")
                                        .replace(/^(tab_|models\/)/, "")
                                        .slice(0, 18);
                                      const remaining = Math.max(0, m.blockedUntil - Date.now());
                                      return (
                                        <Tooltip key={i}>
                                          <TooltipTrigger className="text-left">
                                            <code className="text-[11px]">{short}</code>{" "}
                                            <span className="text-muted-foreground text-[10px]">
                                              {formatMs(remaining)}
                                            </span>
                                          </TooltipTrigger>
                                          <TooltipContent>
                                            {m.modelKey} ({m.reason})
                                          </TooltipContent>
                                        </Tooltip>
                                      );
                                    })}
                                    {account._blockedModels.length > 3 && (
                                      <span className="text-[10px] text-muted-foreground">
                                        +{account._blockedModels.length - 3} more
                                      </span>
                                    )}
                                  </div>
                                ) : (
                                  "-"
                                )}
                              </TableCell>
                            )}
                            {show("lease") && (
                              <TableCell className="text-xs tabular-nums">
                                {account._activeLeases}
                              </TableCell>
                            )}
                            {show("totalTokens") && (
                              <TableCell className="text-xs tabular-nums">
                                {account._totalTokensUsed > 0 ? (
                                  <Tooltip>
                                    <TooltipTrigger>
                                      {formatTokenCount(account._totalTokensUsed)}
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      输入: {account._totalInputTokens.toLocaleString()} / 输出:{" "}
                                      {account._totalOutputTokens.toLocaleString()}
                                    </TooltipContent>
                                  </Tooltip>
                                ) : (
                                  "-"
                                )}
                              </TableCell>
                            )}
                            {show("successRate") && (
                              <TableCell
                                className={`text-xs tabular-nums font-medium ${successRateColor(account._successRate)}`}
                              >
                                {account._successRate != null
                                  ? `${Math.round(account._successRate)}%`
                                  : "无数据"}
                              </TableCell>
                            )}
                            {show("reqFail") && (
                              <TableCell className="text-xs tabular-nums">
                                {account._total} / {account._failures}
                              </TableCell>
                            )}
                            {show("locationFail") && (
                              <TableCell className="text-xs">
                                {account._locationFailures > 0 ? (
                                  <span className="inline-flex items-center gap-1">
                                    <span
                                      className={`inline-block size-1.5 rounded-full ${account._locationFailures >= 10 ? "bg-red-500" : "bg-yellow-500"}`}
                                    />
                                    {account._locationFailures}
                                  </span>
                                ) : (
                                  "-"
                                )}
                              </TableCell>
                            )}
                            {show("lastConversation") && (
                              <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                                {formatDateTime(account.lastConversationOkAt) || "-"}
                              </TableCell>
                            )}
                            {show("lastCode") && (
                              <TableCell className="text-xs text-muted-foreground">
                                {account._lastStatus || "-"}
                              </TableCell>
                            )}
                            <TableCell>
                              <Button
                                variant={isDisabled ? "outline" : "destructive"}
                                size="xs"
                                disabled={togglingIds.has(id)}
                                onClick={() => handleToggleAccount(id, account.enabled !== false)}
                              >
                                {togglingIds.has(id) ? (
                                  <Spinner size={12} />
                                ) : isDisabled ? (
                                  <>
                                    <Unlock data-icon />
                                    解封
                                  </>
                                ) : (
                                  <>
                                    <Lock data-icon />
                                    禁用
                                  </>
                                )}
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-center gap-2 py-3 border-t">
                    <Button
                      variant="outline"
                      size="icon-xs"
                      disabled={safePage <= 1}
                      onClick={() => setPage(safePage - 1)}
                    >
                      <ChevronLeft />
                    </Button>
                    <div className="flex items-center gap-1">
                      {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                        let pageNum: number;
                        if (totalPages <= 7) {
                          pageNum = i + 1;
                        } else if (safePage <= 4) {
                          pageNum = i + 1;
                        } else if (safePage >= totalPages - 3) {
                          pageNum = totalPages - 6 + i;
                        } else {
                          pageNum = safePage - 3 + i;
                        }
                        return (
                          <Button
                            key={pageNum}
                            variant={pageNum === safePage ? "default" : "ghost"}
                            size="icon-xs"
                            onClick={() => setPage(pageNum)}
                          >
                            {pageNum}
                          </Button>
                        );
                      })}
                    </div>
                    <Button
                      variant="outline"
                      size="icon-xs"
                      disabled={safePage >= totalPages}
                      onClick={() => setPage(safePage + 1)}
                    >
                      <ChevronRight />
                    </Button>
                    <span className="text-xs text-muted-foreground ml-2">
                      {safePage} / {totalPages} 页
                    </span>
                  </div>
                )}
              </>
            </CardContent>
          </Card>
        )}

        {/* ── 5. Throttle Config ── */}
        <Separator />
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-lg font-semibold">动态节流配置</h2>
              <p className="text-xs text-muted-foreground">
                控制客户端重试速率。无配置时使用自动模式（根据号池健康度动态调整）。修改后立即对所有新请求生效。
              </p>
            </div>
            <div className="flex gap-1.5">
              <Button variant="outline" size="sm" onClick={fetchThrottleConfig}>
                <RefreshCw data-icon className="size-3.5" />
                刷新
              </Button>
              <AlertDialog>
                <AlertDialogTrigger
                  render={
                    <Button variant="destructive" size="sm" disabled={!hasThrottleConfig}>
                      <Trash2 data-icon className="size-3.5" />
                      恢复自动
                    </Button>
                  }
                />
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>恢复自动模式</AlertDialogTitle>
                    <AlertDialogDescription>
                      确定恢复自动模式？将删除手动配置文件。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction onClick={handleDeleteThrottle}>确认</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>

          {throttleLoaded && (
            <div className="text-xs text-muted-foreground">
              {hasThrottleConfig ? (
                <span className="text-primary">
                  当前有手动配置生效。路径: {throttlePath}
                </span>
              ) : (
                "自动模式（无手动配置文件）"
              )}
            </div>
          )}

          <div className="grid gap-3">
            {/* Emergency */}
            <Card className="border-red-500/25 bg-red-500/[0.04]">
              <CardContent className="flex flex-col gap-3 pt-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-red-400">紧急模式</span>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                    <Switch
                      checked={emergencyEnabled}
                      onCheckedChange={setEmergencyEnabled}
                      size="sm"
                    />
                    启用
                  </label>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">最大重试</label>
                    <Input
                      type="number"
                      min={1}
                      max={10}
                      value={emergencyMaxAttempts}
                      onChange={(e) =>
                        setEmergencyMaxAttempts((e.target as HTMLInputElement).value)
                      }
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">基础延迟(ms)</label>
                    <Input
                      type="number"
                      min={500}
                      value={emergencyBaseDelay}
                      onChange={(e) =>
                        setEmergencyBaseDelay((e.target as HTMLInputElement).value)
                      }
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">提示消息</label>
                    <Input
                      placeholder="维护中..."
                      value={emergencyMessage}
                      onChange={(e) =>
                        setEmergencyMessage((e.target as HTMLInputElement).value)
                      }
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Global defaults */}
            <Card>
              <CardContent className="flex flex-col gap-3 pt-4">
                <div>
                  <span className="text-sm font-semibold">全局默认</span>
                  <p className="text-xs text-muted-foreground">
                    所有模型生效。留空 = 自动模式。
                  </p>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">maxAttempts</label>
                    <Input
                      type="number"
                      placeholder="自动"
                      value={globalMaxAttempts}
                      onChange={(e) =>
                        setGlobalMaxAttempts((e.target as HTMLInputElement).value)
                      }
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">baseDelayMs</label>
                    <Input
                      type="number"
                      placeholder="自动"
                      value={globalBaseDelay}
                      onChange={(e) =>
                        setGlobalBaseDelay((e.target as HTMLInputElement).value)
                      }
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">capacityWaitMs</label>
                    <Input
                      type="number"
                      placeholder="自动"
                      value={globalCapacityWait}
                      onChange={(e) =>
                        setGlobalCapacityWait((e.target as HTMLInputElement).value)
                      }
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">backoffMultiplier</label>
                    <Input
                      type="number"
                      step={0.1}
                      placeholder="自动"
                      value={globalBackoff}
                      onChange={(e) =>
                        setGlobalBackoff((e.target as HTMLInputElement).value)
                      }
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Per-model overrides */}
            <Card>
              <CardContent className="flex flex-col gap-3 pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm font-semibold">按模型覆盖</span>
                    <p className="text-xs text-muted-foreground">
                      优先于全局。只设置需要覆盖的字段。
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setModelRows((prev) => [
                        ...prev,
                        {
                          id: uid(),
                          name: "",
                          baseDelayMs: "",
                          capacityWaitMs: "",
                          maxAttempts: "",
                          backoffMultiplier: "",
                        },
                      ])
                    }
                  >
                    <Plus data-icon className="size-3.5" />
                    添加模型
                  </Button>
                </div>
                <div className="flex flex-col gap-2">
                  {modelRows.map((row) => (
                    <div key={row.id} className="grid grid-cols-[1.2fr_1fr_1fr_1fr_1fr_auto] gap-2 items-end">
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-muted-foreground">模型名</label>
                        <Input
                          value={row.name}
                          placeholder="gemini-2.5-pro"
                          onChange={(e) =>
                            setModelRows((prev) =>
                              prev.map((r) =>
                                r.id === row.id
                                  ? { ...r, name: (e.target as HTMLInputElement).value }
                                  : r
                              )
                            )
                          }
                          className="h-8 text-sm"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-muted-foreground">baseDelayMs</label>
                        <Input
                          type="number"
                          value={row.baseDelayMs}
                          placeholder="自动"
                          onChange={(e) =>
                            setModelRows((prev) =>
                              prev.map((r) =>
                                r.id === row.id
                                  ? { ...r, baseDelayMs: (e.target as HTMLInputElement).value }
                                  : r
                              )
                            )
                          }
                          className="h-8 text-sm"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-muted-foreground">capacityWaitMs</label>
                        <Input
                          type="number"
                          value={row.capacityWaitMs}
                          placeholder="自动"
                          onChange={(e) =>
                            setModelRows((prev) =>
                              prev.map((r) =>
                                r.id === row.id
                                  ? { ...r, capacityWaitMs: (e.target as HTMLInputElement).value }
                                  : r
                              )
                            )
                          }
                          className="h-8 text-sm"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-muted-foreground">maxAttempts</label>
                        <Input
                          type="number"
                          value={row.maxAttempts}
                          placeholder="自动"
                          onChange={(e) =>
                            setModelRows((prev) =>
                              prev.map((r) =>
                                r.id === row.id
                                  ? { ...r, maxAttempts: (e.target as HTMLInputElement).value }
                                  : r
                              )
                            )
                          }
                          className="h-8 text-sm"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-muted-foreground">backoff</label>
                        <Input
                          type="number"
                          step={0.1}
                          value={row.backoffMultiplier}
                          placeholder="自动"
                          onChange={(e) =>
                            setModelRows((prev) =>
                              prev.map((r) =>
                                r.id === row.id
                                  ? {
                                      ...r,
                                      backoffMultiplier: (e.target as HTMLInputElement).value,
                                    }
                                  : r
                              )
                            )
                          }
                          className="h-8 text-sm"
                        />
                      </div>
                      <Button
                        variant="destructive"
                        size="icon-xs"
                        className="mb-0.5"
                        onClick={() =>
                          setModelRows((prev) => prev.filter((r) => r.id !== row.id))
                        }
                      >
                        <X className="size-3" />
                      </Button>
                    </div>
                  ))}
                  {modelRows.length === 0 && (
                    <p className="text-xs text-muted-foreground">暂无模型覆盖配置</p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* 503 Escalation */}
            <Card>
              <CardContent className="flex flex-col gap-3 pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm font-semibold">503 频率自动升级</span>
                    <p className="text-xs text-muted-foreground">
                      当 503 错误占比超过阈值时，自动增加延迟。
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                    <Switch
                      checked={escalationEnabled}
                      onCheckedChange={setEscalationEnabled}
                      size="sm"
                    />
                    启用
                  </label>
                </div>
                <div className="flex flex-col gap-2">
                  {escalationRows.map((row) => (
                    <div
                      key={row.id}
                      className="grid grid-cols-[1fr_20px_1fr_auto] gap-2 items-center"
                    >
                      <Input
                        type="number"
                        step={0.05}
                        min={0}
                        max={1}
                        value={row.rate503}
                        placeholder="503占比 (0~1)"
                        onChange={(e) =>
                          setEscalationRows((prev) =>
                            prev.map((r) =>
                              r.id === row.id
                                ? { ...r, rate503: (e.target as HTMLInputElement).value }
                                : r
                            )
                          )
                        }
                        className="h-8 text-sm"
                      />
                      <span className="text-center text-muted-foreground text-xs">→</span>
                      <Input
                        type="number"
                        min={0}
                        value={row.addDelayMs}
                        placeholder="追加延迟(ms)"
                        onChange={(e) =>
                          setEscalationRows((prev) =>
                            prev.map((r) =>
                              r.id === row.id
                                ? { ...r, addDelayMs: (e.target as HTMLInputElement).value }
                                : r
                            )
                          )
                        }
                        className="h-8 text-sm"
                      />
                      <Button
                        variant="destructive"
                        size="icon-xs"
                        onClick={() =>
                          setEscalationRows((prev) => prev.filter((r) => r.id !== row.id))
                        }
                      >
                        <X className="size-3" />
                      </Button>
                    </div>
                  ))}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() =>
                    setEscalationRows((prev) => [
                      ...prev,
                      { id: uid(), rate503: "", addDelayMs: "" },
                    ])
                  }
                >
                  <Plus data-icon className="size-3.5" />
                  添加阈值
                </Button>
              </CardContent>
            </Card>

            {/* Save button */}
            <Button onClick={handleSaveThrottle} disabled={savingThrottle} className="self-start">
              {savingThrottle ? (
                <Spinner size={14} className="mr-1" />
              ) : (
                <Save data-icon className="size-3.5" />
              )}
              保存节流配置
            </Button>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
