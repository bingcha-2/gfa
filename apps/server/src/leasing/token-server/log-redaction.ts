// Shared by ingestion and read/export boundaries: older clients and stored rows
// may contain credentials even when current clients already filter them.
const SECRET_KEY_SOURCE = "(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|x[-_]?api[-_]?key|api[-_]?key|x[-_]?access[-_]?key|x[-_]?token[-_]?server[-_]?secret|access[-_]?token|refresh[-_]?token|session[-_]?token|id[-_]?token|password|secret|(?:x[-_]?)?codex[-_]?turn[-_]?state|current[-_]?turn[-_]?state|turn[-_]?state)";
const SECRET_KEY = new RegExp(`^${SECRET_KEY_SOURCE}$`, "i");
const SECRET_ASSIGNMENT = new RegExp(`(?:^|[\\s\"'\\\\{,;?&])${SECRET_KEY_SOURCE}[\"']?\\s*[:=]`, "i");
const OPAQUE_CREDENTIAL = /\b(?:Bearer\s+[A-Za-z0-9._~+\/-]+=*|gAAAAA[A-Za-z0-9_=-]{24,})/i;
const INPUT_MAX = 64 * 1024;
const REDACTED = "[redacted]";
const TRUNCATED = '{"_truncated":true}';

function redact(value: unknown, budget: { remaining: number }, depth = 0): unknown {
  if (depth > 20 || --budget.remaining < 0) throw new Error("diagnostic limit");
  if (typeof value === "string") {
    const trimmed = value.trim();
    // Some old reports put serialized JSON in a message or metadata field.
    if (/^[{[\"]/.test(trimmed)) {
      try { return JSON.stringify(redact(JSON.parse(trimmed), budget, depth + 1)); }
      catch { return REDACTED; }
    }
    return SECRET_ASSIGNMENT.test(value) || OPAQUE_CREDENTIAL.test(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === "string" && SECRET_KEY.test(value[0].trim())) return [value[0], REDACTED];
    return value.map((child) => redact(child, budget, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  // Also support header lists represented as {name, value} objects.
  if (typeof object.name === "string" && SECRET_KEY.test(object.name.trim()) && "value" in object) return { name: object.name, value: REDACTED };
  return Object.fromEntries(Object.entries(object)
    .filter(([key]) => !SECRET_KEY.test(key.trim()))
    .map(([key, child]) => [key, redact(child, budget, depth + 1)]));
}

export function redactLogHeaders(raw: unknown): string {
  if (!raw) return "";
  const text = String(raw);
  if (text.length > INPUT_MAX) return TRUNCATED;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return "";
    const result = JSON.stringify(redact(parsed, { remaining: 2_000 }));
    return result.length <= 2_000 ? result : TRUNCATED;
  } catch { return ""; }
}

export function redactLogText(raw: unknown, maxLength = 2_000): string {
  if (!raw) return "";
  const text = String(raw);
  // Inspect before truncating: truncated JSON must never become opaque text
  // containing the beginning of a credential that could otherwise be removed.
  if (text.length > INPUT_MAX) return TRUNCATED;
  const trimmed = text.trim();
  try {
    if (/^[{[\"]/.test(trimmed)) {
      return JSON.stringify(redact(JSON.parse(trimmed), { remaining: 2_000 })).slice(0, maxLength);
    }
    return String(redact(text, { remaining: 2_000 })).slice(0, maxLength);
  } catch { return REDACTED; }
}
