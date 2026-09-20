export type CodexDiagnostic = {
  result: string;
  errorCode: string;
  requestedModel: string;
  sentModel: string;
  upstreamModel: string;
  reasoningEffort: string;
  requestId: string;
  responseId: string;
  sessionHash: string;
  egressFingerprint: string;
  egressChanged: boolean;
  accountChanged: boolean;
  observationLimited: boolean;
};

// Explicit fields only: arbitrary client objects must not enter request logs.
export function readCodexDiagnostic(raw: unknown): CodexDiagnostic | undefined {
  if (!raw || typeof raw !== "object") return;
  const r = raw as Record<string, unknown>;
  if (!["completed", "failed", "incomplete", "interrupted", "missing_completion"].includes(String(r.result))) return;
  const text = (key: string) => typeof r[key] === "string" && /^[a-zA-Z0-9._/:\-]{1,128}$/.test(r[key] as string) ? r[key] as string : "";
  const hash = (key: string) => typeof r[key] === "string" && /^[a-f0-9]{64}$/.test(r[key] as string) ? r[key] as string : "";
  return {
    result: String(r.result), errorCode: text("errorCode"),
    requestedModel: text("requestedModel"), sentModel: text("sentModel"), upstreamModel: text("upstreamModel"),
    reasoningEffort: text("reasoningEffort"), requestId: text("requestId"), responseId: text("responseId"),
    sessionHash: hash("sessionHash"), egressFingerprint: hash("egressFingerprint"),
    egressChanged: r.egressChanged === true, accountChanged: r.accountChanged === true,
    observationLimited: r.observationLimited === true,
  };
}

export type CodexHealthKind = "completed" | "invalid_prompt" | "context_error" | "capacity" | "rate_limit" | "quota" | "model_mismatch" | "incomplete" | "transport" | "upstream_error" | "observation_limited";

export function codexHealthKind(status: number, d: CodexDiagnostic): CodexHealthKind {
  const code = d.errorCode.toLowerCase();
  if (code === "invalid_prompt" || code === "content_policy_violation") return "invalid_prompt";
  if (/context_length|invalid_encrypted|previous_response|invalid_signature/.test(code)) return "context_error";
  if (/capacity|overload/.test(code) || status === 503) return "capacity";
  if (/usage_limit|quota|insufficient|exhaust/.test(code)) return "quota";
  if (/rate_limit|too_many_requests|slow_down/.test(code) || status === 429) return "rate_limit";
  if (d.result === "missing_completion" && d.observationLimited) return "observation_limited";
  if (d.result === "interrupted" || d.result === "missing_completion") return "transport";
  if (d.result === "incomplete") return "incomplete";
  if (d.result !== "completed" || status >= 400) return "upstream_error";
  if (d.sentModel && d.upstreamModel && d.sentModel !== d.upstreamModel) return "model_mismatch";
  return "completed";
}
