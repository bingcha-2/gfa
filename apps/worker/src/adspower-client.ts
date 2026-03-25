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

  constructor(config?: Partial<AdsPowerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Build URL with query params */
  private buildUrl(path: string, params: Record<string, string> = {}): string {
    const url = new URL(path, this.config.baseUrl);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    return url.toString();
  }

  /** Fetch with optional Bearer auth header */
  private fetchWithAuth(url: string, init?: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }
    return fetch(url, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string>) } });
  }

  /**
   * Start a browser profile.
   * Returns the CDP debug URL for Playwright connection.
   */
  async openProfile(profileId: string): Promise<OpenProfileResult> {
    const url = this.buildUrl("/api/v1/browser/start", { serial_number: profileId });

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
        console.warn(
          `[adspower] openProfile attempt ${attempt} failed: ${json.msg}, retrying in ${this.config.retryDelayMs}ms`
        );
        await sleep(this.config.retryDelayMs);
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
    const url = this.buildUrl("/api/v1/browser/stop", { serial_number: profileId });

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
    const url = this.buildUrl("/api/v1/browser/active", { serial_number: profileId });

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
