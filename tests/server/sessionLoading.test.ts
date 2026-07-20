import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import { buildApp } from '../../src/server/app.js';
import { sessionDetailFromManager } from '../../src/server/sessions.js';

test('session detail sends flat entries without duplicating the active branch or tree', () => {
  const entries = [
    { type: 'message', id: 'root', parentId: null },
    { type: 'message', id: 'leaf', parentId: 'root' },
  ];
  const manager = {
    getEntries: () => entries,
    getLeafId: () => 'leaf',
    getHeader: () => ({ id: 'session-uuid', type: 'session' }),
    getSessionName: () => 'Large session',
  } as unknown as Parameters<typeof sessionDetailFromManager>[1];

  const detail = sessionDetailFromManager('/tmp/session-loading-test.jsonl', manager);

  assert.strictEqual(detail.entries, entries);
  assert.equal(detail.leafId, 'leaf');
  assert.equal('branch' in detail, false);
  assert.equal('tree' in detail, false);
});

test('server compresses large JSON responses when the client accepts gzip', async (t) => {
  const app = await buildApp({
    host: '127.0.0.1',
    port: 0,
    dev: true,
    logMode: 'silent',
    expose: false,
    basePath: '/',
  });
  app.get('/api/compression-probe', async () => ({ text: 'session-data-'.repeat(1_000) }));
  await app.ready();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/api/compression-probe',
    headers: { 'accept-encoding': 'gzip' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-encoding'], 'gzip');
  assert.match(gunzipSync(response.rawPayload).toString('utf8'), /session-data-/);
});
