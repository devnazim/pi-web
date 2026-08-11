export function terminalConnectionMode(disposeRequested: boolean, sessionNonce?: string) {
  if (!disposeRequested) return 'connect';
  return sessionNonce ? 'dispose-existing' : 'wait-for-fallback';
}

export function createTerminalRestoreWatchdog(onTimeout: () => void, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return {
    refresh() {
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = setTimeout(() => {
        timeout = undefined;
        onTimeout();
      }, timeoutMs);
    },
    clear() {
      if (timeout === undefined) return;
      clearTimeout(timeout);
      timeout = undefined;
    },
  };
}

export function createTerminalDisposeFallback(onFallback: () => void, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let triggered = false;
  const clear = () => {
    if (timeout === undefined) return;
    clearTimeout(timeout);
    timeout = undefined;
  };
  const trigger = () => {
    if (triggered) return;
    triggered = true;
    clear();
    onFallback();
  };
  return {
    schedule() {
      if (triggered || timeout !== undefined) return;
      timeout = setTimeout(() => {
        timeout = undefined;
        trigger();
      }, timeoutMs);
    },
    trigger,
    clear,
  };
}

export async function terminalOperationCompleted(operation: void | PromiseLike<void>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation).then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => {
          timeout = undefined;
          resolve(false);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
