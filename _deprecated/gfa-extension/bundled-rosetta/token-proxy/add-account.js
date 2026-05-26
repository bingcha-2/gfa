#!/usr/bin/env node
'use strict';

/**
 * Add a Google account via browser-based OAuth 2.0 login.
 *
 * Usage:
 *   node add-account.js
 *
 * Opens your browser to Google's OAuth consent screen.
 * After login, the refresh_token is saved to accounts.json.
 *
 * Flow: Google "Installed App" OAuth (loopback redirect)
 *   1. Start local HTTP server on random port
 *   2. Open browser to Google OAuth consent URL
 *   3. User logs in and grants access
 *   4. Google redirects to localhost with auth code
 *   5. Exchange code for refresh_token + access_token
 *   6. Save to accounts.json
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const {
    DEFAULT_OAUTH_CLIENT_ID,
    DEFAULT_OAUTH_CLIENT_SECRET,
    DEFAULT_OAUTH_PROFILE,
    DEFAULT_OAUTH_SCOPES,
} = require('./token-manager');

// Polyfill global fetch for Node.js < 18 (e.g. Antigravity embedded Node)
if (typeof globalThis.fetch !== 'function') {
    globalThis.fetch = function nodeFetch(url, opts = {}) {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const transport = parsed.protocol === 'https:' ? https : http;
            const req = transport.request(
                {
                    hostname: parsed.hostname,
                    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                    path: `${parsed.pathname}${parsed.search}`,
                    method: opts.method || 'GET',
                    headers: opts.headers || {},
                },
                (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => {
                        const body = Buffer.concat(chunks).toString('utf8');
                        resolve({
                            ok: res.statusCode >= 200 && res.statusCode < 300,
                            status: res.statusCode,
                            statusText: res.statusMessage || '',
                            headers: res.headers,
                            text: () => Promise.resolve(body),
                            json: () => Promise.resolve(JSON.parse(body)),
                        });
                    });
                }
            );
            req.on('error', reject);
            req.setTimeout(30000, () => req.destroy(new Error('fetch timeout')));
            if (opts.body) req.write(opts.body);
            req.end();
        });
    };
}

// OAuth credentials extracted from the Antigravity Language Server binary.
const OAUTH_CLIENT_ID = DEFAULT_OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = DEFAULT_OAUTH_CLIENT_SECRET;

// Scopes used by current Antigravity desktop auth.
const OAUTH_SCOPES = DEFAULT_OAUTH_SCOPES;

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const paths = require('../shared/paths');
const ACCOUNTS_FILE = path.resolve(paths.accountsPath());
const PROXY_CONFIG_FILE = path.resolve(paths.configPath());
const DEFAULT_PROXY_PORT = 60670;

/**
 * Generate a cryptographic random state nonce for CSRF protection.
 */
function generateState() {
    return crypto.randomBytes(16).toString('hex');
}

/**
 * Generate PKCE (Proof Key for Code Exchange) challenge/verifier pair.
 */
function generatePKCE() {
    const verifier = crypto.randomBytes(32)
        .toString('base64url')
        .replace(/[^a-zA-Z0-9\-._~]/g, '')
        .substring(0, 128);

    const challenge = crypto
        .createHash('sha256')
        .update(verifier)
        .digest('base64url');

    return { verifier, challenge };
}

/**
 * Open a URL in the default browser (cross-platform).
 */
function openBrowser(url) {
    const platform = process.platform;
    try {
        if (platform === 'win32') {
            execSync(`start "" "${url}"`, { windowsHide: true });
        } else if (platform === 'darwin') {
            execSync(`open "${url}"`);
        } else {
            execSync(`xdg-open "${url}"`);
        }
    } catch {
        console.log('\nCould not open browser automatically. Please open this URL manually:');
        console.log(url);
    }
}

/**
 * Start a local HTTP server, open the browser for OAuth, wait for callback.
 * Returns the authorization code.
 */
