import * as vscode from "vscode";
import { BCAI_CONFIG_SECTION } from "../distribution.js";
import type { RosettaState } from "./rosettaState.js";
import { readJsonFile, writeJsonFile } from "./rosettaState.js";

const TOKEN_KEY = "bcai.employee.token";
const EMPLOYEE_KEY = "bcai.employee.profile";

export type EmployeeProfile = {
  id: string;
  email: string;
  status: string;
  stats?: { total: number; accepted: number; failed: number; disabled: number; deleted: number };
};

export type EmployeeSession = {
  token: string;
  employee: EmployeeProfile;
};

function getRosettaApiBase(): string {
  const config = vscode.workspace.getConfiguration(BCAI_CONFIG_SECTION);
  const configured = String(config.get<string>("rosettaApiBaseUrl") || "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  const base = String(config.get<string>("apiBaseUrl") || "https://bcai.site/api/proxy").trim();
  if (base.endsWith("/api/proxy")) return base.replace(/\/api\/proxy$/, "/api/rosetta");
  return "https://bcai.site/api/rosetta";
}

async function request(path: string, options: { method?: string; body?: any; token?: string } = {}) {
  const url = `${getRosettaApiBase()}/${path.replace(/^\/+/, "")}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const res = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let payload: any = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!res.ok || payload?.ok === false) {
    throw new Error(payload?.error || payload?.message || `请求失败 (${res.status})`);
  }
  return payload;
}

export async function getEmployeeSession(context: vscode.ExtensionContext): Promise<EmployeeSession | null> {
  const token = await context.secrets.get(TOKEN_KEY);
  const raw = context.globalState.get<EmployeeProfile | undefined>(EMPLOYEE_KEY);
  if (!token || !raw?.id) return null;
  return { token, employee: raw };
}

export async function employeeLogin(
  context: vscode.ExtensionContext,
  email: string,
  password: string,
  register = false
): Promise<EmployeeSession> {
  const payload = await request(register ? "employee/register" : "employee/login", {
    method: "POST",
    body: { email, password },
  });
  await context.secrets.store(TOKEN_KEY, payload.token);
  await context.globalState.update(EMPLOYEE_KEY, payload.employee);
  return { token: payload.token, employee: payload.employee };
}

export async function employeeLogout(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(TOKEN_KEY);
  await context.globalState.update(EMPLOYEE_KEY, undefined);
}

export async function employeeMe(context: vscode.ExtensionContext): Promise<any> {
  const session = await getEmployeeSession(context);
  if (!session) return null;
  const payload = await request("employee/me", { token: session.token });
  await context.globalState.update(EMPLOYEE_KEY, payload.employee);
  return payload;
}

export async function submitEligibleEmployeeAccounts(
  context: vscode.ExtensionContext,
  state: RosettaState
): Promise<number> {
  const session = await getEmployeeSession(context);
  if (!session) return 0;
  const accountsData = readJsonFile(state.workspace.paths.accountsPath, { accounts: [] } as any);
  const accounts: any[] = Array.isArray(accountsData.accounts) ? accountsData.accounts : [];
  let submitted = 0;
  let changed = false;
  for (const account of accounts) {
    if (String(account.sourceEmployeeId || "") !== session.employee.id) continue;
    if (account.employeeSubmittedAt) continue;
    if (!account.projectId || !account.refreshToken) continue;
    const result = await request("employee/submit-account", {
      method: "POST",
      token: session.token,
      body: {
        localAccountId: account.id,
        email: account.email,
        refreshToken: account.refreshToken,
        projectId: account.projectId,
        planType: account.planType || "",
        lastConversationOkAt: account.lastConversationOkAt,
      },
    });
    account.employeeSubmittedAt = new Date().toISOString();
    account.employeeSubmitStatus = "accepted";
    if (result?.employee) {
      await context.globalState.update(EMPLOYEE_KEY, result.employee);
    }
    submitted++;
    changed = true;
  }
  if (changed) writeJsonFile(state.workspace.paths.accountsPath, { ...accountsData, accounts });
  return submitted;
}

export function stampEmployeeAccount(account: any, session: EmployeeSession | null): any {
  if (!session) return account;
  return {
    ...account,
    source: "employee",
    sourceEmployeeId: session.employee.id,
    sourceEmployeeEmail: session.employee.email,
  };
}
