// Local test fixture only: no production keys, accounts, or upstream traffic.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function createMockUpstream() {
  const receipts = new Map();
  const accounts = new Map();
  const keys = new Map();
  const operatorKey = 'test-operator-only';
  const model = 'claude-sonnet-4-6';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (url.pathname.startsWith('/teamclaude/')) {
        if (req.headers['x-api-key'] !== operatorKey) return send(401, { ok: false, error: 'operator authentication required' });
        if (req.method === 'GET' && url.pathname === '/teamclaude/ops/account-key-usage') {
          const account = accounts.get(url.searchParams.get('account'));
          return send(200, account ? account.keys.map(key => {
            const state = keys.get(key);
            return {
              name: state.name, configured: true, enabled: true, storage: 'hash', pool: 'private',
              boundAccount: state.account, quotaShare: state.share,
              share: { account: state.account, bound: true, limit: state.share, windows: Object.fromEntries(['5h', '7d'].map(w => [w, {
                used: 0, confirmed: 0, estimated: 0, left: state.share, remaining: 1,
                resetAt: account.resetAt[w], freshness: 'fresh', readingAt: Date.now(), ageMs: 0,
                reserved: 0, inFlight: 0, uncertain: false, accountUsed: 0,
              }])) },
              usage: { requests: state.requests, inputTokens: state.requests * 12, outputTokens: state.requests * 4 },
            };
          }) : []);
        }
        if (req.method !== 'POST' || url.pathname !== '/teamclaude/ops/tools/provision_private_keys') return send(404, { ok: false, error: 'not found' });
        const body = await readBody(req);
        const { account, people, requestId, accountId } = body;
        if (typeof account !== 'string' || !account || !Number.isInteger(people) || people < 1 || people > 100 || typeof requestId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.:_-]{7,127}$/.test(requestId)) return send(400, { ok: false, error: 'invalid account, people or requestId' });
        const previous = receipts.get(requestId);
        if (previous) {
          if (previous.account !== account || previous.people !== people || (accountId && accountId !== previous.accountId)) return send(400, { ok: false, error: 'request_id_conflict' });
          return send(200, { ok: true, result: { ...previous, replayed: true } });
        }
        if (accounts.has(account)) return send(400, { ok: false, error: 'private_keys_already_exist' });
        const result = {
          account, accountId: accountId || randomUUID(), people, requestId, pool: 'private', quotaShare: 1 / people,
          receiptExpiresAt: Date.now() + 86400000, replayed: false, appliesOn: 'live', clients: [], keys: [],
        };
        for (let i = 0; i < people; i++) {
          const key = `tc-test-${randomUUID()}`;
          const name = `private-test-${randomUUID()}`;
          result.keys.push(key); result.clients.push(name);
          keys.set(key, { name, account, share: 1 / people, requests: 0 });
        }
        accounts.set(account, { keys: result.keys, resetAt: { '5h': Date.now() + 18000000, '7d': Date.now() + 604800000 } });
        receipts.set(requestId, result);
        return send(200, { ok: true, result });
      }
      const key = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.headers['x-api-key'];
      const state = keys.get(key);
      if (!state) return send(401, { type: 'error', error: { type: 'authentication_error', message: 'test inference key required' } });
      if (req.method === 'GET' && url.pathname === '/v1/models') return send(200, { data: [{ id: model, type: 'model', display_name: model }], has_more: false });
      if (req.method !== 'POST') return send(404, { error: 'not found' });
      const body = await readBody(req);
      if (url.pathname === '/v1/messages/count_tokens') return send(200, { input_tokens: 12 });
      if (url.pathname !== '/v1/messages') return send(404, { error: 'not found' });
      if (body.model !== model) return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'unsupported test model' } });
      state.requests++;
      const message = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'GFA mock upstream OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 4 } };
      if (!body.stream) return send(200, message);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const events = [
        { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: message.content[0].text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
        { type: 'message_stop' },
      ];
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    } catch {
      if (!res.headersSent) send(400, { ok: false, error: 'invalid request' });
      else res.end();
    }
  });
  return server;
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new Error('body too large');
  }
  return JSON.parse(body);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createMockUpstream();
  server.listen(Number(process.env.MOCK_UPSTREAM_PORT || 4319), '127.0.0.1', () => {
    console.log(`Mock upstream listening on http://127.0.0.1:${server.address().port}; operator credential: test-operator-only (fixture only)`);
  });
}
