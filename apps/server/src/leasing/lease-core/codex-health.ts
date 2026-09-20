export type CodexDiagnostic = {
  requestSequence?: number;
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
    requestSequence: Number.isSafeInteger(r.requestSequence) && Number(r.requestSequence) > 0 ? Number(r.requestSequence) : undefined,
    result: String(r.result), errorCode: text("errorCode"),
    requestedModel: text("requestedModel"), sentModel: text("sentModel"), upstreamModel: text("upstreamModel"),
    reasoningEffort: text("reasoningEffort"), requestId: text("requestId"), responseId: text("responseId"),
    sessionHash: hash("sessionHash"), egressFingerprint: hash("egressFingerprint"),
    egressChanged: r.egressChanged === true, accountChanged: r.accountChanged === true,
    observationLimited: r.observationLimited === true,
  };
}

export type CodexAccountRestriction = "account_disabled" | "verification_required";

// Only protocol error codes (or the legacy Go client's exact http_<status>_<code>
// wrapper). Never infer an account ban from HTML, prose, or generic permission errors.
export function codexAccountRestrictionCode(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const code = raw.toLowerCase().replace(/^http_(?:200|400|401|403)_/, "");
  return ["account_deactivated", "account_disabled", "account_restricted", "account_suspended", "service_disabled",
    "account_verification_required", "verification_required", "phone_verification_required"].includes(code) ? code : "";
}

export function codexAccountRestrictionKind(raw: unknown): CodexAccountRestriction | undefined {
  const code = codexAccountRestrictionCode(raw);
  if (code) return code.endsWith("verification_required") ? "verification_required" : "account_disabled";
}

/** Shared guard for leasing and maintenance. A client report is a review hold,
 * not a confirmed ban; only explicit admin recovery removes the persisted hold. */
export function readCodexAccountRestriction(raw: unknown): CodexAccountRestriction | undefined {
  if (!raw || typeof raw !== "object") return;
  const account = raw as Record<string, unknown>;
  if (account.quotaStatus !== "error") return;
  return codexAccountRestrictionKind(account.quotaStatusReason);
}

export type CodexHealthKind = "completed" | "invalid_prompt" | "context_error" | "capacity" | "rate_limit" | "quota" | "model_mismatch" | "incomplete" | "transport" | "upstream_error" | "observation_limited" | CodexAccountRestriction;

export function codexHealthKind(status: number, d: CodexDiagnostic): CodexHealthKind {
  const code = d.errorCode.toLowerCase();
  const restriction = codexAccountRestrictionKind(code);
  if (restriction && (d.result !== "completed" || status >= 400)) return restriction;
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
