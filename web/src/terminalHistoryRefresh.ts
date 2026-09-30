export type TerminalRefreshStatus = 'pending' | 'failed';

type RefreshEntry<TPending> = {
  projectId: string;
  sessionId: string;
  pending: TPending[];
  terminalError: boolean;
  status: TerminalRefreshStatus;
  generation: number;
  settled: Promise<void>;
  resolveSettled: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

export function createTerminalHistoryRefresh<TPending extends { id: number }, TDetail>(options: {
  request: (projectId: string, sessionId: string) => Promise<TDetail>;
  reconcile: (projectId: string, sessionId: string, detail: TDetail, pending: TPending[], terminalError: boolean) => void;
  onChange: (statuses: Map<string, TerminalRefreshStatus>) => void;
  retryDelayMs?: number;
}) {
  const entries = new Map<string, RefreshEntry<TPending>>();
  let disposed = false;
  const keyFor = (projectId: string, sessionId: string) => `${projectId}\u0000${sessionId}`;
  const notify = () => options.onChange(new Map([...entries].map(([key, entry]) => [key, entry.status])));

  async function attempt(key: string, entry: RefreshEntry<TPending>, retry: boolean) {
    const generation = entry.generation;
    try {
      const detail = await options.request(entry.projectId, entry.sessionId);
      if (disposed || entries.get(key) !== entry) return;
      // A later terminal event can finish after this GET started. Read again before
      // reconciling its messages or releasing the send lock.
      if (generation !== entry.generation) {
        void attempt(key, entry, true);
        return;
      }
      options.reconcile(entry.projectId, entry.sessionId, detail, entry.pending, entry.terminalError);
      entries.delete(key);
      notify();
      entry.resolveSettled();
    } catch {
      if (disposed || entries.get(key) !== entry) return;
      if (generation !== entry.generation) {
        void attempt(key, entry, true);
      } else if (retry) {
        entry.timer = setTimeout(() => {
          entry.timer = undefined;
          if (!disposed && entries.get(key) === entry) void attempt(key, entry, false);
        }, options.retryDelayMs ?? 1_000);
      } else {
        entry.status = 'failed';
        notify();
        entry.resolveSettled();
      }
    }
  }

  function start(projectId: string, sessionId: string, pending: TPending[], terminalError: boolean, retry: boolean) {
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const entry: RefreshEntry<TPending> = { projectId, sessionId, pending, terminalError, status: 'pending', generation: 0, settled, resolveSettled };
    const key = keyFor(projectId, sessionId);
    entries.set(key, entry);
    notify();
    void attempt(key, entry, retry);
    return settled;
  }

  function refresh(projectId: string, sessionId: string, pending: TPending[], terminalError: boolean) {
    if (disposed) return Promise.resolve();
    const key = keyFor(projectId, sessionId);
    const existing = entries.get(key);
    if (!existing) return start(projectId, sessionId, [...pending], terminalError, true);
    const ids = new Set(existing.pending.map(({ id }) => id));
    for (const message of pending) {
      if (!ids.has(message.id)) {
        existing.pending.push(message);
        ids.add(message.id);
      }
    }
    existing.terminalError ||= terminalError;
    if (existing.status === 'failed') return start(projectId, sessionId, existing.pending, existing.terminalError, true);
    existing.generation++;
    if (existing.timer !== undefined) {
      clearTimeout(existing.timer);
      existing.timer = undefined;
      void attempt(key, existing, true);
    }
    return existing.settled;
  }

  function retry(projectId: string, sessionId: string) {
    if (disposed) return;
    const entry = entries.get(keyFor(projectId, sessionId));
    if (!entry || entry.status !== 'failed') return;
    void start(projectId, sessionId, entry.pending, entry.terminalError, false);
  }

  function dispose() {
    disposed = true;
    for (const entry of entries.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.resolveSettled();
    }
    entries.clear();
  }

  return { refresh, retry, dispose };
}
