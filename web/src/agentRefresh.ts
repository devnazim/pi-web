export class StaleAgentStatusError extends Error {}

export async function withRequestTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  sourceSignal: AbortSignal | null | undefined,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  const forwardAbort = () => controller.abort(sourceSignal?.reason);
  if (sourceSignal?.aborted) forwardAbort();
  else sourceSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = controller.signal.aborted
    ? undefined
    : setTimeout(() => controller.abort(new DOMException('Agent refresh timed out', 'TimeoutError')), timeoutMs);

  try {
    return await Promise.race([run(controller.signal), aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    sourceSignal?.removeEventListener('abort', forwardAbort);
  }
}

export function shouldSuppressAgentUiRequests(
  statusGenerationAtStart: number,
  currentStatusGeneration: number,
  status: { running: boolean; recovery?: unknown } | undefined,
) {
  return currentStatusGeneration !== statusGenerationAtStart && Boolean(status && (!status.running || status.recovery));
}

export function isCurrentAgentStatusTarget(
  requestProjectId: string,
  targetSessionId: string,
  currentProjectId: string | undefined,
  activeSessionId: string | undefined,
  ownsUnselectedSession: boolean,
  localOperationCurrent = true,
) {
  return localOperationCurrent && currentProjectId === requestProjectId && (activeSessionId === targetSessionId || ownsUnselectedSession);
}

export function shouldRetryAgentRefresh(failureCount: number, error: unknown) {
  if (error instanceof StaleAgentStatusError) return false;
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  return failureCount < 1;
}
