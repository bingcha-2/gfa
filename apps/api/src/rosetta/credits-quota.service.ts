// Credits & quota refresh domain: bulk-refresh AI credits (GOOGLE_ONE_AI) and
// per-model quota for all enabled accounts via the upstream cloud APIs.
// Extracted from RosettaService — behavior-preserving (method bodies verbatim,
// this.dataDir/this.logger/this.tokenCache rebound to the shared RosettaContext,
// this.runConcurrent/this.tryDiscoverProject rebound to ./lib/project helpers).

import * as path from "path";

import {
  extractTierFromModelsJson,
  fetchAccountHealth,
  fetchAvailableModels,
  getAccessToken,
} from "./google-api";
import type { RosettaContext } from "./lib/context";
import { runConcurrent, tryDiscoverProject } from "./lib/project";
import { nowIso, readJson, writeJson } from "./lib/store";

export class CreditsQuotaService {
  constructor(private readonly ctx: RosettaContext) {}

  /**
   * Refresh AI credits (GOOGLE_ONE_AI) + planType for all enabled accounts.
   * Calls loadCodeAssist API for each account — mirrors token-manager.js:autoFetchPlanTypes().
   */
  async refreshCredits() {
    const filePath = path.join(this.ctx.dataDir, "accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts: any[] = Array.isArray(data.accounts) ? data.accounts : [];
    const enabled = accounts.filter((a) => a.enabled !== false && a.refreshToken);

    let refreshed = 0;
    let errors = 0;
    const results: any[] = [];

    await runConcurrent(enabled, 5, async (acc) => {
      try {
        // Auto-discover projectId if missing
        if (!acc.projectId) {
          await tryDiscoverProject(this.ctx, acc);
        }
        if (!acc.projectId) {
          results.push({ id: acc.id, email: acc.email, error: "no projectId" });
          errors++;
          return;
        }

        const token = await getAccessToken(
          Number(acc.id), acc.refreshToken, this.ctx.tokenCache, acc.proxyUrl,
        );
        const health = await fetchAccountHealth(token, acc.projectId, acc.email, undefined, acc.proxyUrl);

        // Update planType (detect upgrades)
        if (health.planType) {
          const oldPlan = acc.planType || "";
          if (oldPlan !== health.planType) {
            this.ctx.logger.log(`${acc.email}: plan ${oldPlan || "(empty)"} → ${health.planType}`);
            acc.planType = health.planType;
            // Plan upgrade → clear quota blocks
            if (oldPlan && oldPlan !== health.planType) {
              delete acc.quotaStatus;
              delete acc.quotaStatusReason;
              delete acc.exhaustedAt;
              delete acc.exhaustedUntil;
              acc.blockedModels = [];
              this.ctx.logger.log(`${acc.email}: plan upgrade, cleared blocks`);
            }
          }
        }

        refreshed++;
        results.push({
          id: acc.id,
          email: acc.email,
          planType: acc.planType || "",
        });
      } catch (err: any) {
        errors++;
        this.ctx.logger.warn(`refreshCredits ${acc.email}: ${err.message}`);
        results.push({ id: acc.id, email: acc.email, error: err.message });
      }
    });

    // Persist
    writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });

