import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { PiBridge } from '../../src/server/piBridge.js';
import { sessionDetailFromManager } from '../../src/server/sessions.js';

const usage = {
  input: 10, output: 2, cacheRead: 30, cacheWrite: 4, totalTokens: 46,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
};

test('preserves pi system and usage entries through session detail and SDK restoration', () => {
  const manager = SessionManager.inMemory(process.cwd());
  const systemId = manager.appendMessage({
    role: 'system', content: '', sections: { preamble: 'Initial instructions' },
    toolsAdded: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
    timestamp: 1,
  });
  const userId = manager.appendMessage({ role: 'user', content: 'Hello', timestamp: 2 });
  const patchId = manager.appendMessage({
    role: 'system', content: '', sections: { preamble: 'Updated instructions' },
    toolsRemoved: [{ name: 'read' }], timestamp: 3,
  });
  const { id: usageId } = manager.appendUsage('future_usage_kind', 'test-provider', 'test-model', usage);
  const detail = sessionDetailFromManager('/tmp/pi-web-sdk-session.jsonl', manager);

  assert.equal(detail.leafId, usageId);
  assert.deepEqual(detail.entries.map(({ id, parentId }) => ({ id, parentId })), [
    { id: systemId, parentId: null },
    { id: userId, parentId: systemId },
    { id: patchId, parentId: userId },
    { id: usageId, parentId: patchId },
  ]);
  const restored = SessionManager.inMemory(process.cwd(), { id: manager.getSessionId() }, JSON.parse(JSON.stringify(detail.entries)));
  assert.deepEqual(restored.getEntries(), manager.getEntries());
  assert.deepEqual(restored.buildSessionContext(), manager.buildSessionContext());
  assert.equal(restored.buildSessionContext().messages.some((message) => 'kind' in message), false);
});

test('status fallback includes pi usage entries without depending on their kind', () => {
  const manager = SessionManager.inMemory(process.cwd());
  manager.appendMessage({
    role: 'assistant', content: [{ type: 'text', text: 'Done' }],
    api: 'openai-completions', provider: 'test-provider', model: 'test-model',
    stopReason: 'stop', timestamp: 1, usage,
  });
  manager.appendUsage('cache_warm', 'test-provider', 'test-model', usage);
  manager.appendUsage('future_usage_kind', 'test-provider', 'test-model', usage);

  const bridge = new PiBridge();
  const status = (bridge as any).agentStatus({ sessionManager: manager });
  assert.deepEqual(status.usage, {
    input: 30, output: 6, cacheRead: 90, cacheWrite: 12, total: 138, cost: 3, subscription: false,
  });
});
