export type KnownProject = { id: string; path: string; rootId: string; rootPath: string };
type ApiRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

export function recoveryProjectsFromWorkspaces(
  roots: { id: string; path: string }[],
  workspacesByRootId: Record<string, { id: string; path: string; rootProjectId: string }[]>,
): KnownProject[] {
  const rootIds = new Set(roots.map(({ id }) => id));
  return [
    ...roots.map(({ id, path }) => ({ id, path, rootId: id, rootPath: path })),
    ...roots.flatMap((root) => (workspacesByRootId[root.id] ?? [])
      .filter((workspace) => workspace.rootProjectId === root.id && !rootIds.has(workspace.id))
      .map(({ id, path }) => ({ id, path, rootId: root.id, rootPath: root.path }))),
  ];
}

export function retainKnownRoots<T extends { id: string }>(listed: T[], cached: Map<string, T>, isForgotten: (id: string) => boolean) {
  for (const project of listed) {
    if (!isForgotten(project.id)) cached.set(project.id, project);
  }
  return [...cached.values()].filter((project) => !isForgotten(project.id));
}

export function isUnknownProjectResponse(error: unknown) {
  return error instanceof Error && /^Unknown project: .+$/.test(error.message)
    && 'status' in error && error.status === 404;
}

export function isUnknownProject(error: unknown, id: string) {
  return isUnknownProjectResponse(error) && (error as Error).message === `Unknown project: ${id}`;
}