function waitForAuthCode(state, pkce) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, `http://127.0.0.1`);

            if (url.pathname !== '/callback') {
                res.writeHead(404);
                res.end('Not Found');
                return;
            }

            const code = url.searchParams.get('code');
            const returnedState = url.searchParams.get('state');
            const error = url.searchParams.get('error');

            if (error) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<html><body><h2>❌ Login failed</h2><p>${error}</p><p>You can close this tab.</p></body></html>`);
                server.close();
                reject(new Error(`OAuth error: ${error}`));
                return;
            }

            if (returnedState !== state) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<html><body><h2>❌ Invalid state</h2><p>CSRF check failed.</p></body></html>');
                server.close();
                reject(new Error('State mismatch - possible CSRF attack'));
                return;
            }

            if (!code) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<html><body><h2>❌ No authorization code</h2></body></html>');
                server.close();
                reject(new Error('No authorization code received'));
                return;
            }

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
                <html><body style="font-family:sans-serif;text-align:center;padding:60px;">
                <h2>✅ Login successful!</h2>
                <p>Account has been added. You can close this tab.</p>
                </body></html>
            `);

            const callbackPort = server.address().port;
            server.close();
            resolve({ code, port: callbackPort });
        });

        // Listen on random port
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            const redirectUri = `http://127.0.0.1:${port}/callback`;

            const authUrl = new URL(GOOGLE_AUTH_URL);
            authUrl.searchParams.set('client_id', OAUTH_CLIENT_ID);
            authUrl.searchParams.set('redirect_uri', redirectUri);
            authUrl.searchParams.set('response_type', 'code');
            authUrl.searchParams.set('scope', OAUTH_SCOPES.join(' '));
            authUrl.searchParams.set('state', state);
            authUrl.searchParams.set('access_type', 'offline');
            authUrl.searchParams.set('prompt', 'consent');
            authUrl.searchParams.set('code_challenge', pkce.challenge);
            authUrl.searchParams.set('code_challenge_method', 'S256');

            console.log(`\nLocal callback server listening on port ${port}`);
            console.log('Opening browser for Google login...\n');
            openBrowser(authUrl.toString());
        });

        server.on('error', reject);

        // Timeout after 5 minutes
        setTimeout(() => {
            server.close();
            reject(new Error('Timeout: no login within 5 minutes'));
        }, 5 * 60 * 1000);
    });
}

/**
 * Exchange the authorization code for tokens.
 */
