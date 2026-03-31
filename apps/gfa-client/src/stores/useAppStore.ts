import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface Account {
  id: string;
  email: string;
  password: string;
  recovery_email: string | null;
  totp_secret: string | null;
  status: string;
  created_at: string;
  last_login_at: string | null;
  antigravity_token: {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    email: string;
  } | null;
}

export interface ModelQuota {
  name: string;
  display_name: string | null;
  percentage: number;
  reset_time: string;
}

export interface QuotaInfo {
  subscription_tier: string | null;
  models: ModelQuota[];
  is_forbidden: boolean;
  error: string | null;
}

export interface LogEntry {
  id: number;
  step?: string;
  status?: "running" | "done" | "failed";
  level?: string;
  message?: string;
  detail?: string;
  timestamp: number;
}

/** API automation task status (from polling) */
interface AutomationStatus {
  taskId: string;
  type?: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  result?: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    email?: string;
  };
  logs?: Array<{ level: string; message: string; createdAt?: string }>;
}

interface AppState {
  // Navigation
  currentPage: string;
  setCurrentPage: (page: string) => void;

  // Accounts
  accounts: Account[];
  loadAccounts: () => Promise<void>;
  importAccounts: (text: string) => Promise<Account[]>;
  deleteAccount: (email: string) => Promise<void>;

  // Automation (via API)
  isRunning: boolean;
  runningEmail: string | null;
  logs: LogEntry[];
  clearLogs: () => void;
  runAcceptInvite: (email: string) => Promise<void>;


  // GFA API
  gfaApiUrl: string;
  loadSettings: () => Promise<void>;
  updateGfaApiUrl: (url: string) => Promise<void>;

  // Antigravity
  startAntigravityOAuth: (email: string) => Promise<void>;
  switchAntigravityAccount: (email: string) => Promise<string>;
  batchAntigravityOAuth: (emails: string[]) => Promise<void>;
  oauthProgress: { current: number; total: number; email: string } | null;
  fetchQuota: (email: string) => Promise<QuotaInfo | null>;
  quotaCache: Record<string, QuotaInfo>;

  // Sidecar event listener (kept for backward compat, but mostly unused now)
  initEventListener: () => Promise<void>;
}

let logCounter = 0;

/**
 * Poll an automation task until it reaches a terminal state.
 * Calls the Rust command which calls GFA API.
 * Returns the final status response.
 */
async function pollUntilDone(
  taskId: string,
  onLog: (entry: LogEntry) => void,
  intervalMs = 3000,
  timeoutMs = 180000
): Promise<AutomationStatus> {
  const deadline = Date.now() + timeoutMs;
  let lastLogCount = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));

    const status = await invoke<AutomationStatus>("poll_automation_status", {
      taskId,
    });

    // Push new logs to the callback
    if (status.logs && status.logs.length > lastLogCount) {
      const newLogs = status.logs.slice(lastLogCount);
      for (const log of newLogs) {
        onLog({
          id: logCounter++,
          level: log.level,
          message: log.message,
          timestamp: new Date(log.createdAt ?? Date.now()).getTime(),
        });
      }
      lastLogCount = status.logs.length;
    }

    // Terminal states
    if (
      status.status === "SUCCESS" ||
      status.status === "FAILED_FINAL" ||
      status.status === "FAILED_RETRYABLE" ||
      status.status === "CANCELLED" ||
      status.status === "MANUAL_REVIEW"
    ) {
      return status;
    }
  }

  throw new Error(`Automation task ${taskId} timed out after ${timeoutMs}ms`);
}

