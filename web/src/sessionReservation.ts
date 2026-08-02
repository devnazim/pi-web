export function isUnknownSessionReservation(error: unknown) {
  return error instanceof Error && error.message.trim().toLowerCase() === 'unknown session';
}

type ReservationStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function readSessionReservationIds(storage: ReservationStorage, key: string) {
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => Boolean(entry[0]) && typeof entry[1] === 'string' && Boolean(entry[1])));
  } catch {
    return {};
  }
}

export function rememberSessionReservationId(storage: ReservationStorage, key: string, projectId: string, sessionId: string) {
  try {
    const sessionIds = { ...readSessionReservationIds(storage, key), [projectId]: sessionId };
    storage.setItem(key, JSON.stringify(sessionIds));
  } catch {
    // Storage can be unavailable in restricted browsing contexts.
  }
}

export function forgetSessionReservationId(storage: ReservationStorage, key: string, projectId: string, sessionId?: string) {
  try {
    const sessionIds = readSessionReservationIds(storage, key);
    if (!(projectId in sessionIds) || (sessionId && sessionIds[projectId] !== sessionId)) return;
    delete sessionIds[projectId];
    if (Object.keys(sessionIds).length) storage.setItem(key, JSON.stringify(sessionIds));
    else storage.removeItem(key);
  } catch {
    // Storage can be unavailable in restricted browsing contexts.
  }
}

export async function ensureSessionReservation(
  pendingReservations: Map<string, Promise<string>>,
  key: string,
  existingSessionId: string | undefined,
  createSession: () => Promise<string>,
) {
  if (existingSessionId) return existingSessionId;
  const pending = pendingReservations.get(key);
  if (pending) return pending;

  const reservation = createSession();
  pendingReservations.set(key, reservation);
  try {
    return await reservation;
  } finally {
    if (pendingReservations.get(key) === reservation) pendingReservations.delete(key);
  }
}
