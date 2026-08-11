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