async function exchangeCodeForTokens(code, redirectPort, pkceVerifier) {
    const redirectUri = `http://127.0.0.1:${redirectPort}/callback`;

    const params = new URLSearchParams({
        code,
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: pkceVerifier,
    });

    const response = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Token exchange failed: ${response.status} ${errorBody}`);
    }

    return response.json();
}

/**
 * Get the user's email from the access token.
 */
async function getUserEmail(accessToken) {
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
        return null;
    }

    const data = await response.json();
    return data.email || null;
}

const DEFAULT_CLOUD_ENDPOINT = 'https://daily-cloudcode-pa.sandbox.googleapis.com';

/**
 * Discover projectId for an account right after login.
 */
async function discoverProject(accessToken) {
    try {
        const response = await fetch(`${DEFAULT_CLOUD_ENDPOINT}/v1internal:onboardUser`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ tierId: 'standard-tier' }),
        });

        if (!response.ok) return null;

        let data = await response.json();

        // Handle LRO (Long Running Operation) — only poll if not already done
        if (data.name && !data.done) {
            for (let i = 0; i < 5; i++) {
                await new Promise(r => setTimeout(r, 2000));
                const opRes = await fetch(`${DEFAULT_CLOUD_ENDPOINT}/${data.name}`, {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                });
                if (!opRes.ok) break;
                const opData = await opRes.json();
                if (opData.done) {
                    data = opData;
                    break;
                }
            }
        }

        // Extract project from response (may be nested under .response for LRO)
        const payload = data.response || data;
        const project = payload?.cloudaicompanionProject;
        if (!project || Object.keys(project).length === 0) return null;

        const projectId = project.projectId || project.project || project.id || project.name || '';
        if (!projectId) return null;

        // Fetch plan type via loadCodeAssist API
        const planType = await fetchPlanType(accessToken, projectId);
        return { projectId, planType, source: 'onboardUser' };
    } catch (e) {
        return null;
    }
}

/**
 * Fetch plan type using the loadCodeAssist API.
 * Multi-level fallback aligned with Antigravity-Manager (quota.rs):
 *   1. paidTier.name (Google One AI Premium etc.)
 *   2. currentTier.name (if account is NOT ineligible for free-tier)
 *   3. allowedTiers default tier (marked as "Restricted")
 * Uses minimal metadata for accurate tier detection.
 */
async function fetchPlanType(accessToken, projectId) {
    try {
        const payload = {
            metadata: { ideType: 'ANTIGRAVITY' },
        };

        const response = await fetch(`${DEFAULT_CLOUD_ENDPOINT}/v1internal:loadCodeAssist`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'User-Agent': 'antigravity/1.99.0 google-api-nodejs-client/10.3.0',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) return '';

        const data = await response.json();

        // Multi-level fallback for tier extraction (matches Antigravity-Manager logic)
        // 1. Paid Tier (Google One AI Premium etc.)
        let subscriptionTier = data.paidTier?.name || data.paidTier?.id || '';

        if (!subscriptionTier) {
            const isIneligible = Array.isArray(data.ineligibleTiers) && data.ineligibleTiers.length > 0;

            if (!isIneligible) {
                // 2. Current Tier (only if account is NOT marked ineligible)
                subscriptionTier = data.currentTier?.name || data.currentTier?.id || '';
            } else {
                // 3. Account is ineligible for free-tier; fallback to allowedTiers default
                const allowed = data.allowedTiers || [];
                const defaultTier = allowed.find(t => t.isDefault === true);
                if (defaultTier) {
                    subscriptionTier = (defaultTier.name || defaultTier.id || '') + ' (Restricted)';
                }
            }
        }

        // Normalize to canonical plan names
        const raw = String(subscriptionTier).toLowerCase();
        if (raw.includes('ultra')) return 'ultra';
        if (raw.includes('premium') || raw.includes('ai pro') || raw.includes('helium')) return 'premium';
        if (raw.includes('standard')) return 'standard';
        if (raw.includes('restricted')) return 'standard-restricted';
        if (raw.includes('free')) return 'free';

        return subscriptionTier || '';
    } catch {
        return '';
    }
}

/**
 * Save account to accounts.json.
 */
function saveAccount(account) {
    let data = { accounts: [] };
    if (fs.existsSync(ACCOUNTS_FILE)) {
        try {
            data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
            if (!Array.isArray(data.accounts)) data.accounts = [];
        } catch { /* ignore */ }
    }

    // Check if account already exists
    const existing = data.accounts.find((a) => a.email === account.email);
    if (existing) {
        existing.refreshToken = account.refreshToken;
        existing.enabled = true;
        existing.oauthProfile = account.oauthProfile || DEFAULT_OAUTH_PROFILE;
        if (account.projectId) {
            existing.projectId = account.projectId;
            existing.projectIdSource = account.projectIdSource || 'discovered';
        }
        if (account.planType) {
            existing.planType = account.planType;
        }
        console.log(`Updated existing account: ${account.email}`);
    } else {
        const id = data.accounts.length > 0
            ? Math.max(...data.accounts.map((a) => a.id || 0)) + 1
            : 1;
        const nextAccount = {
            id,
            email: account.email,
            refreshToken: account.refreshToken,
            enabled: true,
            alias: '',
            oauthProfile: account.oauthProfile || DEFAULT_OAUTH_PROFILE,
        };
        if (account.projectId) {
            nextAccount.projectId = account.projectId;
            nextAccount.projectIdSource = account.projectIdSource || 'discovered';
        }
        if (account.planType) {
            nextAccount.planType = account.planType;
        }
        data.accounts.push(nextAccount);
        console.log(`Added new account #${data.accounts.length}: ${account.email}`);
    }

    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2), 'utf8');
    console.log(`Saved to: ${ACCOUNTS_FILE}`);
}

