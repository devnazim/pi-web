import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composerDraftKey, createDraftSessionReservationEffect, ensureSessionReservation } from './sessionReservation';

const solidClientModule = 'solid-js/dist/solid.js';
const { batch, createEffect, createRoot, createSignal } = await import(solidClientModule) as typeof import('solid-js');

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

test('reserves only the final draft during an atomic workspace new-session transition', async () => {
  const pendingReservations = new Map<string, Promise<string>>();
  const reservationKeys: string[] = [];
  const reservationResolvers: Array<(sessionId: string) => void> = [];
  let openWorkspaceSession: () => void = () => undefined;

  const dispose = createRoot((dispose) => {
    const [projectId, setProjectId] = createSignal('workspace-a');
    const [routeSessionId, setRouteSessionId] = createSignal<string | undefined>('session-a');
    const [revisions, setRevisions] = createSignal<Record<string, number>>({});
    let activeDraftKey: string | undefined;

    createEffect(() => {
      const id = projectId();
      activeDraftKey = composerDraftKey(id, routeSessionId(), revisions()[id] ?? 0);
    });
    createDraftSessionReservationEffect(
      createEffect,
      () => {
        const id = projectId();
        return {
          projectId: id,
          routeSessionId: routeSessionId(),
          reservedSessionId: undefined,
          newComposerRevision: revisions()[id] ?? 0,
          activeDraftKey,
        };
      },
      (draftKey) => {
        void ensureSessionReservation(pendingReservations, draftKey, undefined, () => {
          reservationKeys.push(draftKey);
          return new Promise<string>((resolve) => reservationResolvers.push(resolve));
        });
      },
    );
    openWorkspaceSession = () => batch(() => {
      setRevisions((current) => ({ ...current, 'workspace-b': 1 }));
      setRouteSessionId(undefined);
      setProjectId('workspace-b');
    });
    return dispose;
  });

  await Promise.resolve();
  openWorkspaceSession();
  assert.deepEqual(reservationKeys, [composerDraftKey('workspace-b', undefined, 1)]);
  reservationResolvers.forEach((resolve, index) => resolve(`session-${index + 1}`));
  await Promise.all([...pendingReservations.values()]);
  dispose();
});

test('does not reserve a blank draft during an atomic existing-session workspace switch', async () => {
  const reservationKeys: string[] = [];
  let switchSession: () => void = () => undefined;

  const dispose = createRoot((dispose) => {
    const [projectId, setProjectId] = createSignal('workspace-a');
    const [routeSessionId, setRouteSessionId] = createSignal<string | undefined>('session-a');
    let activeDraftKey: string | undefined;

    createEffect(() => {
      activeDraftKey = composerDraftKey(projectId(), routeSessionId());
    });
    createDraftSessionReservationEffect(
      createEffect,
      () => ({
        projectId: projectId(),
        routeSessionId: routeSessionId(),
        reservedSessionId: undefined,
        newComposerRevision: 0,
        activeDraftKey,
      }),
      (draftKey) => reservationKeys.push(draftKey),
    );
    switchSession = () => batch(() => {
      setRouteSessionId(undefined);
      setProjectId('workspace-b');
      setRouteSessionId('session-b');
    });
    return dispose;
  });

  await Promise.resolve();
  switchSession();
  assert.deepEqual(reservationKeys, []);
  dispose();
});
