/**
 * server.js — HTTP server for the relay-proxy.
 *
 * Routes:
 *   POST /v1beta/models/*:streamGenerateContent  → streaming translation
 *   POST /v1beta/models/*:generateContent         → non-streaming translation
 *   GET  /status                                   → status endpoint (on statusPort)
 *
 * Listens on two ports:
 *   - proxyPort (60680): receives Gemini requests from Antigravity IDE
 *   - statusPort (60681): status endpoint for the VS Code extension
 */

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const { extractModelFromPath, resolveModel } = require('./model-map');
const { translateRequest } = require('./translate-req');
const { createSSETranslator, translateNonStreamingResponse } = require('./translate-res');

/**
 * Start the relay-proxy server.
 * @param {object} config
 * @param {number} config.proxyPort - Port to listen on for Gemini requests (default 60680)
 * @param {number} config.statusPort - Port for status endpoint (default proxyPort+1)
 * @param {string} config.upstream - Upstream API base URL (e.g. "https://bcai.online")
 * @param {string} config.apiKey - API key for upstream
 */
function startServer(config) {
  const proxyPort = config.proxyPort || 60680;
  const statusPort = config.statusPort || (proxyPort + 1);
  const upstream = (config.upstream || 'https://bcai.online').replace(/\/+$/, '');
  const apiKey = config.apiKey || '';
  const defaultModel = config.defaultModel || '';

  // Stats
  const stats = {
    startedAt: new Date().toISOString(),
    totalRequests: 0,
    totalErrors: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    lastRequestAt: null,
    lastError: null,
  };

  const fs = require('fs');
  const path = require('path');
  const relayLogFile = path.join(__dirname, '../../../../logs/relay-proxy.log');

  function log(msg) {
    const ts = new Date().toISOString().slice(11, 23);  // HH:MM:SS.mmm
    const line = `[${ts}] [relay] ${msg}`;
    console.log(line);
    try {
      fs.mkdirSync(path.dirname(relayLogFile), { recursive: true });
      fs.appendFileSync(relayLogFile, line + '\n');
    } catch { /* ignore */ }
  }

  // Log startup info
  log(`=== Relay Proxy Started ===`);
  log(`upstream=${upstream} proxyPort=${proxyPort} statusPort=${statusPort}`);
  log(`apiKey=${apiKey ? apiKey.slice(0, 12) + '...(len=' + apiKey.length + ')' : '(NOT SET - all requests will fail!)'}`);
  log(`defaultModel=${defaultModel || '(none, will use claude-sonnet-4-6)'}`);
  log(`node=${process.version} pid=${process.pid}`);

  // ─── Main proxy server ────────────────────────────────────────────────

  const proxyServer = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-goog-api-key',
      });
      res.end();
      return;
    }

    const url = new URL(req.url, `http://127.0.0.1:${proxyPort}`);
    const pathname = url.pathname;
    const reqId = `R${stats.totalRequests + 1}`;
    
    // Log full request details
    log(`[${reqId}] ← ${req.method} ${pathname}`);
    log(`[${reqId}] Headers: ${JSON.stringify({ 
      'content-type': req.headers['content-type'],
      'authorization': req.headers['authorization'] ? req.headers['authorization'].slice(0,20)+'...' : '(none)',
      'x-goog-api-key': req.headers['x-goog-api-key'] ? req.headers['x-goog-api-key'].slice(0,12)+'...' : '(none)',
    })}`);
    log(`[${reqId}] RemoteAddr: ${req.socket.remoteAddress}:${req.socket.remotePort}`);

    // Health check
    if (req.method === 'GET' && (pathname === '/' || pathname === '/health')) {
      log(`[${reqId}] → 200 health check`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mode: 'relay' }));
      return;
    }

    // ─── Detect real AI requests FIRST ─────────────────────────────────────
    // CRITICAL: The IDE sends chat requests to BOTH formats:
    //   1. /v1beta/models/{model}:streamGenerateContent  (standard Gemini)
    //   2. /v1internal:streamGenerateContent              (internal path)
    // We MUST detect these BEFORE the v1internal catch-all mock below,
    // otherwise real AI requests get silently swallowed with empty 200.
    const isStream = pathname.includes(':streamGenerateContent') || url.searchParams.get('alt') === 'sse';
    const isGenerate = pathname.includes(':generateContent') || isStream;
    const isModelRequest = req.method === 'POST' && (pathname.includes('/models/') || isGenerate);

    // ─── IDE internal API mocks ───────────────────────────────────────────
    // The IDE (Antigravity/Jetski) sends these internal requests to whatever
    // URL is configured as cloudCodeUrl. We mock them so the IDE initializes
    // successfully without hitting Google's servers directly.
    // NOTE: This section only handles NON-generate requests.

    if (!isGenerate) {
      // loadCodeAssist — IDE checks plan/tier info on startup
      if (pathname.includes(':loadCodeAssist')) {
        log(`[${reqId}] [MOCK] loadCodeAssist → stub response`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          currentTier: { name: 'STANDARD' },
          nextTier: null,
          codeAssistProjectName: 'relay-mode',
          userState: 'ONBOARDED',
          currentUserTier: { name: 'STANDARD' },
          featureSet: {},
        }));
        return;
      }

      // onboardUser — IDE calls this on first use to register the user
      if (pathname.includes(':onboardUser')) {
        log(`[${reqId}] [MOCK] onboardUser → stub response`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ userState: 'ONBOARDED' }));
        return;
      }

      // fetchAvailableModels — IDE fetches model list
      if (pathname.includes(':fetchAvailableModels') || pathname.includes('fetchAvailableModels')) {
        log(`[${reqId}] [MOCK] fetchAvailableModels → stub response`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [] }));
        return;
      }

      // Any other v1internal:* or v1beta non-model requests — acknowledge silently
      if (pathname.includes('v1internal') || pathname.includes(':countTokens')) {
        log(`[${reqId}] [MOCK] ${pathname} → empty 200`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
        return;
      }

      // Not a model request and not an internal API — 404
      if (req.method !== 'POST') {
        log(`[${reqId}] → 404 (not a model request: method=${req.method})`);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      log(`[${reqId}] → 400 (unsupported action in path: ${pathname})`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unsupported action' }));
      return;
    }

    // ─── From here on, it's a real generate/stream request ────────────────

    // Check API key
    if (!apiKey) {
      log(`[${reqId}] → 500 (API key not configured! Set relayProxy.apiKey in proxy.config.json)`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Relay proxy API key not configured' }));
      return;
    }

    stats.totalRequests++;
    stats.lastRequestAt = new Date().toISOString();

    // Read request body
    let body = '';
    try {
      body = await readBody(req);
    } catch (err) {
      stats.totalErrors++;
      stats.lastError = 'Failed to read request body';
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read request body' }));
      return;
    }

    let geminiBody;
    try {
      geminiBody = JSON.parse(body);
    } catch {
      stats.totalErrors++;
      stats.lastError = 'Invalid JSON in request body';
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }
    // Extract model name:
    // 1. From URL path: /v1beta/models/{model}:streamGenerateContent
    // 2. From request body: geminiBody.model (IDE may include it)
    // 3. From proxy config: antigravityModel setting
    // 4. Fallback: empty string → resolveModel will use default
    let antigravityModel = extractModelFromPath(pathname);
    if (!antigravityModel && geminiBody.model) {
      antigravityModel = String(geminiBody.model);
    }
    if (!antigravityModel) {
      // Use the configured default model from proxy.config.json
      if (defaultModel) antigravityModel = defaultModel;
    }
    const upstreamModel = resolveModel(antigravityModel);
    log(`[${reqId}] → model: ${antigravityModel || '(auto)'} → ${upstreamModel} (${isStream ? 'stream' : 'sync'})`);
    log(`[${reqId}] → upstream: ${upstream}/v1/chat/completions`);
    log(`[${reqId}] → apiKey: ${apiKey.slice(0, 12)}...(len=${apiKey.length})`);
    // Log body structure (non-sensitive)
    try {
      const bodyPreview = {
        contentsCount: Array.isArray(geminiBody.contents) ? geminiBody.contents.length : 'N/A',
        systemInstruction: geminiBody.systemInstruction ? 'present' : 'absent',
        generationConfig: geminiBody.generationConfig ? Object.keys(geminiBody.generationConfig).join(',') : 'absent',
      };
      log(`[${reqId}] → body preview: ${JSON.stringify(bodyPreview)}`);
    } catch { /* ignore */ }

    // Translate Gemini → OpenAI
    const openaiBody = translateRequest(geminiBody, upstreamModel, isStream);

    // Forward to upstream
    const forwardStart = Date.now();
    try {
      if (isStream) {
        await forwardStreaming(upstream, apiKey, openaiBody, upstreamModel, res, stats, log);
      } else {
        await forwardNonStreaming(upstream, apiKey, openaiBody, upstreamModel, res, stats, log);
      }
      log(`[${reqId}] ✓ completed in ${Date.now() - forwardStart}ms`);
    } catch (err) {
      // Ignore benign abort/reset errors (client disconnected after stream done)
      const errMsg = err.message || String(err);
      if (errMsg === 'aborted' || err.code === 'ECONNRESET') {
        log(`[${reqId}] client disconnected (${errMsg}), ignoring`);
        return;
      }

      stats.totalErrors++;
      stats.lastError = errMsg;
      log(`[${reqId}] ✗ Error (${Date.now() - forwardStart}ms): ${errMsg}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { code: 502, message: `Upstream error: ${stats.lastError}`, status: 'UNAVAILABLE' },
        }));
      } else {
        try { res.end(); } catch { /* ignore */ }
      }
    }
  });

  // ─── Status server ────────────────────────────────────────────────────

  const statusServer = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({
      running: true,
      mode: 'relay',
      upstream,
      hasApiKey: Boolean(apiKey),
      ...stats,
    }));
  });

  // ─── Start listening ──────────────────────────────────────────────────

  proxyServer.listen(proxyPort, '127.0.0.1', () => {
    log(`Proxy listening on http://127.0.0.1:${proxyPort}`);
  });

  statusServer.listen(statusPort, '127.0.0.1', () => {
    log(`Status listening on http://127.0.0.1:${statusPort}`);
  });

  // Graceful shutdown
  function shutdown() {
    log('Shutting down...');
    proxyServer.close();
    statusServer.close();
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { proxyServer, statusServer };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
    // 60s timeout for large requests
    req.setTimeout(60000, () => reject(new Error('Request read timeout')));
  });
}

/**
 * Forward a streaming request to the upstream and pipe translated SSE back.
 */
function forwardStreaming(upstream, apiKey, openaiBody, model, clientRes, stats, log) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(openaiBody);
    const target = new URL(`${upstream}/v1/chat/completions`);
    const isHttps = target.protocol === 'https:';
    const transport = isHttps ? https : http;

    let streamDone = false;

    const reqOptions = {
      method: 'POST',
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'Authorization': `Bearer ${apiKey}`,
      },
    };

    log(`→ [upstream] ${target.hostname}:${reqOptions.port}${reqOptions.path} (stream, ${bodyStr.length}B)`);
    log(`→ [upstream] Authorization: Bearer ${apiKey.slice(0, 12)}...(len=${apiKey.length})`);

    const upstreamReq = transport.request(reqOptions, (upstreamRes) => {
      const statusCode = upstreamRes.statusCode || 500;
      log(`← [upstream] HTTP ${statusCode} (stream)`);

      if (statusCode >= 400) {
        // Read error body and return as Gemini-format error
        const chunks = [];
        upstreamRes.on('data', c => chunks.push(c));
        upstreamRes.on('end', () => {
          const errBody = Buffer.concat(chunks).toString('utf8');
          log(`← [upstream] ERROR ${statusCode}: ${errBody.slice(0, 500)}`);
          stats.totalErrors++;
          stats.lastError = `Upstream ${statusCode}`;
          if (!clientRes.headersSent) {
            clientRes.writeHead(statusCode, { 'Content-Type': 'application/json' });
            // Try to wrap in Gemini error format
            try {
              const parsed = JSON.parse(errBody);
              clientRes.end(JSON.stringify({
                error: {
                  code: statusCode,
                  message: parsed.error?.message || parsed.message || errBody.slice(0, 500),
                  status: statusCode === 429 ? 'RESOURCE_EXHAUSTED' : 'INTERNAL',
                },
              }));
            } catch {
              clientRes.end(JSON.stringify({
                error: { code: statusCode, message: errBody.slice(0, 500), status: 'INTERNAL' },
              }));
            }
          }
          resolve();
        });
        return;
      }

      // Set up SSE response to client
      clientRes.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      // Create translator
      const translator = createSSETranslator(clientRes, model);

      upstreamRes.setEncoding('utf8');
      upstreamRes.on('data', (chunk) => {
        translator.processChunk(chunk);
      });

      upstreamRes.on('end', () => {
        streamDone = true;
        const usage = translator.getUsage();
        stats.totalInputTokens += usage.inputTokens;
        stats.totalOutputTokens += usage.outputTokens;
        log(`✓ ${model} done (in:${usage.inputTokens} out:${usage.outputTokens})`);
        translator.finish();
        resolve();
      });

      upstreamRes.on('error', (err) => {
        translator.finish();
        if (!streamDone) reject(err);
        else resolve(); // stream was already done, ignore late errors
      });
    });

    upstreamReq.on('error', (err) => {
      // Ignore abort errors after stream completed (client disconnect after done)
      if (err.message === 'aborted' || err.code === 'ECONNRESET') {
        resolve();
        return;
      }
      reject(err);
    });
    upstreamReq.setTimeout(300000, () => {
      upstreamReq.destroy(new Error('Upstream request timeout (5min)'));
    });

    // Handle client disconnect — only destroy upstream if stream isn't done
    clientRes.on('close', () => {
      if (!streamDone) upstreamReq.destroy();
    });

    upstreamReq.write(bodyStr);
    upstreamReq.end();
  });
}