function readProxyPort() {
    if (!fs.existsSync(PROXY_CONFIG_FILE)) {
        return DEFAULT_PROXY_PORT;
    }

    try {
        const raw = fs.readFileSync(PROXY_CONFIG_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        const configured = Number(parsed.tokenProxyPort);
        return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_PROXY_PORT;
    } catch {
        return DEFAULT_PROXY_PORT;
    }
}

function postLocalStatus(route, timeoutMs = 45000) {
    const statusPort = readProxyPort() + 1;

    return new Promise((resolve) => {
        const req = http.request(
            {
                hostname: '127.0.0.1',
                port: statusPort,
                path: route,
                method: 'POST',
                timeout: timeoutMs,
            },
            (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8');
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        resolve({
                            ok: false,
                            statusCode: res.statusCode,
                            body,
                        });
                        return;
                    }

                    try {
                        resolve({
                            ok: true,
                            statusCode: res.statusCode,
                            body,
                            data: body ? JSON.parse(body) : {},
                        });
                    } catch {
                        resolve({
                            ok: true,
                            statusCode: res.statusCode,
                            body,
                            data: {},
                        });
                    }
                });
            }
        );

        req.on('timeout', () => {
            req.destroy(new Error('timeout'));
        });
        req.on('error', (error) => {
            resolve({ ok: false, error });
        });
        req.end();
    });
}

async function notifyRunningProxy() {
    const reloadResult = await postLocalStatus('/reload-accounts');
    if (!reloadResult.ok) {
        return {
            ok: false,
            stage: 'reload',
            error: reloadResult.error || new Error(`HTTP ${reloadResult.statusCode || 0}`),
        };
    }

    const refreshResult = await postLocalStatus('/refresh-quota');
    if (!refreshResult.ok) {
        return {
            ok: false,
            stage: 'refresh',
            error: refreshResult.error || new Error(`HTTP ${refreshResult.statusCode || 0}`),
        };
    }

    return {
        ok: true,
        reload: reloadResult.data || {},
        refresh: refreshResult.data || {},
    };
}

/**
 * Main flow.
 */
async function main() {
    console.log('=== Antigravity Rosetta — Add Google Account ===\n');
    console.log('This will open your browser to log in with a Google account.');
    console.log('The refresh token will be saved to accounts.json.\n');

    const state = generateState();
    const pkce = generatePKCE();

    try {
        const { code, port } = await waitForAuthCode(state, pkce);
        console.log('Authorization code received. Exchanging for tokens...');

        const tokens = await exchangeCodeForTokens(code, port, pkce.verifier);

        if (!tokens.refresh_token) {
            console.error('\nWARNING: No refresh_token returned.');
            console.error('This usually means the account was already authorized.');
            console.error('Try revoking access at https://myaccount.google.com/permissions');
            console.error('then run this script again.\n');
        }

        const email = await getUserEmail(tokens.access_token);
        if (!email) {
            console.error('Could not determine the account email.');
            process.exit(1);
        }

        console.log(`\nLogged in as: ${email}`);
        console.log(`Token type: ${tokens.token_type}`);
        console.log(`Expires in: ${tokens.expires_in}s`);
        console.log(`Refresh token: ${tokens.refresh_token ? 'Yes' : 'No'}`);

        if (tokens.refresh_token) {
            // Try to discover projectId immediately
            console.log('\nDiscovering project ID...');
            const projectInfo = await discoverProject(tokens.access_token, email);

            saveAccount({
                email,
                refreshToken: tokens.refresh_token,
                projectId: projectInfo?.projectId || '',
                projectIdSource: projectInfo?.source || '',
                planType: projectInfo?.planType || '',
                oauthProfile: DEFAULT_OAUTH_PROFILE,
            });

            const proxyUpdate = await notifyRunningProxy();
            console.log('\n✅ Account added successfully!');
            const refreshedAccounts =
                Array.isArray(proxyUpdate?.refresh?.status?.accounts)
                    ? proxyUpdate.refresh.status.accounts
                    : [];
            const refreshedAccount = refreshedAccounts.find((acc) => acc.email === email);
            const refreshedProjectId = refreshedAccount?.projectId || projectInfo?.projectId || '';

            if (refreshedProjectId) {
                console.log(`   Project: ${refreshedProjectId}`);
            } else {
                console.log('   还没拿到项目号。启动代理后会继续补齐。');
            }

            if (proxyUpdate.ok) {
                console.log('   运行中的代理已同步新账号，并已开始刷新额度。');
            } else {
                console.log('   运行中的代理未同步成功。重启代理或点一次“刷新额度”即可。');
            }
            console.log('Run this script again to add more accounts.');
        } else {
            console.log('\n❌ Cannot save without a refresh_token.');
        }
    } catch (error) {
        console.error('\nError:', error.message);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    discoverProject,
    fetchPlanType,
    notifyRunningProxy,
    readProxyPort,
};