export const useAppStore = create<AppState>((set, get) => ({
  currentPage: "accounts",
  setCurrentPage: (page) => set({ currentPage: page }),

  accounts: [],
  loadAccounts: async () => {
    try {
      const accounts = await invoke<Account[]>("list_accounts");
      set({ accounts });
    } catch (e) {
      console.error("Failed to load accounts:", e);
    }
  },

  importAccounts: async (text: string) => {
    console.log("[Store] importAccounts: invoking import_accounts...");
    const accounts = await invoke<Account[]>("import_accounts", { text });
    console.log("[Store] importAccounts: invoke done, got", accounts.length);
    console.log("[Store] importAccounts: calling loadAccounts...");
    await get().loadAccounts();
    console.log("[Store] importAccounts: loadAccounts done");
    return accounts;
  },

  deleteAccount: async (email: string) => {
    await invoke("delete_account", { email });
    await get().loadAccounts();
  },

  isRunning: false,
  runningEmail: null,
  logs: [],
  clearLogs: () => set({ logs: [] }),

  runAcceptInvite: async (email: string) => {
    set({ isRunning: true, runningEmail: email, logs: [] });
    try {
      // Start automation via API
      const { taskId } = await invoke<{ taskId: string }>(
        "run_accept_invite",
        { email }
      );

      // Poll for completion
      const result = await pollUntilDone(taskId, (entry) => {
        set((s) => ({ logs: [...s.logs, entry] }));
      });

      if (result.status !== "SUCCESS") {
        set((s) => ({
          logs: [
            ...s.logs,
            {
              id: logCounter++,
              level: "ERROR",
              message:
                result.lastErrorMessage ??
                `Task failed: ${result.lastErrorCode}`,
              timestamp: Date.now(),
            },
          ],
        }));
      }
    } catch (e) {
      set((s) => ({
        logs: [
          ...s.logs,
          {
            id: logCounter++,
            level: "ERROR",
            message: String(e),
            timestamp: Date.now(),
          },
        ],
      }));
    } finally {
      set({ isRunning: false, runningEmail: null });
    }
  },


  gfaApiUrl: "http://localhost:3000",
  loadSettings: async () => {
    try {
      const url = await invoke<string>("get_gfa_api_url");
      set({ gfaApiUrl: url });
    } catch {
      /* ignore */
    }
  },

  updateGfaApiUrl: async (url: string) => {
    await invoke("update_gfa_api_url", { url });
    set({ gfaApiUrl: url });
  },

  startAntigravityOAuth: async (email: string) => {
    set({ isRunning: true, runningEmail: email, logs: [] });
    try {
      // Start OAuth via API
      const { taskId } = await invoke<{ taskId: string }>(
        "start_antigravity_oauth",
        { email }
      );

      // Poll for completion
      const result = await pollUntilDone(taskId, (entry) => {
        set((s) => ({ logs: [...s.logs, entry] }));
      });

      if (result.status === "SUCCESS" && result.result?.access_token) {
        // Save token to local SQLite directly from server result
        const expiresAt =
          Math.floor(Date.now() / 1000) + (result.result.expires_in ?? 3600);

        await invoke("save_antigravity_token", {
          email,
          accessToken: result.result.access_token,
          refreshToken: result.result.refresh_token ?? "",
          expiresAt,
        });
        // Reload accounts to reflect new token
        await get().loadAccounts();

        set((s) => ({
          logs: [
            ...s.logs,
            {
              id: logCounter++,
              level: "INFO",
              message: `✅ OAuth completed for ${email}`,
              timestamp: Date.now(),
            },
          ],
        }));
      } else if (result.status !== "SUCCESS") {
        set((s) => ({
          logs: [
            ...s.logs,
            {
              id: logCounter++,
              level: "ERROR",
              message:
                result.lastErrorMessage ??
                `OAuth failed: ${result.lastErrorCode}`,
              timestamp: Date.now(),
            },
          ],
        }));
      }
    } catch (e) {
      set((s) => ({
        logs: [
          ...s.logs,
          {
            id: logCounter++,
            level: "ERROR",
            message: String(e),
            timestamp: Date.now(),
          },
        ],
      }));
    } finally {
      set({ isRunning: false, runningEmail: null });
    }
  },

  switchAntigravityAccount: async (email: string) => {
    // Switch stays local — no API call
    const result = await invoke<string>("switch_antigravity_account", {
      email,
    });
    await get().loadAccounts();
    return result;
  },

  batchAntigravityOAuth: async (emails: string[]) => {
    const needOAuth = emails.filter((email) => {
      const account = get().accounts.find((a) => a.email === email);
      return account && !account.antigravity_token;
    });

    if (needOAuth.length === 0) return;

    set({ isRunning: true });
    for (let i = 0; i < needOAuth.length; i++) {
      const email = needOAuth[i];
      set({
        runningEmail: email,
        oauthProgress: { current: i + 1, total: needOAuth.length, email },
      });
      try {
        await get().startAntigravityOAuth(email);
      } catch (e) {
        set((s) => ({
          logs: [
            ...s.logs,
            {
              id: logCounter++,
              level: "ERROR",
              message: `OAuth failed for ${email}: ${e}`,
              timestamp: Date.now(),
            },
          ],
        }));
      }
    }
    set({ isRunning: false, runningEmail: null, oauthProgress: null });
  },

  oauthProgress: null,

  fetchQuota: async (email: string) => {
    try {
      const quota = await invoke<QuotaInfo>("fetch_antigravity_quota", {
        email,
      });
      set((s) => ({
        quotaCache: { ...s.quotaCache, [email]: quota },
      }));
      return quota;
    } catch (e) {
      console.error("Quota fetch failed:", e);
      return null;
    }
  },

  quotaCache: {},

  initEventListener: async () => {
    // Guard: prevent double-registering (React Strict Mode calls useEffect twice)
    if ((window as any).__sidecarListenerRegistered) return;
    (window as any).__sidecarListenerRegistered = true;

    // Keep the listener for potential sidecar events (backward compat)
    await listen<string>("sidecar-event", (event) => {
      try {
        const parsed = JSON.parse(event.payload);
        const entry: LogEntry = {
          id: logCounter++,
          timestamp: parsed.ts || Date.now(),
        };

        if (parsed.event === "step") {
          entry.step = parsed.data.step;
          entry.status = parsed.data.status;
          entry.detail = parsed.data.detail;
          entry.message = `${parsed.data.step}: ${parsed.data.detail || parsed.data.status}`;
        } else if (parsed.event === "log") {
          entry.level = parsed.data.level;
          entry.message = parsed.data.message;
        } else if (parsed.event === "complete") {
          entry.message = parsed.data.success
            ? `✅ ${parsed.data.detail || "Completed successfully"}`
            : `❌ ${parsed.data.detail || "Failed"}`;
          entry.status = parsed.data.success ? "done" : "failed";
        } else if (parsed.event === "error") {
          entry.level = "ERROR";
          entry.message = parsed.data.message;
          entry.status = "failed";
        } else {
          return;
        }

        set((s) => ({ logs: [...s.logs, entry] }));
      } catch {
        /* ignore parse errors */
      }
    });
  },
}));