    return { ok: errors === 0, refreshed, errors, total: enabled.length, accounts: results };
  }

  /**
   * Refresh per-model quota (fetchAvailableModels) + credits for all enabled accounts.
   * Full refresh: Phase 1 discover projects, Phase 2+3 credits + model quota (concurrent).
   * Mirrors quota-poller.js:pollAll() + token-manager.js:autoFetchPlanTypes().
   */
  async refreshQuota() {
    const accountsFile = path.join(this.ctx.dataDir, "accounts.json");
    const data = readJson(accountsFile, { accounts: [] });
    const accounts: any[] = Array.isArray(data.accounts) ? data.accounts : [];
    const enabled = accounts.filter((a) => a.enabled !== false && a.refreshToken);

    // Phase 1: Auto-discover projectId for accounts that lack one
    const needsDiscovery = enabled.filter((a) => !a.projectId);
    if (needsDiscovery.length > 0) {
      this.ctx.logger.log(`Phase 1: discovering projects for ${needsDiscovery.length} account(s)...`);
      await runConcurrent(needsDiscovery, 3, (acc) => tryDiscoverProject(this.ctx, acc));
    }

    let refreshed = 0;
    let errors = 0;
    const results: any[] = [];

    // Iterate over ALL enabled accounts (not just the projectId-ready ones) so a dead
    // account — one that still has no projectId after discovery — is reported as a
    // FAILURE instead of silently vanishing from the counts. Previously these were
    // filtered out of `ready` and `total`, so the panel showed "刷新成功" while the
    // account was actually dead.
    await runConcurrent(enabled, 5, async (acc) => {
      // Dead account: project discovery failed → cannot fetch quota at all.
      if (!acc.projectId) {
        errors++;
        results.push({ id: acc.id, email: acc.email, error: "no projectId" });
        return;
      }
      try {
        const token = await getAccessToken(
          Number(acc.id), acc.refreshToken, this.ctx.tokenCache, acc.proxyUrl,
        );

        // Phase 2: planType via loadCodeAssist
        const health = await fetchAccountHealth(token, acc.projectId, acc.email, undefined, acc.proxyUrl);
        if (health.planType && health.planType !== acc.planType) {
          acc.planType = health.planType;
        }

        // Phase 3: Per-model quota via fetchAvailableModels
        const modelsResult = await fetchAvailableModels(token, acc.projectId, undefined, acc.proxyUrl);
        if (!modelsResult) {
          // Could not fetch quota → treat as a failure, surface it (don't hide).
          errors++;
          results.push({ id: acc.id, email: acc.email, error: "quota fetch failed" });
          return;
        }

        // Detect tier from models response
        const detectedTier = extractTierFromModelsJson(modelsResult.rawJson);
        if (detectedTier && detectedTier !== acc.planType) {
          this.ctx.logger.log(`${acc.email}: tier from models: ${acc.planType || "(empty)"} → ${detectedTier}`);
          acc.planType = detectedTier;
        }

        // Store per-model quota fractions + reset times on the account
        acc.modelQuotaFractions = {};
        acc.modelQuotaResetTimes = {};
        acc.modelQuotaRefreshedAt = Date.now();
        for (const [modelKey, info] of Object.entries(modelsResult.models)) {
          if (info.remainingFraction != null) {
            acc.modelQuotaFractions[modelKey] = info.remainingFraction;
          }
          if (info.resetTime) {
            acc.modelQuotaResetTimes[modelKey] = info.resetTime;
          }
        }

        // Auto-unblock models that now have quota
        if (Array.isArray(acc.blockedModels)) {
          acc.blockedModels = acc.blockedModels.filter((bm: any) => {
            if (bm.reason !== "quota") return true;
            const modelInfo = modelsResult.models[bm.modelKey];
            // Keep block if model still has 0 quota
            return !(modelInfo && modelInfo.remainingFraction != null && modelInfo.remainingFraction > 0);
          });
          if (acc.blockedModels.length === 0 && acc.quotaStatus === "exhausted") {
            acc.quotaStatus = "ok";
            delete acc.quotaStatusReason;
            delete acc.exhaustedAt;
            delete acc.exhaustedUntil;
          }
        }

        refreshed++;
        results.push({ id: acc.id, email: acc.email, planType: acc.planType || "" });
      } catch (err: any) {
        errors++;
        this.ctx.logger.warn(`refreshQuota ${acc.email}: ${err.message}`);
        results.push({ id: acc.id, email: acc.email, error: err.message });
      }
    });

    writeJson(accountsFile, { ...data, accounts, updatedAt: nowIso() });

    // ok reflects reality: a dead account (no projectId / quota fetch failed) makes the
    // refresh NOT fully successful. total counts every enabled account attempted, and
    // `accounts` lists per-account outcomes so the panel can show which ones died.
    return { ok: errors === 0, refreshed, errors, total: enabled.length, accounts: results };
  }
}
