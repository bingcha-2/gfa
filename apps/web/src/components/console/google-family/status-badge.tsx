"use client";

import { Badge } from "@/components/ui/badge";
import { useDict } from "@/lib/i18n/client";

type StatusTone = "emerald" | "amber" | "crimson" | "stone" | "sky";

const toneMap: Record<string, StatusTone> = {
  ACTIVE: "emerald",
  HEALTHY: "emerald",
  SUCCESS: "emerald",
  COMPLETED: "emerald",
  INVITE_SENT: "emerald",
  REPLACED_AND_INVITE_SENT: "emerald",
  ACCEPTED: "emerald",
  UNUSED: "sky",
  RESERVED: "amber",
  PENDING: "amber",
  RUNNING: "amber",
  WAIT_USER_ACCEPT: "amber",
  TASK_QUEUED: "amber",
  TASK_RUNNING: "amber",
  CODE_VERIFIED: "sky",
  GROUP_ASSIGNED: "sky",
  CREATED: "sky",
  MANUAL_REVIEW: "stone",
  MANUAL_ONLY: "stone",
  LOGIN_REQUIRED: "stone",
  VERIFICATION_REQUIRED: "stone",
  DISABLED: "crimson",
  FAILED: "crimson",
  FAILED_FINAL: "crimson",
  FAILED_RETRYABLE: "crimson",
  EXPIRED: "crimson",
  REMOVED: "crimson",
  CANCELLED: "crimson",
  RISKY: "amber",
  SENT: "sky",
  USED: "stone",
  REMOVING: "amber",
  INVITING: "amber",
  PARTIALLY_FAILED: "crimson",
  NOT_STARTED: "stone"
};

type StatusBadgeProps = {
  value: string;
  tone?: StatusTone;
};

export function StatusBadge({ value, tone }: StatusBadgeProps) {
  const t = useDict();
  const resolvedTone = tone ?? toneMap[value] ?? "stone";
  const label = t.statusLabels[value] ?? value.replaceAll("_", " ");
  const variant =
    resolvedTone === "crimson" ? "destructive" :
    resolvedTone === "stone" ? "secondary" :
    resolvedTone === "sky" ? "outline" :
    "default";

  return <Badge variant={variant}>{label}</Badge>;
}
