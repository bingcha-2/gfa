import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createMockUpstream } from './server.mjs';

test('operator provisioning, replay, credential isolation, messages and usage', async () => {
  const server = createMockUpstream();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const ops = { 'content-type': 'application/json', 'x-api-key': 'test-operator-only' };
  const account = 'test+claude@example.test';
  const provision = (id, people = 1) => fetch(`${base}/teamclaude/ops/tools/provision_private_keys`, {
    method: 'POST', headers: ops, body: JSON.stringify({ account, people, requestId: id }),
  });
  try {
    const first = await (await provision('test-order-0001')).json();
    assert.equal(first.ok, true);
    const replay = await (await provision('test-order-0001')).json();
    assert.equal(replay.result.replayed, true);
    assert.deepEqual(replay.result.keys, first.result.keys);
    assert.equal((await provision('test-order-0001', 2)).status, 400);
    assert.equal((await provision('test-order-0002')).status, 400);
    assert.equal((await fetch(`${base}/v1/models`, { headers: ops })).status, 401);
    const headers = { authorization: `Bearer ${first.result.keys[0]}`, 'content-type': 'application/json' };
    assert.equal((await fetch(`${base}/teamclaude/ops/account-key-usage?account=${encodeURIComponent(account)}`, { headers })).status, 401);
    const models = await (await fetch(`${base}/v1/models`, { headers })).json();
    for (const stream of [false, true]) {
      const response = await fetch(`${base}/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ model: models.data[0].id, stream, max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] }) });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.match(text, /GFA mock upstream OK/);
      if (stream) assert.match(text, /event: message_stop/);
    }
    const count = await fetch(`${base}/v1/messages/count_tokens`, { method: 'POST', headers, body: '{}' });
    assert.equal((await count.json()).input_tokens, 12);
    const usage = await (await fetch(`${base}/teamclaude/ops/account-key-usage?${new URLSearchParams({ account })}`, { headers: ops })).json();
    assert.equal(usage[0].boundAccount, account);
    assert.equal(usage[0].usage.requests, 2);
    assert.equal(usage[0].usage.inputTokens, 24);
    assert.equal(usage[0].usage.outputTokens, 8);
    assert.ok(!JSON.stringify(usage).includes(first.result.keys[0]));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
