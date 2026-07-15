export type WorkspaceNotificationServerEvent = { type?: string; operationId?: string; projectId?: string; sessionId?: string; message?: string; data?: unknown };

const WORKSPACE_NOTIFICATION_DEDUPE_WINDOW_MS = 5_000;
const WORKSPACE_NOTIFICATION_DEDUPE_MAX_ENTRIES = 200;

export function resetWorkspaceNotificationEventDeduplication(
  recentEvents: Map<string, number>,
  workspaceId: string,
  sessionId: string | undefined,
) {
  const prefix = `${workspaceId}\u0000${sessionId ?? 'active'}\u0000`;
  for (const key of recentEvents.keys()) {
    if (key.startsWith(prefix)) recentEvents.delete(key);
  }
}

export function isDuplicateWorkspaceNotificationEvent(
  recentEvents: Map<string, number>,
  workspaceId: string,
  event: WorkspaceNotificationServerEvent,
  now = Date.now(),
) {
  if (!['agent:finish', 'agent:error', 'bash:finish', 'bash:error', 'error'].includes(event.type ?? '')) return false;
  const identity = event.operationId ?? `${event.message ?? ''}\u0000${JSON.stringify(event.data ?? null)}`;
  const key = `${workspaceId}\u0000${event.sessionId ?? 'active'}\u0000${event.type ?? 'event'}\u0000${identity}`;
  const previous = recentEvents.get(key);
  recentEvents.set(key, now);

  if (recentEvents.size > WORKSPACE_NOTIFICATION_DEDUPE_MAX_ENTRIES) {
    for (const [candidate, seenAt] of recentEvents) {
      if (now - seenAt > WORKSPACE_NOTIFICATION_DEDUPE_WINDOW_MS) recentEvents.delete(candidate);
    }
    while (recentEvents.size > WORKSPACE_NOTIFICATION_DEDUPE_MAX_ENTRIES) {
      const oldest = recentEvents.keys().next().value;
      if (oldest === undefined) break;
      recentEvents.delete(oldest);
    }
  }

  return previous !== undefined && now - previous <= WORKSPACE_NOTIFICATION_DEDUPE_WINDOW_MS;
}
