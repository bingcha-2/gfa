"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { consoleApiPath } from "@/lib/console/client-api";

const modes = [
  { value: "off", label: "关闭（默认）" },
  { value: "device", label: "仅设备" },
  { value: "session", label: "设备＋会话" },
  { value: "full", label: "完全收敛" },
];
const descriptions: Record<string, string> = {
  off: "保留客户端标识", device: "统一设备，保留各自会话",
  session: "统一设备和会话，保留独立线程", full: "设备、会话和线程共用同一身份",
};

export function CodexFingerprintSelect({ accountId, mode = "off", onSaved }: {
  accountId: number; mode?: string; onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  async function save(value: string) {
    if (saving || value === mode) return;
    setSaving(true);
    try {
      const response = await fetch(consoleApiPath("rosetta/codex-fingerprint"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, mode: value }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "保存失败");
      toast.success("指纹收敛已保存，新请求生效；已有长连接需重连");
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally { setSaving(false); }
  }
  return (
    <div className="flex flex-col gap-1">
      <Select value={mode} items={modes} onValueChange={save} disabled={saving}>
        <SelectTrigger size="sm" aria-label={`账号 ${accountId} 的指纹收敛`} aria-describedby={`fingerprint-${accountId}`} aria-busy={saving}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent><SelectGroup>
          {modes.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
        </SelectGroup></SelectContent>
      </Select>
      <span id={`fingerprint-${accountId}`} className="text-xs text-muted-foreground">{saving ? "保存中…" : descriptions[mode]}</span>
    </div>
  );
}
