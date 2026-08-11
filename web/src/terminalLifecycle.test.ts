import assert from 'node:assert/strict';
import { test } from 'node:test';
import { terminalOperationCompleted } from './terminalLifecycle';

test('reports a terminal operation that settles before its timeout', async () => {
  assert.equal(await terminalOperationCompleted(Promise.resolve(), 20), true);
});

test('reports a terminal operation that stalls through its timeout', async () => {
  assert.equal(await terminalOperationCompleted(new Promise<never>(() => undefined), 5), false);
});

test('propagates a failed terminal operation instead of treating it as rendered', async () => {
  await assert.rejects(terminalOperationCompleted(Promise.reject(new Error('renderer failed')), 20), /renderer failed/);
});
