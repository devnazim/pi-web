import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTerminalHistoryRefresh, type TerminalRefreshStatus } from './terminalHistoryRefresh';

type Message = { id: number };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('Timed out waiting for refresh state');
}

test('failed terminal refresh stays locked until a successful retry reconciles the pending messages', async () => {
  const requests = [deferred<string>(), deferred<string>(), deferred<string>(), deferred<string>()];
  let count = 0;
  let statuses = new Map<string, TerminalRefreshStatus>();
  const reconciled: { detail: string; ids: number[]; terminalError: boolean }[] = [];
  const refresh = createTerminalHistoryRefresh<Message, string>({
    request: () => requests[count++].promise,
    reconcile: (_project, _session, detail, pending, terminalError) => reconciled.push({ detail, ids: pending.map(({ id }) => id), terminalError }),
    onChange: (next) => { statuses = next; },
    retryDelayMs: 1,
  });
  try {
    const key = 'project\u0000session';
    const first = refresh.refresh('project', 'session', [{ id: 1 }], true);
    assert.equal(statuses.get(key), 'pending');
    requests[0].reject(new Error('offline'));
    await waitFor(() => count === 2);
    requests[1].reject(new Error('still offline'));
    await first;
    assert.equal(statuses.get(key), 'failed');
    assert.deepEqual(reconciled, []);

    refresh.retry('project', 'session');
    assert.equal(statuses.get(key), 'pending');
    refresh.retry('project', 'session');
    assert.equal(count, 3, 'concurrent retry does not start another GET');
    requests[2].reject(new Error('retry failed'));
    await waitFor(() => statuses.get(key) === 'failed');
    assert.deepEqual(reconciled, []);
    refresh.retry('project', 'session');
    assert.equal(statuses.get(key), 'pending');
    requests[3].resolve('saved history');
    await waitFor(() => !statuses.has(key));
    assert.deepEqual(reconciled, [{ detail: 'saved history', ids: [1], terminalError: true }]);
  } finally {
    refresh.dispose();
  }
});

test('a newer terminal event cannot reconcile against an older in-flight snapshot', async () => {
  const oldRead = deferred<string>();
  const newRead = deferred<string>();
  const requests = [oldRead, newRead];
  let count = 0;
  let statuses = new Map<string, TerminalRefreshStatus>();
  const reconciled: { detail: string; ids: number[] }[] = [];
  const refresh = createTerminalHistoryRefresh<Message, string>({
    request: () => requests[count++].promise,
    reconcile: (_project, _session, detail, pending) => reconciled.push({ detail, ids: pending.map(({ id }) => id) }),
    onChange: (next) => { statuses = next; },
  });
  try {
    const first = refresh.refresh('p', 's', [{ id: 1 }], false);
    const second = refresh.refresh('p', 's', [{ id: 2 }], false);
    assert.equal(first, second, 'both callers wait for the latest reconciliation');
    assert.equal(count, 1);
    let awaitCompleted = false;
    void second.then(() => { awaitCompleted = true; });
    oldRead.resolve('snapshot before message 2');
    await waitFor(() => count === 2);
    assert.equal(statuses.get('p\u0000s'), 'pending');
    assert.deepEqual(reconciled, []);
    assert.equal(awaitCompleted, false);
    newRead.resolve('snapshot after message 2');
    await first;
    assert.equal(awaitCompleted, true);
    assert.equal(statuses.has('p\u0000s'), false);
    assert.deepEqual(reconciled, [{ detail: 'snapshot after message 2', ids: [1, 2] }]);
  } finally {
    refresh.dispose();
  }
});

test('refresh state and retry stay scoped to the project and session', async () => {
  const requests = [deferred<string>(), deferred<string>(), deferred<string>(), deferred<string>(), deferred<string>()];
  let count = 0;
  let statuses = new Map<string, TerminalRefreshStatus>();
  const reconciled: string[] = [];
  const refresh = createTerminalHistoryRefresh<Message, string>({
    request: () => requests[count++].promise,
    reconcile: (project, session, _detail, pending) => reconciled.push(`${project}/${session}/${pending.map(({ id }) => id).join(',')}`),
    onChange: (next) => { statuses = next; },
    retryDelayMs: 1,
  });
  try {
    const first = refresh.refresh('p1', 's1', [{ id: 1 }], false);
    const second = refresh.refresh('p2', 's1', [{ id: 2 }], false);
    const joined = refresh.refresh('p1', 's1', [{ id: 3 }, { id: 1 }], true);
    assert.equal(joined, first);
    assert.equal(count, 2, 'overlapping refresh waits for the older GET');
    requests[0].reject(new Error('offline'));
    await waitFor(() => count === 3);
    requests[2].reject(new Error('offline'));
    await waitFor(() => count === 4);
    requests[3].reject(new Error('offline'));
    await Promise.all([first, joined]);
    assert.equal(statuses.get('p1\u0000s1'), 'failed');
    refresh.retry('p2', 's1');
    refresh.retry('p1', 'another-session');
    assert.equal(count, 4, 'retry for another target does not refresh the blocked session');
    requests[1].resolve('p2 history');
    await second;
    assert.equal(statuses.has('p2\u0000s1'), false);
    assert.equal(statuses.get('p1\u0000s1'), 'failed');
    refresh.retry('p1', 's1');
    requests[4].resolve('p1 history');
    await waitFor(() => !statuses.has('p1\u0000s1'));
    assert.deepEqual(reconciled, ['p2/s1/2', 'p1/s1/1,3']);
  } finally {
    refresh.dispose();
  }
});

test('disposal clears retry timers and ignores late results', async () => {
  let count = 0;
  let updates = 0;
  const request = deferred<string>();
  const refresh = createTerminalHistoryRefresh<Message, string>({
    request: () => { count++; return request.promise; },
    reconcile: () => assert.fail('disposed refresh must not reconcile'),
    onChange: () => { updates++; },
    retryDelayMs: 5,
  });
  const first = refresh.refresh('p', 's', [], false);
  request.reject(new Error('offline'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  refresh.dispose();
  await first;
  const updatesAtDisposal = updates;
  await new Promise((resolve) => setTimeout(resolve, 20));
  refresh.retry('p', 's');
  assert.equal(count, 1);
  assert.equal(updates, updatesAtDisposal);

  const late = deferred<string>();
  const other = createTerminalHistoryRefresh<Message, string>({
    request: () => late.promise,
    reconcile: () => assert.fail('disposed refresh must not reconcile'),
    onChange: () => { updates++; },
  });
  const pending = other.refresh('p', 's', [], false);
  other.dispose();
  const updatesBeforeLateResult = updates;
  late.resolve('late history');
  await pending;
  assert.equal(updates, updatesBeforeLateResult);
});
