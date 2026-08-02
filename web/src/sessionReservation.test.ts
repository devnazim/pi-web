import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureSessionReservation, forgetSessionReservationId, isUnknownSessionReservation, readSessionReservationIds, rememberSessionReservationId } from './sessionReservation';

test('recognizes an unknown-session error that requires authoritative confirmation', () => {
  assert.equal(isUnknownSessionReservation(new Error('Unknown session')), true);
  assert.equal(isUnknownSessionReservation(new Error('Session does not belong to this project')), false);
  assert.equal(isUnknownSessionReservation(new Error('Network unavailable')), false);
});

test('persists reservations per project and forgets only the matching session', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };

  rememberSessionReservationId(storage, 'drafts', 'project-a', 'session-a');
  rememberSessionReservationId(storage, 'drafts', 'project-b', 'session-b');
  assert.deepEqual(readSessionReservationIds(storage, 'drafts'), { 'project-a': 'session-a', 'project-b': 'session-b' });
  forgetSessionReservationId(storage, 'drafts', 'project-a', 'replacement');
  assert.equal(readSessionReservationIds(storage, 'drafts')['project-a'], 'session-a');
  forgetSessionReservationId(storage, 'drafts', 'project-a', 'session-a');
  assert.deepEqual(readSessionReservationIds(storage, 'drafts'), { 'project-b': 'session-b' });
  forgetSessionReservationId(storage, 'drafts', 'project-b');
  assert.equal(values.has('drafts'), false);
});

test('reuses an existing draft session without creating another reservation', async () => {
  let creates = 0;

  assert.equal(await ensureSessionReservation(new Map(), 'draft', 'session-1', async () => {
    creates += 1;
    return 'session-2';
  }), 'session-1');
  assert.equal(creates, 0);
});

test('coalesces concurrent reservations for the same draft', async () => {
  const pending = new Map<string, Promise<string>>();
  let finish: ((sessionId: string) => void) | undefined;
  let creates = 0;
  const createSession = () => {
    creates += 1;
    return new Promise<string>((resolve) => { finish = resolve; });
  };

  const first = ensureSessionReservation(pending, 'project-1\0', undefined, createSession);
  const second = ensureSessionReservation(pending, 'project-1\0', undefined, createSession);
  finish?.('session-1');

  assert.deepEqual(await Promise.all([first, second]), ['session-1', 'session-1']);
  assert.equal(creates, 1);
  assert.equal(pending.size, 0);
});

test('isolates drafts and permits retry after a failed reservation', async () => {
  const pending = new Map<string, Promise<string>>();
  let attempts = 0;
  const createSession = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary failure');
    return 'session-2';
  };

  await assert.rejects(ensureSessionReservation(pending, 'project-1\0', undefined, createSession), /temporary failure/);
  assert.equal(await ensureSessionReservation(pending, 'project-1\0', undefined, createSession), 'session-2');
  assert.equal(await ensureSessionReservation(pending, 'project-2\0', undefined, async () => 'session-3'), 'session-3');
  assert.equal(pending.size, 0);
});
