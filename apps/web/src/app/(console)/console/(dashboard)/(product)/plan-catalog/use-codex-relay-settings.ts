"use client";

import { useCallback, useEffect, useState } from "react";

export type CodexRelaySettings = {
  enabled: boolean;
  baseUrl: string;
  apiKeyConfigured: boolean;
  apiKeyHint: string;
  models: string[];
  modelMap: Record<string, string>;
};

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return String(body?.message || body?.error || fallback);
  } catch {
    return fallback;
  }
}

export function useCodexRelaySettings() {
  const [settings, setSettings] = useState<CodexRelaySettings | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/console/plan-catalog/codex-relay", { cache: "no-store" });
      if (!response.ok) throw new Error(await errorMessage(response, "加载 Codex 中转设置失败"));
      setSettings(await response.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const save = useCallback(async (input: {
    enabled: boolean;
    baseUrl: string;
    apiKey: string;
    models: string[];
    modelMap: Record<string, string>;
  }) => {
    const response = await fetch("/api/console/plan-catalog/codex-relay", {
      method: "PATCH",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(await errorMessage(response, "保存 Codex 中转设置失败"));
    const next = await response.json() as CodexRelaySettings;
    setSettings(next);
    return next;
  }, []);

  return { settings, loading, refresh, save };
}
