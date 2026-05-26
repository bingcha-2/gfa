'use strict';

// Active quota poller: proactively fetches model quota data for ALL accounts.
// For accounts without projectId, attempts API-based project discovery first.

const https = require('https');
const http = require('http');
const zlib = require('zlib');

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const REQUEST_TIMEOUT_MS = 15000;

function createQuotaPoller({ tokenManager, cloudEndpoint, log, pollIntervalMs }) {
    const interval = Number(pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS;
    let timer = null;
    let pollPromise = null;

    async function fetchModelsForAccount(acc) {
        let token;
        try {
            token = await tokenManager.getAccessToken(acc.id);
        } catch (error) {
            log(`[quota-poller] Failed to get token for ${acc.email}: ${error.message}`);
            return null;
        }

        if (!token || !acc.projectId) {
            return null;
        }

        // Build the request to fetchAvailableModels
        const endpoint = new URL(cloudEndpoint);
        const requestPath = '/v1internal:fetchAvailableModels';
        const requestBody = JSON.stringify({
            project: acc.projectId,
        });

        return new Promise((resolve) => {
            const transport = endpoint.protocol === 'https:' ? https : http;
            const options = {
                hostname: endpoint.hostname,
                port: endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80),
                path: requestPath,
                method: 'POST',
                headers: {
                    'authorization': `Bearer ${token}`,
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(requestBody),
                    'host': endpoint.host,
                    'user-agent': 'google-antigravity-ls/1.26.0',
                    'x-goog-api-client': 'gl-go/1.23.0 google-antigravity-ls/1.26.0',
                },
            };

            const req = transport.request(options, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    if (res.statusCode === 403) {
                        log(
                            `[quota-poller] ${acc.email}: 403 — token may lack cloud-platform scope. ` +
                            'Re-run: node add-account.js'
                        );
                        resolve(null);
                        return;
                    }

                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        log(`[quota-poller] ${acc.email}: HTTP ${res.statusCode}`);
                        resolve(null);
                        return;
                    }

                    try {
                        const rawBody = Buffer.concat(chunks);
                        const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
                        let text;
                        if (encoding.includes('gzip')) {
                            text = zlib.gunzipSync(rawBody).toString('utf8');
                        } else {
                            text = rawBody.toString('utf8');
                        }

                        if (text && text.includes('"models"')) {
                            resolve(text);
                        } else {
                            log(`[quota-poller] ${acc.email}: response has no models field`);
                            resolve(null);
                        }
                    } catch (error) {
                        log(`[quota-poller] ${acc.email}: decode error: ${error.message}`);
                        resolve(null);
                    }
                });
            });

            req.on('error', (error) => {
                log(`[quota-poller] ${acc.email}: request error: ${error.message}`);
                resolve(null);
            });

            req.setTimeout(REQUEST_TIMEOUT_MS, () => {
                req.destroy(new Error('timeout'));
            });

            req.write(requestBody);
            req.end();
        });
    }

    async function pollAll() {
        if (pollPromise) {
            return pollPromise;
        }

        pollPromise = (async () => {
            try {
                if (typeof tokenManager.loadAccounts === 'function') {
                    tokenManager.loadAccounts();
                }

                const accounts = tokenManager.listAccounts();
                const enabled = accounts.filter((acc) => acc.enabled);

                if (enabled.length === 0) {
                    log('[quota-poller] No enabled accounts, skipping poll');
                    return { updated: 0, total: 0 };
                }

                // Phase 1: Auto-discover projects for accounts without projectId
                const needsDiscovery = enabled.filter((acc) => !acc.projectId);
                if (needsDiscovery.length > 0) {
                    log(`[quota-poller] ${needsDiscovery.length} account(s) need project discovery...`);
                    for (const acc of needsDiscovery) {
                        try {
                            await tokenManager.discoverProjectViaApi(acc.id);
                        } catch (error) {
                            log(`[quota-poller] Discovery error for ${acc.email}: ${error.message}`);
                        }
                        await new Promise((r) => setTimeout(r, 500));
                    }
                }

                // Phase 2: Fetch plan types for accounts with projectId but no planType
                if (typeof tokenManager.autoFetchPlanTypes === 'function') {
                    try {
                        log(`[quota-poller] Phase 2: calling autoFetchPlanTypes...`);
                        const fetched = await tokenManager.autoFetchPlanTypes();
                        if (fetched > 0) {
                            log(`[quota-poller] Phase 2: fetched plan types for ${fetched} account(s)`);
                        }
                    } catch (error) {
                        log(`[quota-poller] Plan type fetch error: ${error.message}`);
                    }
                } else {
                    log(`[quota-poller] Phase 2: autoFetchPlanTypes not available (type=${typeof tokenManager.autoFetchPlanTypes})`);
                }

                // Phase 3: Fetch quota data for accounts WITH projectId
                // Re-read accounts since discovery may have updated projectIds
                const readyAccounts = tokenManager.listAccounts().filter(
                    (acc) => acc.enabled && acc.projectId
                );

                if (readyAccounts.length === 0) {
                    log('[quota-poller] No accounts with projectId, skipping quota fetch');
                    return { updated: 0, total: 0 };
                }


                let updated = 0;

                for (const acc of readyAccounts) {
                    try {
                        const modelsJson = await fetchModelsForAccount(acc);
                        if (modelsJson) {
                            tokenManager.updateProjectModels(acc.id, modelsJson);
                            updated++;
                        }
                    } catch (error) {
                        log(`[quota-poller] Error polling ${acc.email}: ${error.message}`);
                    }

                    // Stagger requests to avoid simultaneous API hits
                    await new Promise((r) => setTimeout(r, 500));
                }

                if (updated > 0) log(`[quota-poller] ${updated}/${readyAccounts.length} updated`);
                return { updated, total: readyAccounts.length };
            } catch (error) {
                log(`[quota-poller] Poll cycle error: ${error.message}`);
                return { updated: 0, total: 0, error: error.message };
            } finally {
                pollPromise = null;
            }
        })();

        return pollPromise;
    }

    function start() {
        if (timer) return;
        log(`[quota-poller] Starting active quota poller (interval: ${Math.round(interval / 1000)}s)`);
        // Run first poll after a short delay to let proxy fully initialize
        setTimeout(() => {
            void pollAll();
        }, 10000);
        timer = setInterval(() => {
            void pollAll();
        }, interval);
    }

    function stop() {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    }

    // Allow manual trigger
    function pollNow() {
        return pollAll();
    }

    return { start, stop, pollNow };
}

module.exports = { createQuotaPoller };
