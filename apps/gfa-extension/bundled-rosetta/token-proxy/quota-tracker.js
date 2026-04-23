'use strict';

/**
 * Quota tracker and automatic account rotation engine.
 * Monitors 429 responses, manages cooldowns, selects best available account.
 */

const DEFAULT_COOLDOWN_MS = 60 * 1000;
const DEFAULT_CHECK_INTERVAL_MS = 30 * 1000;
const MAX_BLOCK_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours max block per account
const INITIAL_BLOCK_MS = 90 * 1000; // 90s short block before async quota verification
const RECENT_WINDOW_SIZE = 50; // Rolling window for success rate calculation

function createQuotaTracker(config) {
    const {
        tokenManager,
        log = console.log,
        cooldownMs = DEFAULT_COOLDOWN_MS,
    } = config;

    let activeAccountId = null;
    let cooldownCheckTimer = null;
    const inFlightByAccount = new Map();
    const inFlightByModel = new Map();

    // Per-account request stats for quality tracking
    const accountStats = new Map();

    function ensureStats(accountId) {
        const id = Number(accountId);
        if (!accountStats.has(id)) {
            accountStats.set(id, { total: 0, successes: 0, failures: 0, recentOutcomes: [] });
        }
        return accountStats.get(id);
    }

    function recordOutcome(accountId, success) {
        const stats = ensureStats(accountId);
        stats.total++;
        if (success) { stats.successes++; } else { stats.failures++; }
        stats.recentOutcomes.push(success);
        if (stats.recentOutcomes.length > RECENT_WINDOW_SIZE) stats.recentOutcomes.shift();
    }

    function getSuccessRate(accountId) {
        const stats = accountStats.get(Number(accountId));
        if (!stats || stats.recentOutcomes.length < 5) return null;
        return stats.recentOutcomes.filter(Boolean).length / stats.recentOutcomes.length;
    }

    function getQualityTier(accountId) {
        const rate = getSuccessRate(accountId);
        if (rate === null) return 'new';
        if (rate >= 0.8) return 'excellent';
        if (rate >= 0.5) return 'good';
        if (rate >= 0.2) return 'poor';
        return 'bad';
    }

    function normalizeModelKey(value) {
        return String(value || '').trim();
    }

    function shouldLogBalanceDecision(modelKey) {
        return !/^tab_/i.test(normalizeModelKey(modelKey));
    }

    function isAccountBlockedForModel(account, modelKey, now = Date.now()) {
        const targetModelKey = normalizeModelKey(modelKey);
        const blockedModels = Array.isArray(account?.blockedModels) ? account.blockedModels : [];

        if (!targetModelKey) {
            const blockedUntil = Number(account?.blockedUntil || 0);
            return blockedModels.length === 0 && blockedUntil > now;
        }

        const blocked = blockedModels.find((item) => normalizeModelKey(item?.modelKey) === targetModelKey);
        if (blocked) {
            return Number(blocked.blockedUntil || 0) > now || Number(blocked.blockedUntil || 0) === 0;
        }

        return false;
    }

    function getAccountBlockDetails(account, modelKey, now = Date.now()) {
        const targetModelKey = normalizeModelKey(modelKey);
        const blockedModels = Array.isArray(account?.blockedModels) ? account.blockedModels : [];

        if (targetModelKey) {
            const blocked = blockedModels.find((item) =>
                normalizeModelKey(item?.modelKey) === targetModelKey
            );
            if (!blocked) {
                return null;
            }
            const blockedUntil = Number(blocked.blockedUntil || 0);
            if (blockedUntil > now || blockedUntil === 0) {
                return {
                    reason: String(blocked.reason || account?.quotaStatusReason || '').trim(),
                    blockedUntil,
                };
            }
            return null;
        }

        const blockedUntil = Number(account?.blockedUntil || 0);
        if (blockedUntil > now || blockedUntil === 0) {
            return {
                reason: String(account?.quotaStatusReason || '').trim(),
                blockedUntil,
            };
        }

        return null;
    }

    function describeRotationReason(reason) {
        return String(reason || '').trim() || 'rotate';
    }

    function formatRetryAfter(retryAfterMs) {
        const ms = Number(retryAfterMs || 0);
        if (ms <= 0) {
            return '';
        }
        if (ms < 1000) {
            return ' for <1s';
        }
        return ` for ${Math.ceil(ms / 1000)}s`;
    }

    function getInFlightCount(accountId) {
        return Number(inFlightByAccount.get(Number(accountId)) || 0);
    }

    function getInFlightCountForModel(accountId, modelKey) {
        const targetModelKey = normalizeModelKey(modelKey);
        if (!targetModelKey) {
            return 0;
        }
        const modelMap = inFlightByModel.get(targetModelKey);
        return Number(modelMap?.get(Number(accountId)) || 0);
    }

    function reserveAccount(accountId, modelKey = '') {
        const targetId = Number(accountId);
        const targetModelKey = normalizeModelKey(modelKey);
        inFlightByAccount.set(targetId, getInFlightCount(targetId) + 1);
        if (targetModelKey) {
            const modelMap = inFlightByModel.get(targetModelKey) || new Map();
            modelMap.set(targetId, getInFlightCountForModel(targetId, targetModelKey) + 1);
            inFlightByModel.set(targetModelKey, modelMap);
        }
        return {
            accountId: targetId,
            modelKey: targetModelKey,
            released: false,
        };
    }

    function releaseReservation(reservation) {
        if (!reservation || reservation.released) {
            return;
        }

        reservation.released = true;
        const targetId = Number(reservation.accountId);
        const targetModelKey = normalizeModelKey(reservation.modelKey);

        const nextAccountCount = Math.max(0, getInFlightCount(targetId) - 1);
        if (nextAccountCount > 0) {
            inFlightByAccount.set(targetId, nextAccountCount);
        } else {
            inFlightByAccount.delete(targetId);
        }

        if (!targetModelKey) {
            return;
        }

        const modelMap = inFlightByModel.get(targetModelKey);
        if (!modelMap) {
            return;
        }

        const nextModelCount = Math.max(0, getInFlightCountForModel(targetId, targetModelKey) - 1);
        if (nextModelCount > 0) {
            modelMap.set(targetId, nextModelCount);
        } else {
            modelMap.delete(targetId);
        }

        if (modelMap.size === 0) {
            inFlightByModel.delete(targetModelKey);
        }
    }

    function compareAccountLoad(left, right, preferredAccountId, modelKey) {
        const leftModelLoad = getInFlightCountForModel(left.id, modelKey);
        const rightModelLoad = getInFlightCountForModel(right.id, modelKey);
        if (leftModelLoad !== rightModelLoad) {
            return leftModelLoad - rightModelLoad;
        }

        const leftTotalLoad = getInFlightCount(left.id);
        const rightTotalLoad = getInFlightCount(right.id);
        if (leftTotalLoad !== rightTotalLoad) {
            return leftTotalLoad - rightTotalLoad;
        }

        // Prefer accounts with higher success rate
        const leftRate = getSuccessRate(left.id);
        const rightRate = getSuccessRate(right.id);
        if (leftRate !== null && rightRate !== null && Math.abs(leftRate - rightRate) > 0.15) {
            return rightRate - leftRate; // Higher success rate = preferred
        }

        // Prefer accounts with higher remaining quota for this model
        const targetModelKey = normalizeModelKey(modelKey);
        if (targetModelKey) {
            const leftFraction = Number(left.modelQuotaFractions?.[targetModelKey] ?? 1);
            const rightFraction = Number(right.modelQuotaFractions?.[targetModelKey] ?? 1);
            if (Math.abs(leftFraction - rightFraction) > 0.05) {
                return rightFraction - leftFraction; // Higher remaining = preferred
            }
        }

        const leftPreferred = left.id === preferredAccountId ? 0 : 1;
        const rightPreferred = right.id === preferredAccountId ? 0 : 1;
        if (leftPreferred !== rightPreferred) {
            return leftPreferred - rightPreferred;
        }

        return Number(left.lastUsedAt || 0) - Number(right.lastUsedAt || 0);
    }

    function getEligibleAccounts(options = {}) {
        const {
            modelKey = '',
            requireProjectId = false,
            includeActive = true,
        } = options;
        const targetModelKey = normalizeModelKey(modelKey);
        const now = Date.now();
        return tokenManager.listAccounts().filter((account) => {
            if (!account.enabled || account.quotaStatus === 'error') {
                return false;
            }
            if (!includeActive && account.id === activeAccountId) {
                return false;
            }
            if (requireProjectId && !account.projectId) {
                return false;
            }
            return !isAccountBlockedForModel(account, targetModelKey, now);
        });
    }

    function getModelAvailability(options = {}) {
        const {
            modelKey = '',
            requireProjectId = false,
        } = options;
        const targetModelKey = normalizeModelKey(modelKey);
        const now = Date.now();
        const candidates = tokenManager.listAccounts().filter((account) =>
            account.enabled &&
            account.quotaStatus !== 'error' &&
            (!requireProjectId || account.projectId)
        );

        const availableAccounts = candidates.filter((account) =>
            !isAccountBlockedForModel(account, targetModelKey, now)
        );

        if (availableAccounts.length > 0) {
            return {
                available: true,
                reason: '',
                modelKey: targetModelKey,
                nextRetryAfterMs: 0,
                nextRetryAt: 0,
                totalCandidates: candidates.length,
                blockedCandidates: 0,
            };
        }

        let nextRetryAt = 0;
        let reason = '';
        let blockedCandidates = 0;

        for (const account of candidates) {
            const block = getAccountBlockDetails(account, targetModelKey, now);
            if (!block) {
                continue;
            }
            blockedCandidates += 1;
            const blockedUntil = Number(block.blockedUntil || 0);
            if (blockedUntil > now && (!nextRetryAt || blockedUntil < nextRetryAt)) {
                nextRetryAt = blockedUntil;
                reason = String(block.reason || '').trim();
                continue;
            }
            if (!reason) {
                reason = String(block.reason || '').trim();
            }
        }

        return {
            available: false,
            reason,
            modelKey: targetModelKey,
            nextRetryAt,
            nextRetryAfterMs: nextRetryAt > now ? Math.max(1, nextRetryAt - now) : 0,
            totalCandidates: candidates.length,
            blockedCandidates,
        };
    }

    function selectAccountForRequest(options = {}) {
        const targetModelKey = normalizeModelKey(options.modelKey);
        const requireProjectId = options.requireProjectId === true;
        const balanceLoad = options.balanceLoad === true;

        if (activeAccountId === null) {
            throw new Error('No active account. Run: node add-account.js');
        }

        const allAccounts = tokenManager.listAccounts();
        const activeAccount = allAccounts.find((account) => account.id === activeAccountId);
        const activeUsable = Boolean(activeAccount) &&
            activeAccount.enabled &&
            activeAccount.quotaStatus !== 'error' &&
            (!requireProjectId || Boolean(activeAccount.projectId)) &&
            !isAccountBlockedForModel(activeAccount, targetModelKey);

        if (!activeUsable) {
            const rotated = rotateToNext(activeAccount ? 'blocked' : 'removed', {
                modelKey: targetModelKey,
                allowBlockedFallback: false,
            });
            if (!rotated) {
                throw new Error(
                    targetModelKey
                        ? `No available accounts for ${targetModelKey}`
                        : 'No available accounts.'
                );
            }
        }

        if (!balanceLoad || !targetModelKey) {
            return activeAccountId;
        }

        const eligibleAccounts = getEligibleAccounts({
            modelKey: targetModelKey,
            requireProjectId,
            includeActive: true,
        });
        if (eligibleAccounts.length <= 1) {
            return activeAccountId;
        }

        eligibleAccounts.sort((left, right) =>
            compareAccountLoad(left, right, activeAccountId, targetModelKey)
        );
        const selected = eligibleAccounts[0];
        if (selected && selected.id !== activeAccountId && shouldLogBalanceDecision(targetModelKey)) {
            log(
                `[quota-tracker] Balanced ${targetModelKey} → #${selected.id} (${selected.email})`
            );
        }
        return selected?.id || activeAccountId;
    }

    function init() {
        const accounts = tokenManager.listAccounts().filter((account) => account.enabled);
        const preferred = accounts.find((account) => account.projectId) || accounts[0] || null;
        if (preferred) {
            activeAccountId = preferred.id;
            log(
                `[quota-tracker] Active account: #${activeAccountId}` +
                (preferred.projectId ? ` (project=${preferred.projectId})` : ' (pass-through mode)')
            );
        } else {
            log('[quota-tracker] No enabled accounts');
        }
        cooldownCheckTimer = setInterval(recoverCooledAccounts, DEFAULT_CHECK_INTERVAL_MS);
    }

    function getActiveAccountId() { return activeAccountId; }

    function setActiveAccount(accountId, reason = 'manual') {
        const targetId = Number(accountId);
        const account = tokenManager.getAccount(targetId);
        if (!account) {
            throw new Error(`Account #${accountId} not found`);
        }
        if (!account.enabled) {
            throw new Error(`Account #${accountId} is disabled`);
        }

        activeAccountId = targetId;
        log(`[quota-tracker] Switched → #${activeAccountId} (${account.email}) [${reason}]`);
        return {
            accountId: account.id,
            email: account.email,
        };
    }

    async function getActiveToken(options = {}) {
        const targetAccountId = selectAccountForRequest(options);
        const account = tokenManager.getAccount(targetAccountId);
        if (!account) {
            if (!rotateToNext('removed', {
                modelKey: options.modelKey,
                allowBlockedFallback: false,
            })) {
                throw new Error('No available accounts.');
            }
            return getActiveToken(options);
        }
        const reservation = options.trackInFlight
            ? reserveAccount(targetAccountId, options.modelKey)
            : null;
        try {
            const token = await tokenManager.getAccessToken(targetAccountId);
            return {
                token,
                accountId: targetAccountId,
                email: account.email,
                projectId: account.projectId || '',
                canRotate: Boolean(account.projectId),
                reservation,
            };
        } catch (error) {
            releaseReservation(reservation);
            log(`[quota-tracker] Token error #${targetAccountId}: ${error.message}`);
            tokenManager.markError(targetAccountId);
            if (targetAccountId === activeAccountId && rotateToNext('token_error', {
                modelKey: options.modelKey,
                allowBlockedFallback: false,
            })) {
                return getActiveToken(options);
            }
            throw error;
        }
    }

    function reportSuccess(accountId, details = {}) {
        recordOutcome(accountId, true);
        tokenManager.markSuccess(accountId, details);
    }

    function reportQuotaExhausted(accountId, details = {}) {
        const rawRetryAfterMs = Number(details.retryAfterMs || 0);
        const retryAfterMs = rawRetryAfterMs > 0
            ? Math.min(rawRetryAfterMs, MAX_BLOCK_DURATION_MS)
            : 0;
        if (rawRetryAfterMs > MAX_BLOCK_DURATION_MS) {
            log(
                `[quota-tracker] #${accountId} retryAfter capped: ` +
                `${Math.ceil(rawRetryAfterMs / 60000)}m → ${Math.ceil(retryAfterMs / 60000)}m`
            );
        }
        const reason = String(details.reason || 'quota').trim() || 'quota';
        const reasonLabel = reason === 'capacity' ? 'capacity limited' : 'quota exhausted';

        // Use short initial block; async verification will extend if truly exhausted
        const serverSuggestedMs = retryAfterMs > 0 ? retryAfterMs : cooldownMs;
        const useShortBlock = serverSuggestedMs > INITIAL_BLOCK_MS && Boolean(details.modelKey);
        const effectiveBlockMs = useShortBlock ? INITIAL_BLOCK_MS : serverSuggestedMs;
        const nextBlockedUntil = Date.now() + effectiveBlockMs;

        recordOutcome(accountId, false);
        tokenManager.markExhausted(accountId, {
            ...details,
            blockedUntil: nextBlockedUntil,
        });
        log(
            `[quota-tracker] #${accountId} ${reasonLabel}` +
            (details.modelKey ? ` (${details.modelKey})` : '') +
            ` block=${Math.ceil(effectiveBlockMs / 1000)}s` +
            (useShortBlock ? ` (server=${Math.ceil(serverSuggestedMs / 1000)}s, verifying...)` : '') +
            ', rotating...'
        );

        // Async verification: if server suggested a long block, check actual quota
        if (useShortBlock) {
            verifyAndAdjustBlock(accountId, details.modelKey, serverSuggestedMs, reason)
                .catch((err) => log(`[quota-tracker] verify error #${accountId}: ${err.message}`));
        }

        if (accountId === activeAccountId) {
            return rotateToNext(describeRotationReason(reason), {
                modelKey: details.modelKey,
                allowBlockedFallback: false,
            });
        }
        return true;
    }

    async function verifyAndAdjustBlock(accountId, modelKey, serverSuggestedMs, reason) {
        // Wait before verification to let transient rate limits clear
        await new Promise((r) => setTimeout(r, 3000));

        if (typeof tokenManager.verifyModelQuota !== 'function') {
            return;
        }

        const account = tokenManager.getAccount(accountId);
        const email = account?.email || `#${accountId}`;
        const result = await tokenManager.verifyModelQuota(accountId, modelKey);

        if (!result) {
            log(`[quota-tracker] ${email} quota verification inconclusive for ${modelKey}`);
            return;
        }

        if (result.hasQuota) {
            log(
                `[quota-tracker] ${email} FALSE 429 for ${modelKey} ` +
                `(remaining=${result.remainingFraction}), unblocking`
            );
            tokenManager.markSuccess(accountId, { modelKey });
            return;
        }

        // Truly exhausted — extend block to server's suggested duration
        log(
            `[quota-tracker] ${email} CONFIRMED exhausted for ${modelKey}, ` +
            `extending block to ${Math.ceil(serverSuggestedMs / 60000)}m`
        );
        tokenManager.markExhausted(accountId, {
            modelKey,
            reason,
            blockedUntil: Date.now() + serverSuggestedMs,
        });
    }

    function reportError(accountId) {
        recordOutcome(accountId, false);
        tokenManager.markError(accountId);
    }

    /**
     * Report a stream hang (upstream stopped sending data mid-stream).
     * Records failure for quality tracking and rotates to a different account
     * so the IDE's automatic retry uses a fresh account.
     */
    function reportStreamHang(accountId) {
        recordOutcome(accountId, false);
        const account = tokenManager.getAccount(accountId);
        log(`[quota-tracker] #${accountId} (${account?.email || '?'}) stream hang, rotating for retry`);
        if (accountId === activeAccountId) {
            rotateToNext('stream_hang', { allowBlockedFallback: false });
        }
    }

    /**
     * Rotate to next available account. Strategy: LRU among 'ok' accounts,
     * fallback to longest-cooled 'exhausted' account.
     */
    function rotateToNext(reason, options = {}) {
        const allAccounts = tokenManager.listAccounts();
        const targetModelKey = normalizeModelKey(options.modelKey);
        const allowBlockedFallback = options.allowBlockedFallback !== false;
        const now = Date.now();

        const candidates = allAccounts.filter((a) =>
            a.enabled && a.id !== activeAccountId && a.quotaStatus !== 'error' && a.projectId
        );

        const eligibleCandidates = candidates.filter((account) =>
            !isAccountBlockedForModel(account, targetModelKey, now)
        );

        const okCandidates = eligibleCandidates.filter((a) => a.quotaStatus === 'ok');
        if (okCandidates.length > 0) {
            okCandidates.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
            activeAccountId = okCandidates[0].id;
            log(`[quota-tracker] Rotated → #${activeAccountId} (${okCandidates[0].email}) [${reason}]`);
            return true;
        }

        const reusableExhausted = eligibleCandidates.filter((a) => a.quotaStatus === 'exhausted');
        if (reusableExhausted.length > 0) {
            reusableExhausted.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
            activeAccountId = reusableExhausted[0].id;
            log(`[quota-tracker] Rotated exhausted → #${activeAccountId} (${reusableExhausted[0].email}) [${reason}]`);
            return true;
        }

        if (allowBlockedFallback) {
            const exhausted = candidates.filter((a) => a.quotaStatus === 'exhausted');
            if (exhausted.length > 0) {
                activeAccountId = exhausted[0].id;
                log(`[quota-tracker] All exhausted, force-rotated → #${activeAccountId} [${reason}]`);
                return true;
            }
        }

        if (targetModelKey) {
            log(`[quota-tracker] No accounts available for ${targetModelKey}`);
            return false;
        }
        log('[quota-tracker] No accounts to rotate to');
        return false;
    }

    function recoverCooledAccounts() {
        const now = Date.now();
        for (const acc of tokenManager.listAccounts()) {
            if (acc.quotaStatus === 'exhausted') {
                // Delegate per-model block cleanup to token-manager
                tokenManager.recoverExpiredBlocks(acc.id, now, cooldownMs);
            }
        }
    }


    function getStatus() {
        const accounts = tokenManager.listAccounts();
        return {
            activeAccountId,
            activeEmail: accounts.find((a) => a.id === activeAccountId)?.email || null,
            totalAccounts: accounts.length,
            rotatableAccounts: accounts.filter((a) => a.projectId).length,
            okAccounts: accounts.filter((a) => a.quotaStatus === 'ok').length,
            exhaustedAccounts: accounts.filter((a) => a.quotaStatus === 'exhausted').length,
            errorAccounts: accounts.filter((a) => a.quotaStatus === 'error').length,
            accounts: accounts.map((a) => {
                const stats = ensureStats(a.id);
                const successRate = getSuccessRate(a.id);
                const qualityTier = getQualityTier(a.id);
                return {
                    id: a.id, email: a.email, quotaStatus: a.quotaStatus,
                    quotaStatusReason: a.quotaStatusReason,
                    isActive: a.id === activeAccountId,
                    accessTokenExpiresIn: a.accessTokenExpiresIn,
                    projectId: a.projectId,
                    planType: a.planType || '',
                    alias: a.alias || '',
                    enabled: a.enabled,
                    canRotate: Boolean(a.projectId),
                    blockedUntil: a.blockedUntil,
                    blockedModels: Array.isArray(a.blockedModels) ? a.blockedModels : [],
                    successRate: successRate !== null ? Math.round(successRate * 100) : null,
                    qualityTier,
                    requestStats: { total: stats.total, successes: stats.successes, failures: stats.failures },
                };
            }),
        };
    }

    function destroy() {
        if (cooldownCheckTimer) { clearInterval(cooldownCheckTimer); cooldownCheckTimer = null; }
        inFlightByAccount.clear();
        inFlightByModel.clear();
        accountStats.clear();
    }

    return {
        init, getActiveAccountId, getActiveToken,
        reportSuccess, reportQuotaExhausted, reportError, reportStreamHang,
        releaseReservation, rotateToNext, setActiveAccount, getStatus, getModelAvailability, destroy,
    };
}

module.exports = { createQuotaTracker };
