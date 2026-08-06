export type WorkspaceSocketCleanup = () => Promise<void>;

export class WorkspaceSocketRegistry {
  private readonly cleanups = new Map<string, Set<WorkspaceSocketCleanup>>();

  track(workspaceId: string, cleanup: WorkspaceSocketCleanup): WorkspaceSocketCleanup {
    const cleanups = this.cleanups.get(workspaceId) ?? new Set<WorkspaceSocketCleanup>();
    let cleanupPromise: Promise<void> | undefined;
    const trackedCleanup = () => {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = cleanup().finally(() => {
        cleanups.delete(trackedCleanup);
        if (!cleanups.size && this.cleanups.get(workspaceId) === cleanups) this.cleanups.delete(workspaceId);
      });
      return cleanupPromise;
    };
    cleanups.add(trackedCleanup);
    this.cleanups.set(workspaceId, cleanups);
    return trackedCleanup;
  }

  async close(workspaceId: string) {
    await Promise.allSettled([...this.cleanups.get(workspaceId) ?? []].map((cleanup) => cleanup()));
  }
}

export function reconcileWorkspaceSockets(
  cleanups: Map<string, WorkspaceSocketCleanup>,
  desiredWorkspaceIds: Iterable<string>,
  connect: (workspaceId: string) => WorkspaceSocketCleanup,
) {
  const desired = new Set(desiredWorkspaceIds);
  for (const [workspaceId, cleanup] of cleanups) {
    if (desired.has(workspaceId)) continue;
    cleanups.delete(workspaceId);
    void cleanup();
  }
  for (const workspaceId of desired) {
    if (!cleanups.has(workspaceId)) cleanups.set(workspaceId, connect(workspaceId));
  }
}

export function queryKeyTargetsWorkspace(queryKey: readonly unknown[], workspaceIds: ReadonlySet<string>) {
  return queryKey.some((item) => typeof item === 'string' && workspaceIds.has(item));
}

export async function withSuspendedWorkspaceSockets<T>(
  workspaceIds: readonly string[],
  setSuspended: (workspaceId: string, suspended: boolean) => void,
  closeSockets: (workspaceId: string) => Promise<void>,
  action: () => Promise<T>,
) {
  const uniqueWorkspaceIds = [...new Set(workspaceIds)];
  for (const workspaceId of uniqueWorkspaceIds) setSuspended(workspaceId, true);
  try {
    await Promise.all(uniqueWorkspaceIds.map((workspaceId) => closeSockets(workspaceId)));
    return await action();
  } finally {
    for (const workspaceId of uniqueWorkspaceIds) setSuspended(workspaceId, false);
  }
}