/**
 * Forward a non-streaming request to the upstream.
 */
function forwardNonStreaming(upstream, apiKey, openaiBody, model, clientRes, stats, log) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(openaiBody);
    const target = new URL(`${upstream}/v1/chat/completions`);
    const isHttps = target.protocol === 'https:';
    const transport = isHttps ? https : http;

    const reqOptions = {
      method: 'POST',
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'Authorization': `Bearer ${apiKey}`,
      },
    };

    log(`→ [upstream] ${target.hostname}:${reqOptions.port}${reqOptions.path} (non-stream, ${bodyStr.length}B)`);
    log(`→ [upstream] Authorization: Bearer ${apiKey.slice(0, 12)}...(len=${apiKey.length})`);

    const upstreamReq = transport.request(reqOptions, (upstreamRes) => {
      const chunks = [];
      upstreamRes.on('data', c => chunks.push(c));
      upstreamRes.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const statusCode = upstreamRes.statusCode || 500;
        log(`← [upstream] HTTP ${statusCode} (non-stream, ${raw.length}B)`);

        if (statusCode >= 400) {
          stats.totalErrors++;
          stats.lastError = `Upstream ${statusCode}`;
          log(`← [upstream] ERROR body: ${raw.slice(0, 500)}`);
          clientRes.writeHead(statusCode, { 'Content-Type': 'application/json' });
          clientRes.end(raw);
          resolve();
          return;
        }

        try {
          const openaiResp = JSON.parse(raw);
          const geminiResp = translateNonStreamingResponse(openaiResp, model);
          const usage = openaiResp.usage || {};
          stats.totalInputTokens += usage.prompt_tokens || 0;
          stats.totalOutputTokens += usage.completion_tokens || 0;
          log(`✓ ${model} (non-stream) done`);
          clientRes.writeHead(200, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify(geminiResp));
        } catch (err) {
          stats.totalErrors++;
          stats.lastError = 'Failed to translate response';
          clientRes.writeHead(500, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify({ error: { code: 500, message: 'Translation error' } }));
        }
        resolve();
      });
    });

    upstreamReq.on('error', reject);
    upstreamReq.setTimeout(300000, () => {
      upstreamReq.destroy(new Error('Upstream request timeout (5min)'));
    });

    upstreamReq.write(bodyStr);
    upstreamReq.end();
  });
}

module.exports = { startServer };
