#!/usr/bin/env node
'use strict';

/**
 * Temporary refill proxy entry point.
 *
 * Default mode:
 *   token-passthrough
 *   Antigravity -> local passthrough -> Remote Token Server -> Google Cloud Code
 *
 * Legacy mode:
 *   openai-relay
 *   Antigravity -> local relay -> OpenAI-compatible upstream such as bcai.online
 */

const fs = require('fs');
const path = require('path');

const { createTokenPassthroughServer } = require('./token-passthrough');
const { startServer: startLegacyOpenAiRelay } = require('./server');

function getAppDataDir() {
  if (process.platform === 'win32') return process.env.APPDATA || '';
  if (process.platform === 'darwin') {
    return process.env.HOME ? path.join(process.env.HOME, 'Library', 'Application Support') : '';
  }
  return process.env.XDG_CONFIG_HOME || (process.env.HOME ? path.join(process.env.HOME, '.config') : '');
}

function readJsonFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(stripped.trim() || '{}');
  } catch {
    return {};
  }
}

function resolveConfigPath() {
  const rootDir = path.resolve(__dirname, '..');
  try {
    const centralPaths = require(path.join(rootDir, 'shared', 'paths'));
    if (typeof centralPaths.configPath === 'function') {
      return centralPaths.configPath();
    }
  } catch { /* fallback */ }

  const parentConfig = path.join(rootDir, 'proxy.config.json');
  if (fs.existsSync(parentConfig)) return parentConfig;

  const appData = getAppDataDir();
  if (appData) {
    const appDataConfig = path.join(appData, 'Antigravity', 'rosetta', 'proxy.config.json');
    if (fs.existsSync(appDataConfig)) return appDataConfig;
  }

  return parentConfig;
}

function main() {
  const configPath = resolveConfigPath();
  const config = readJsonFile(configPath);
  const relay = config.relayProxy || {};

  const tokenProxyPort = Number(config.tokenProxyPort || 60670);
  const proxyPort = Number(process.env.RELAY_PROXY_PORT) || Number(relay.port) || tokenProxyPort;
  const statusPort = Number(process.env.RELAY_STATUS_PORT) || (Number(relay.port) ? Number(relay.port) + 1 : 60681);
  const mode = String(relay.mode || 'token-passthrough').trim();

  console.log(`[relay] Config: ${configPath}`);
  console.log(`[relay] Mode: ${mode}`);
  console.log(`[relay] Port: ${proxyPort} (status: ${statusPort})`);

  if (mode === 'openai-relay' || mode === 'legacy-openai-relay') {
    const upstream = String(relay.upstream || 'https://bcai.online').trim();
    const apiKey = String(relay.apiKey || '').trim();
    const defaultModel = String(config.antigravityModel || '').trim();
    if (!apiKey) {
      console.error('[relay] No API key configured in proxy.config.json -> relayProxy.apiKey');
      console.error('[relay] The legacy proxy will start but all requests will fail until a key is set.');
    }
    console.log(`[relay] Legacy upstream: ${upstream}`);
    console.log(`[relay] API Key: ${apiKey ? `${apiKey.slice(0, 8)}...` : '(not set)'}`);
    startLegacyOpenAiRelay({ proxyPort, statusPort, upstream, apiKey, defaultModel });
    return;
  }

  const tokenServerUrl = String(relay.tokenServerUrl || '').trim();
  const tokenServerSecret = String(relay.tokenServerSecret || relay.apiKey || '').trim();
  if (!tokenServerUrl) {
    console.error('[relay] No token server configured -> relayProxy.tokenServerUrl');
    console.error('[relay] Set relayProxy.tokenServerUrl to your Remote Token Server.');
  }
  console.log(`[relay] Token Server: ${tokenServerUrl || '(not set)'}`);
  console.log(`[relay] Secret: ${tokenServerSecret ? '(configured)' : '(not set)'}`);

  createTokenPassthroughServer({
    proxyPort,
    statusPort,
    tokenServerUrl,
    tokenServerSecret,
    clientId: relay.clientId,
    cloudEndpoint: config.googleCloudEndpoint,
  }).start();
}

main();
