const adminRoles = new Set(["ADMIN"]);
const operatorRoles = new Set(["ADMIN", "OPERATIONS"]);
const supportRoles = new Set(["ADMIN", "OPERATIONS", "SUPPORT"]);

export function canCreateAccount(role?: string | null) {
  return adminRoles.has(role ?? "");
}

export function canCreateGroup(role?: string | null) {
  return adminRoles.has(role ?? "");
}

export function canManageCodes(role?: string | null) {
  return operatorRoles.has(role ?? "");
}

export function canReplaceMember(role?: string | null) {
  return operatorRoles.has(role ?? "");
}

export function canRetryTask(role?: string | null, status?: string | null) {
  return (
    operatorRoles.has(role ?? "") &&
    ["PENDING", "FAILED_RETRYABLE", "FAILED_FINAL", "MANUAL_REVIEW"].includes(status ?? "")
  );
}

export function canManualCompleteTask(role?: string | null, status?: string | null) {
  return (
    supportRoles.has(role ?? "") &&
    ["MANUAL_REVIEW", "FAILED_FINAL"].includes(status ?? "")
  );
}

export function canManualFailTask(role?: string | null, status?: string | null) {
  return supportRoles.has(role ?? "") && status === "MANUAL_REVIEW";
}

export function canCancelTask(role?: string | null, status?: string | null) {
  return (
    operatorRoles.has(role ?? "") &&
    ["PENDING", "RUNNING", "FAILED_RETRYABLE", "MANUAL_REVIEW"].includes(status ?? "")
  );
}

