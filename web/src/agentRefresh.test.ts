import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StaleAgentStatusError, isCurrentAgentStatusTarget, shouldRetryAgentRefresh, shouldSuppressAgentUiRequests, withRequestTimeout } from './agentRefresh';

test('times out a hung refresh and allows a fresh attempt to succeed', async () => {
  await assert.rejects(
    withRequestTimeout(() => new Promise(() => undefined), undefined, 5),
    (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
  );
  assert.equal(await withRequestTimeout(async () => 'ok', undefined, 50), 'ok');
});

test('rejects a pre-aborted caller even when the request ignores its signal', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('Already left', 'AbortError'));

  await assert.rejects(
    withRequestTimeout(() => new Promise<Response>(() => undefined), controller.signal, 100),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
});

test('forwards caller cancellation', async () => {
  const controller = new AbortController();
  const request = withRequestTimeout((signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), controller.signal, 50);
  controller.abort();
  await assert.rejects(request, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
});

test('suppresses UI requests only for a newer stopped status', () => {
  assert.equal(shouldSuppressAgentUiRequests(1, 1, { running: false }), false);
  assert.equal(shouldSuppressAgentUiRequests(1, 2, { running: false }), true);
  assert.equal(shouldSuppressAgentUiRequests(1, 2, { running: true }), false);
});

test('accepts status for a command-owned session before route selection', () => {
  assert.equal(isCurrentAgentStatusTarget('project-1', 'session-1', 'project-1', undefined, true), true);
  assert.equal(isCurrentAgentStatusTarget('project-1', 'session-1', 'project-1', undefined, false), false);
  assert.equal(isCurrentAgentStatusTarget('project-1', 'session-1', 'project-2', undefined, true), false);
  assert.equal(isCurrentAgentStatusTarget('project-1', 'session-1', 'project-1', 'session-1', false, false), false);
});

test('retries timeouts once but not cancellation or stale status', () => {
  assert.equal(shouldRetryAgentRefresh(0, new DOMException('timed out', 'TimeoutError')), true);
  assert.equal(shouldRetryAgentRefresh(1, new DOMException('timed out', 'TimeoutError')), false);
  assert.equal(shouldRetryAgentRefresh(0, new DOMException('cancelled', 'AbortError')), false);
  assert.equal(shouldRetryAgentRefresh(0, new StaleAgentStatusError()), false);
});
