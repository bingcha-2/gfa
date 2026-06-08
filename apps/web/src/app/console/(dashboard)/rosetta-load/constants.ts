// ── Constants, canonical model mapping, and column config ──

import type { CanonicalModel, QuotaDisplayItem } from "./types";

export const PAGE_SIZE = 20;

export const REASON_LABELS: Record<string, string> = {
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
export function uid() {
  return String(++nextId);
}

// ── Canonical model mapping (aligned with cockpit-tools) ──

export const CANONICAL_MODELS: CanonicalModel[] = [
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

export function resolveCanonicalModel(name: string): CanonicalModel | undefined {
  const key = _normalizeKey(name);
  return key ? CANONICAL_ALIAS_MAP.get(key) : undefined;
}

export function getQuotaDisplayItem(
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

export function quotaBarColor(pct: number): string {
  if (pct > 60) return "bg-emerald-500";
  if (pct > 25) return "bg-amber-500";
  return "bg-red-500";
}

export function quotaTextColor(pct: number): string {
  if (pct > 60) return "text-emerald-500";
  if (pct > 25) return "text-amber-500";
  return "text-red-500";
}

export function formatResetTime(rt: string): string {
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

export function formatQuotaRefreshedAt(ts: number | undefined | null): string {
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

// ── Column configuration ──

export const COLUMN_CONFIG: { key: string; label: string }[] = [
  { key: "account", label: "账号" },
  { key: "plan", label: "套餐" },
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

export const DEFAULT_VISIBLE_COLS = new Set<string>([
  "account",
  "plan",
  "modelQuota",
  "quotaStatus",
  "reason",
  "lease",
  "successRate",
]);

export const MODEL_QUOTA_OPTIONS = CANONICAL_MODELS.filter((model) =>
  model.id.startsWith("gemini-3") || model.id.startsWith("claude-"),
);

export const DEFAULT_VISIBLE_MODEL_QUOTAS = new Set<string>(
  MODEL_QUOTA_OPTIONS.map((model) => model.id),
);

export const COLUMN_KEYS = new Set(COLUMN_CONFIG.map((col) => col.key));

export function migrateVisibleColumns(values: string[]): Set<string> {
  const next = new Set(values.filter((key) => COLUMN_KEYS.has(key)));
  next.add("modelQuota");
  next.delete("blockedModels");
  return next.size > 0 ? next : new Set(DEFAULT_VISIBLE_COLS);
}
