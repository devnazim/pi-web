import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composerDraftKey, createDraftSessionReservationEffect, ensureSessionReservation } from './sessionReservation';

const solidClientModule = 'solid-js/dist/solid.js';
const { createEffect, createRoot, createSignal } = await import(solidClientModule) as typeof import('solid-js');

test('reserves a session for a new blank composer while the previous reservation is pending', async () => {
  const pendingReservations = new Map<string, Promise<string>>();
  const reservationKeys: string[] = [];
  let resolveFirst: (sessionId: string) => void = () => undefined;
  const firstReservation = new Promise<string>((resolve) => { resolveFirst = resolve; });
  let resolveSecond: (sessionId: string) => void = () => undefined;
  const secondReservation = new Promise<string>((resolve) => { resolveSecond = resolve; });
  let openNewComposer: () => void = () => undefined;
  let creates = 0;

  const dispose = createRoot((dispose) => {
    const [revision, setRevision] = createSignal(0);
    let activeDraftKey: string | undefined;

    createEffect(() => {
      activeDraftKey = composerDraftKey('project-1', undefined, revision());
    });
    createDraftSessionReservationEffect(
      createEffect,
      () => ({
        projectId: 'project-1',
        routeSessionId: undefined,
        reservedSessionId: undefined,
        newComposerRevision: revision(),
        activeDraftKey,
      }),
      (draftKey) => {
        reservationKeys.push(draftKey);
        void ensureSessionReservation(pendingReservations, draftKey, undefined, () => {
          creates += 1;
          return creates === 1 ? firstReservation : secondReservation;
        });
      },
    );
    openNewComposer = () => setRevision(1);
    return dispose;
  });

  await Promise.resolve();
  assert.equal(creates, 1);
  openNewComposer();
  assert.deepEqual(reservationKeys, [
    composerDraftKey('project-1', undefined, 0),
    composerDraftKey('project-1', undefined, 1),
  ]);
  assert.equal(creates, 2);
  resolveFirst('session-1');
  resolveSecond('session-2');
  await Promise.all([...pendingReservations.values()]);
  dispose();
});