// Only GET requests can be replayed. A failed mutation must never be sent twice.
export function createProjectRecovery(request: ApiRequest, probe: ApiRequest = request, canRestore: (id: string) => boolean = () => true, onRootRegistered?: () => void) {
  const inFlight = new Map<string, { promise: Promise<void>; controller: AbortController; signals: Set<AbortSignal | undefined> }>();
  const knownProjects = new Map<string, KnownProject>();
  const forgotten = new Set<string>();
  const closedRoots = new Set<string>();
  const retiring = new Set<string>();
  const known = (id: string) => {
    const project = knownProjects.get(id);
    return project && !forgotten.has(id) && !closedRoots.has(project.rootId) ? project : undefined;
  };
  const isForgotten = (id: string) => forgotten.has(id) || closedRoots.has(id);
  const remember = (project: KnownProject, reopened = false) => {
    if (project.id !== project.rootId && (forgotten.has(project.rootId) || closedRoots.has(project.rootId) || retiring.has(project.rootId))) return;
    if (reopened) {
      forgotten.delete(project.id);
      if (project.id === project.rootId) closedRoots.delete(project.id);
    }
    if (!forgotten.has(project.id) && (project.id !== project.rootId || !closedRoots.has(project.id))) knownProjects.set(project.id, project);
  };
  const forget = (ids: Iterable<string>) => {
    for (const id of ids) { forgotten.add(id); knownProjects.delete(id); }
  };
  const closeRoot = (rootId: string) => { closedRoots.add(rootId); };
  const projectUrl = /^\/api\/projects\/([^/?]+)(?:[/?]|$)/;

  function once(id: string, signal: AbortSignal | undefined, restore: (signal: AbortSignal) => Promise<void>) {
    const existing = inFlight.get(id);
    if (existing) {
      existing.signals.add(signal);
      if (signal) signal.addEventListener('abort', () => {
        if ([...existing.signals].every((item) => item?.aborted)) existing.controller.abort();
      }, { once: true });
      return existing.promise;
    }
    const controller = new AbortController();
    const flight = { controller, signals: new Set<AbortSignal | undefined>([signal]), promise: undefined as unknown as Promise<void> };
    if (signal) signal.addEventListener('abort', () => {
      if ([...flight.signals].every((item) => item?.aborted)) controller.abort();
    }, { once: true });
    if (signal?.aborted) controller.abort();
    flight.promise = restore(controller.signal).finally(() => { if (inFlight.get(id) === flight) inFlight.delete(id); });
    inFlight.set(id, flight);
    return flight.promise;
  }

  function check(project: KnownProject, signal?: AbortSignal) {
    if (signal?.aborted || !known(project.id) || forgotten.has(project.rootId) || closedRoots.has(project.rootId) || retiring.has(project.id) || retiring.has(project.rootId) || !canRestore(project.id)) throw new Error(`Recovery canceled for project: ${project.id}`);
  }

  async function registerRoot(project: KnownProject, sourceSignal?: AbortSignal) {
    return once(project.rootId, sourceSignal, async (signal) => {
      check(project, signal);
      try {
        const result = await probe<{ project: { hidden?: boolean } }>(`/api/projects/${encodeURIComponent(project.rootId)}`, { signal });
        if (!result.project.hidden) return;
      } catch (error) {
        if (!isUnknownProject(error, project.rootId)) throw error;
      }
      check(project, signal);
      const result = await probe<{ project: { id: string } }>('/api/projects', {
        signal, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: project.rootPath }),
      });
      if (result.project.id !== project.rootId) throw new Error('Restored project ID does not match the known project');
      onRootRegistered?.();
    });
  }

  async function restore(project: KnownProject, sourceSignal?: AbortSignal) {
    if (project.id === project.rootId) return registerRoot(project, sourceSignal);
    return once(project.id, sourceSignal, async (signal) => {
      check(project, signal);
      await registerRoot(project, signal);
      check(project, signal);
      // The workspace listing registers worktrees as hidden projects. POST /api/projects
      // would turn this workspace into a second visible root project.
      const result = await probe<{ workspaces: { id: string }[] }>(`/api/projects/${encodeURIComponent(project.rootId)}/workspaces`, { signal });
      if (!result.workspaces.some((workspace) => workspace.id === project.id)) throw new Error(`Workspace is no longer available: ${project.id}`);
    });
  }

  async function get<T>(url: string, init?: RequestInit): Promise<T> {
    try {
      return await request<T>(url, init);
    } catch (error) {
      const id = projectUrl.exec(url)?.[1];
      const project = id ? known(id) : undefined;
      if ((init?.method ?? 'GET').toUpperCase() !== 'GET' || !project
        || forgotten.has(project.rootId) || closedRoots.has(project.rootId) || retiring.has(project.rootId) || init?.signal?.aborted) throw error;
      // The workspace-list route reports a missing registry entry as 400, not 404.
      const unknownWorkspaceProject = url.split('?', 1)[0] === `/api/projects/${project.id}/workspaces`
        && error instanceof Error && 'status' in error && error.status === 400
        && error.message === `Unknown project: ${project.id}`;
      if (!isUnknownProject(error, project.id) && !unknownWorkspaceProject) throw error;
      await restore(project, init?.signal ?? undefined);
      check(project, init?.signal ?? undefined);
      return request<T>(url, init);
    }
  }

  async function beforeConnect(id: string, signal?: AbortSignal) {
    const project = known(id);
    if (!project) throw new Error(`Unknown recovery target: ${id}`);
    check(project, signal);
    let hidden = false;
    try {
      const result = await probe<{ project: { hidden?: boolean } }>(`/api/projects/${encodeURIComponent(id)}`, { signal });
      hidden = Boolean(result.project.hidden);
    } catch (error) {
      if (!isUnknownProject(error, id)) throw error;
      check(project, signal);
      await restore(project, signal);
      check(project, signal);
      return;
    }
    check(project, signal);
    if (project.id === project.rootId && hidden) await registerRoot(project, signal);
  }

  function idsForRoot(rootId: string) {
    return [rootId, ...[...knownProjects.values()].filter((project) => project.rootId === rootId && project.id !== rootId).map((project) => project.id)];
  }

  async function pause(ids: string[]) {
    ids.forEach((id) => retiring.add(id));
    await Promise.allSettled(ids.map((id) => inFlight.get(id)?.promise).filter((pending) => pending !== undefined));
    return () => ids.forEach((id) => retiring.delete(id));
  }

  return { get, beforeConnect, remember, forget, closeRoot, pause, idsForRoot, isForgotten };
}
