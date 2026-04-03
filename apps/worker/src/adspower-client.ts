/**
 * AdsPower Local API client
 *
 * Wraps the HTTP endpoints exposed by the AdsPower desktop application
 * for browser profile management (start / stop / status check).
 */

export interface AdsPowerConfig {
  baseUrl: string;
  /** API key for AdsPower security verification */
  apiKey?: string;
  /** Max retries for transient failures (profile still launching) */
  maxRetries: number;
  /** Delay between retries in ms */
  retryDelayMs: number;
}

export interface OpenProfileResult {
  /** Chromium CDP websocket debug URL */
  debugUrl: string;
  /** WebDriver endpoint (unused, kept for completeness) */
  webdriver: string;
}

const DEFAULT_CONFIG: AdsPowerConfig = {
  baseUrl: "http://localhost:50325",
  maxRetries: 3,
  retryDelayMs: 3000,
};

export class AdsPowerClient {
  private config: AdsPowerConfig;
  /** Serial mutex: only one openProfile call at a time to avoid AdsPower rate-limit */
  private _openMutex: Promise<void> = Promise.resolve();

  constructor(config?: Partial<AdsPowerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    console.log(`[adspower] init: baseUrl=${this.config.baseUrl}, apiKey=${this.config.apiKey ? this.config.apiKey.slice(0,8) + "..." : "NOT SET"}`);
  }

  /** Build URL with query params, auto-appending api_key if configured */
  private buildUrl(path: string, params: Record<string, string> = {}): string {
    const url = new URL(path, this.config.baseUrl);
    // AdsPower authenticates via api_key query parameter
    if (this.config.apiKey) {
      url.searchParams.set("api_key", this.config.apiKey);
    }
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    return url.toString();
  }

  /** Fetch with auth (both header and query param for compat) */
  private fetchWithAuth(url: string, init?: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }
    return fetch(url, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string>) } });
  }

  /**
   * Callback type for the force-close safety guard.
   * Returns true if the caller is allowed to force-close the active profile,
   * false if another task still holds the lock (force-close would be destructive).
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  static readonly CanForceCloseGuard: unique symbol = Symbol();

  /**
   * Start a browser profile.
   * Returns the CDP debug URL for Playwright connection.
   *
   * If the profile is already open (e.g. stale from a previous crash),
   * it is force-closed first so AdsPower will accept a fresh open request.
   *
   * @param canForceClose Optional guard: when the profile is already active,
   *   this callback is invoked to decide whether it is safe to force-close.
   *   If the guard returns false, openProfile throws instead of killing
   *   another task's browser.
   */
  async openProfile(
    profileId: string,
    canForceClose?: (profileId: string) => Promise<boolean>
  ): Promise<OpenProfileResult> {
    // Serialize all openProfile calls to prevent AdsPower "Too many request per second" errors
    const result = new Promise<OpenProfileResult>((resolve, reject) => {
      this._openMutex = this._openMutex.then(async () => {
        try {
          const r = await this._openProfileImpl(profileId, canForceClose);
          resolve(r);
        } catch (e) {
          reject(e);
        }
        // Small gap between sequential opens to stay under AdsPower rate limit
        await sleep(800);
      });
    });
    return result;
  }

  /**
   * Internal implementation of openProfile (not rate-limited).
   */
  private async _openProfileImpl(
    profileId: string,
    canForceClose?: (profileId: string) => Promise<boolean>
  ): Promise<OpenProfileResult> {
    // Guard: close stale profile before attempting to open
    const { active } = await this.checkProfile(profileId);
    if (active) {
      // Safety guard: check if another task still holds the lock
      if (canForceClose && !(await canForceClose(profileId))) {
        throw new Error(
          `[adspower] Profile ${profileId} is active and protected by another task's lock. ` +
          `Cannot force-close — will try a different profile.`
        );
      }
      console.warn(
        `[adspower] Profile ${profileId} is already active — force-closing before reopen`
      );
      await this.closeProfile(profileId);
      await sleep(1500); // brief pause so AdsPower releases the process
    }

    const url = this.buildUrl("/api/v1/browser/start", { user_id: profileId });

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      let json: {
        code: number;
        msg: string;
        data?: { ws?: { puppeteer?: string }; webdriver?: string };
      };

      try {
        const res = await this.fetchWithAuth(url);
        json = (await res.json()) as typeof json;
      } catch (networkErr) {
        const errMsg =
          networkErr instanceof Error ? networkErr.message : String(networkErr);
        if (attempt < this.config.maxRetries) {
          console.warn(
            `[adspower] openProfile attempt ${attempt} network error: ${errMsg}, retrying in ${this.config.retryDelayMs}ms`
          );
          await sleep(this.config.retryDelayMs);
          continue;
        }
        throw new Error(
          `[adspower] Failed to reach AdsPower API after ${this.config.maxRetries} attempts: ${errMsg}`
        );
      }

      if (json.code === 0 && json.data?.ws?.puppeteer) {
        return {
          debugUrl: json.data.ws.puppeteer,
          webdriver: json.data.webdriver ?? "",
        };
      }

      // Profile might still be launching — retry
      if (attempt < this.config.maxRetries) {
        // Auto force-close if AdsPower says profile is in use
        if (json.msg && (json.msg.includes("is being used") || json.msg.includes("not allowed to open"))) {
          console.warn(
            `[adspower] openProfile attempt ${attempt}: profile in use — force-closing before retry`
          );
          await this.closeProfile(profileId);
          await sleep(2000);
        } else {
          console.warn(
            `[adspower] openProfile attempt ${attempt} failed: ${json.msg}, retrying in ${this.config.retryDelayMs}ms`
          );
          await sleep(this.config.retryDelayMs);
        }
        continue;
      }

      throw new Error(
        `[adspower] Failed to open profile ${profileId} after ${this.config.maxRetries} attempts: ${json.msg}`
      );
    }

    // Should never reach here
    throw new Error("[adspower] Unexpected control flow");
  }

  /**
   * Stop a running browser profile.
   */
  async closeProfile(profileId: string): Promise<void> {
    const url = this.buildUrl("/api/v1/browser/stop", { user_id: profileId });

    try {
      const res = await this.fetchWithAuth(url);
      const json = (await res.json()) as { code: number; msg: string };

      if (json.code !== 0) {
        console.warn(
          `[adspower] closeProfile warning: ${json.msg} (code=${json.code})`
        );
      }
    } catch (err) {
      // Non-fatal: profile might have already closed or AdsPower is down
      console.warn(
        `[adspower] closeProfile network error:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Check if a profile's browser is currently active.
   */
  async checkProfile(
    profileId: string
  ): Promise<{ active: boolean; debugUrl?: string }> {
    const url = this.buildUrl("/api/v1/browser/active", { user_id: profileId });

    try {
      const res = await this.fetchWithAuth(url);
      const json = (await res.json()) as {
        code: number;
        msg: string;
        data?: { status: string; ws?: { puppeteer?: string } };
      };

      if (json.code !== 0) {
        return { active: false };
      }

      const active = json.data?.status === "Active";
      return {
        active,
        debugUrl: active ? json.data?.ws?.puppeteer : undefined,
      };
    } catch {
      // Network error — treat as inactive
      return { active: false };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
