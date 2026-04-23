import React from "react";
import type { RosettaQuotaGroup } from "../lib/rosetta-types";

const PROVIDER_META: Record<string, { label: string; icon: string; cls: string }> = {
  gemini: { label: "Gemini", icon: "✦", cls: "gemini" },
  claude: { label: "Claude", icon: "◈", cls: "claude" },
  gpt: { label: "GPT", icon: "◉", cls: "gpt" },
  other: { label: "其他", icon: "○", cls: "other" },
};

function classifyProvider(entry: { provider?: string; key?: string }): string {
  const p = (entry.provider || "").toUpperCase();
  const k = (entry.key || "").toLowerCase();
  if (p.includes("ANTHROPIC") || k.includes("claude")) return "claude";
  if (p.includes("OPENAI") || k.includes("gpt") || k.includes("o3") || k.includes("o4")) return "gpt";
  if (p.includes("GEMINI") || k.includes("gemini")) return "gemini";
  return "other";
}

function quotaTone(percent: number): string {
  if (percent >= 70) return "success";
  if (percent >= 30) return "warning";
  return "danger";
}

function formatPercent(v: number): string {
  if (Math.abs(v - Math.round(v)) < 0.01) return `${Math.round(v)}%`;
  return `${v.toFixed(1)}%`;
}

function humanizeResetTime(resetTime: string): string {
  if (!resetTime) return "";
  const date = new Date(resetTime);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return "已重置";
  const totalMin = Math.ceil(diffMs / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m 后刷新`;
  if (h > 0) return `${h}h 后刷新`;
  return `${m}m 后刷新`;
}

export function RosettaQuota({
  groups,
  refreshedAt,
}: {
  groups: RosettaQuotaGroup[];
  refreshedAt?: string;
}) {
  if (!groups || groups.length === 0) {
    return (
      <div className="rosetta-quota-empty">
        还没拿到额度快照。请确认代理已启动，额度会自动刷新。
      </div>
    );
  }

  // Flatten all entries then group by provider
  const allEntries: Array<any & { snapshotPercent: number; resetTime: string }> = [];
  for (const group of groups) {
    for (const entry of group.entries || []) {
      allEntries.push({
        ...entry,
        snapshotPercent: entry.percent ?? 0,
        resetTime: entry.resetTime || group.resetTime,
      });
    }
  }

  const providerMap = new Map<string, typeof allEntries>();
  for (const entry of allEntries) {
    const prov = classifyProvider(entry);
    if (!providerMap.has(prov)) providerMap.set(prov, []);
    providerMap.get(prov)!.push(entry);
  }

  const providerOrder = ["gemini", "claude", "gpt", "other"];
  const blockedCount = allEntries.filter((e) => e.isBlocked).length;
  const statusText = blockedCount > 0 ? `受限 ${blockedCount} 项` : `${allEntries.length} 个模型`;

  return (
    <div className="rosetta-quota">
      <div className="rosetta-quota-head">
        <strong>模型额度</strong>
        <span>{statusText}{refreshedAt ? ` · ${formatTime(refreshedAt)}` : ""}</span>
      </div>
      {providerOrder
        .filter((k) => providerMap.has(k))
        .map((k) => (
          <ProviderGroup key={k} providerKey={k} entries={providerMap.get(k)!} />
        ))}
    </div>
  );
}

function ProviderGroup({ providerKey, entries }: { providerKey: string; entries: any[] }) {
  const [showModels, setShowModels] = React.useState(false);
  const meta = PROVIDER_META[providerKey] || PROVIDER_META.other;
  const rep = entries[0] || {};
  const percent = Math.max(0, Math.min(100, Number(rep.snapshotPercent ?? rep.percent ?? 0)));
  const hasPercent = entries.some((e) => e.hasSnapshotPercent !== false);
  const allBlocked = entries.every((e) => e.isBlocked);
  const tone = allBlocked ? "danger" : quotaTone(percent);
  const resetStr = humanizeResetTime(rep.resetTime);
  const percentStr = hasPercent ? formatPercent(percent) : "—";

  return (
    <div className={`rosetta-provider-group ${meta.cls}`}>
      <div className={`rosetta-provider-head ${tone}`}>
        <div className="rosetta-provider-left">
          <span className="rosetta-provider-icon">{meta.icon}</span>
          <span className="rosetta-provider-label">{meta.label}</span>
          <span className="rosetta-provider-count">{entries.length} 模型</span>
        </div>
        <div className="rosetta-provider-right">
          {resetStr && <span className="rosetta-provider-reset">{resetStr}</span>}
          <span className={`rosetta-provider-percent ${hasPercent ? tone : "muted"}`}>{percentStr}</span>
          {allBlocked && <span className="rosetta-provider-blocked">已耗尽</span>}
          <button
            className="rosetta-models-toggle"
            onClick={() => setShowModels(!showModels)}
            title={showModels ? "收起模型列表" : "展开模型列表"}
          >
            {showModels ? "▾" : "▸"}
          </button>
        </div>
      </div>

      {/* Segmented bar */}
      <div className={`rosetta-quota-bar ${tone} ${allBlocked ? "blocked" : ""}`}>
        {Array.from({ length: 10 }, (_, i) => (
          <span
            key={i}
            className={`rosetta-bar-seg ${i < Math.round(percent / 10) ? "filled" : ""}`}
          />
        ))}
      </div>

      {/* Model tags — collapsed by default */}
      {showModels && (
        <div className="rosetta-model-tags">
          {entries.map((e) => (
            <span key={e.key} className={`rosetta-model-tag ${e.isBlocked ? "blocked" : ""}`}>
              {e.label || e.key}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function formatTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}
