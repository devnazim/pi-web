export type TranscriptUserMessage = { id: string; text: string };
export type PendingUserMessageHandoff = { id: number; previousUserEntryIds: string[]; text: string; accepted: boolean };

export function hasPersistedUserMessage(
  messages: TranscriptUserMessage[],
  previousEntryIds: string[],
  prompt: string,
  accepted = false,
) {
  const previousIds = new Set(previousEntryIds);
  return messages.some((message) => !previousIds.has(message.id) && (accepted || persistedUserMessageMatchesPrompt(message.text, prompt)));
}

export function unresolvedPendingUserMessages<T extends PendingUserMessageHandoff>(messages: TranscriptUserMessage[], pendingMessages: T[]) {
  const consumedEntryIds = new Set<string>();
  const unresolved: T[] = [];
  let waitingForEarlierMessage = false;

  for (const pending of pendingMessages) {
    if (waitingForEarlierMessage) {
      unresolved.push(pending);
      continue;
    }
    const previousIds = new Set(pending.previousUserEntryIds);
    const candidate = messages.find((message) => !previousIds.has(message.id) && !consumedEntryIds.has(message.id));
    if (!candidate || (!pending.accepted && !persistedUserMessageMatchesPrompt(candidate.text, pending.text))) {
      unresolved.push(pending);
      waitingForEarlierMessage = true;
      continue;
    }
    consumedEntryIds.add(candidate.id);
  }

  return unresolved;
}

export function pendingUserMessagesAfterTerminalRefresh<T extends PendingUserMessageHandoff>(messages: TranscriptUserMessage[], pendingMessages: T[]) {
  return unresolvedPendingUserMessages(messages, pendingMessages).filter((pending) => !pending.accepted);
}

export function markSessionActivityStarted(completedRefreshes: Set<string>, workspaceId: string, sessionId: string) {
  completedRefreshes.delete(completionRefreshKey(workspaceId, sessionId));
}

export function shouldRefreshCompletedSession(completedRefreshes: Set<string>, workspaceId: string, sessionId: string, operationId?: string) {
  const key = completionRefreshKey(workspaceId, sessionId, operationId);
  if (completedRefreshes.has(key)) return false;
  completedRefreshes.add(key);
  while (completedRefreshes.size > 200) {
    const oldest = completedRefreshes.values().next().value;
    if (oldest === undefined) break;
    completedRefreshes.delete(oldest);
  }
  return true;
}

function completionRefreshKey(workspaceId: string, sessionId: string, operationId?: string) {
  return `${workspaceId}\u0000${sessionId}\u0000${operationId ?? 'legacy'}`;
}

function persistedUserMessageMatchesPrompt(message: string, prompt: string) {
  const persistedText = comparableMessageText(message);
  const promptText = comparableMessageText(prompt);
  return persistedText === promptText
    || persistedText.startsWith(`${promptText} Attached files in the workspace:`)
    || persistedText.startsWith(`${promptText} [image]`);
}

function comparableMessageText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}
