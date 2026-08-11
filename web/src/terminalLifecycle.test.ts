import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTerminalDisposeFallback, createTerminalRestoreWatchdog, terminalConnectionMode, terminalOperationCompleted } from './terminalLifecycle';

test('closing before a session nonce arrives waits for fallback instead of reconnecting', () => {
  assert.equal(terminalConnectionMode(true), 'wait-for-fallback');
  assert.equal(terminalConnectionMode(true, 'known-session'), 'dispose-existing');
  assert.equal(terminalConnectionMode(false), 'connect');
});

test('terminal restore progress extends the inactivity timeout', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let timeouts = 0;
  const watchdog = createTerminalRestoreWatchdog(() => { timeouts += 1; }, 30_000);

  watchdog.refresh();
  context.mock.timers.tick(29_000);
  watchdog.refresh();
  context.mock.timers.tick(29_999);
  assert.equal(timeouts, 0);
  context.mock.timers.tick(1);
  assert.equal(timeouts, 1);
});

test('clearing the terminal restore watchdog cancels its timeout', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let timedOut = false;
  const watchdog = createTerminalRestoreWatchdog(() => { timedOut = true; }, 30_000);

  watchdog.refresh();
  watchdog.clear();
  context.mock.timers.tick(30_000);
  assert.equal(timedOut, false);
});

test('terminal disposal hands a scheduled fallback off immediately during cleanup', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let fallbacks = 0;
  const fallback = createTerminalDisposeFallback(() => { fallbacks += 1; }, 10_000);

  fallback.schedule();
  fallback.trigger();
  assert.equal(fallbacks, 1);
  context.mock.timers.tick(10_000);
  fallback.trigger();
  assert.equal(fallbacks, 1);
});

test('clearing a terminal disposal fallback cancels its scheduled handoff', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let triggered = false;
  const fallback = createTerminalDisposeFallback(() => { triggered = true; }, 10_000);

  fallback.schedule();
  fallback.clear();
  context.mock.timers.tick(10_000);
  assert.equal(triggered, false);
});

test('reports a terminal operation that settles before its timeout', async () => {
  assert.equal(await terminalOperationCompleted(Promise.resolve(), 20), true);
});

test('reports a terminal operation that stalls through its timeout', async () => {
  assert.equal(await terminalOperationCompleted(new Promise<never>(() => undefined), 5), false);
});

test('propagates a failed terminal operation instead of treating it as rendered', async () => {
  await assert.rejects(terminalOperationCompleted(Promise.reject(new Error('renderer failed')), 20), /renderer failed/);
});
