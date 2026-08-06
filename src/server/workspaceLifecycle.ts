import type { FastifyInstance, FastifyRequest } from 'fastify';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { ProjectRegistry } from './projects.js';

export type WorkspaceLifecycleLease = { release: () => void };

export class WorkspaceLifecycleConflictError extends Error {
  readonly statusCode = 409;

  constructor(readonly code: 'WORKSPACE_ACTIVE' | 'WORKSPACE_DELETING', message: string) {
    super(message);
  }
}

export class WorkspaceLifecycleCoordinator {
  private readonly states = new Map<string, { activities: number; deleting: boolean }>();
  private readonly canonicalIdentities = new Map<string, string>();
  private readonly deletionAliases = new Map<string, string>();

  acquireActivity(workspacePath: string): WorkspaceLifecycleLease {
    const key = this.workspaceKey(workspacePath);
    const lexicalKey = lexicalWorkspaceKey(workspacePath);
    if ([...this.states].some(([stateKey, state]) => state.deleting && (pathsOverlap(stateKey, key) || pathsOverlap(stateKey, lexicalKey)))) {
      throw new WorkspaceLifecycleConflictError('WORKSPACE_DELETING', 'Workspace is being deleted.');
    }
    const leases = [...new Set([key, lexicalKey])].map((activityKey) => {
      const state = this.states.get(activityKey) ?? { activities: 0, deleting: false };
      state.activities += 1;
      this.states.set(activityKey, state);
      return this.lease(activityKey, state, 'activity');
    });
    return { release: () => leases.forEach((lease) => lease.release()) };
  }

  acquireDeletion(workspacePath: string): WorkspaceLifecycleLease {
    const key = this.workspaceKey(workspacePath);
    if ([...this.states].some(([stateKey, state]) => state.deleting && pathsOverlap(stateKey, key))) {
      throw new WorkspaceLifecycleConflictError('WORKSPACE_DELETING', 'Workspace is being deleted.');
    }
    if ([...this.states].some(([stateKey, state]) => state.activities > 0 && pathsOverlap(stateKey, key))) {
      throw new WorkspaceLifecycleConflictError('WORKSPACE_ACTIVE', 'Workspace is in use. Stop its Pi sessions, commands, and terminals before deleting it.');
    }
    const state = this.states.get(key) ?? { activities: 0, deleting: false };
    state.deleting = true;
    this.states.set(key, state);
    this.deletionAliases.set(lexicalWorkspaceKey(workspacePath), key);
    return this.lease(key, state, 'deletion');
  }

  bindDeletionAlias(workspacePath: string, aliasPath: string) {
    const key = this.workspaceKey(workspacePath);
    const deletionKey = [...this.states].find(([stateKey, state]) => state.deleting && pathsOverlap(stateKey, key))?.[0];
    if (!deletionKey) throw new Error('Workspace deletion is not active.');
    const aliasKey = lexicalWorkspaceKey(aliasPath);
    const existing = this.deletionAliases.get(aliasKey);
    if (existing && existing !== deletionKey) throw new Error('Workspace deletion alias conflicts with an existing workspace identity.');
    this.deletionAliases.set(aliasKey, deletionKey);
  }

  isDeleting(workspacePath: string) {
    const key = this.workspaceKey(workspacePath);
    return [...this.states].some(([stateKey, state]) => state.deleting && pathsOverlap(stateKey, key));
  }

  private workspaceKey(workspacePath: string) {
    const lexical = lexicalWorkspaceKey(workspacePath);
    const canonical = existingWorkspaceKey(workspacePath);
    if (canonical) {
      const identity = this.mappedDeletionIdentity(canonical) ?? canonical;
      this.canonicalIdentities.set(lexical, identity);
      return identity;
    }

    const deletionIdentity = this.mappedDeletionIdentity(lexical);
    if (deletionIdentity) return deletionIdentity;
    const cachedIdentity = this.cachedIdentity(lexical);
    if (cachedIdentity && [...this.states].some(([stateKey, state]) => state.deleting && pathsOverlap(stateKey, cachedIdentity))) return cachedIdentity;
    this.canonicalIdentities.delete(lexical);
    return lexical;
  }

  private mappedDeletionIdentity(candidate: string) {
    return mappedIdentity(this.deletionAliases, candidate);
  }

  private cachedIdentity(candidate: string) {
    return mappedIdentity(this.canonicalIdentities, candidate);
  }

  private lease(key: string, state: { activities: number; deleting: boolean }, type: 'activity' | 'deletion'): WorkspaceLifecycleLease {
    let active = true;
    return {
      release: () => {
        if (!active) return;
        active = false;
        if (type === 'activity') state.activities = Math.max(0, state.activities - 1);
        else {
          state.deleting = false;
          for (const [alias, identity] of this.deletionAliases) {
            if (identity === key) this.deletionAliases.delete(alias);
          }
        }
        if (!state.activities && !state.deleting) this.states.delete(key);
      },
    };
  }
}

export function registerWorkspaceActivityHooks(app: FastifyInstance, registry: ProjectRegistry, lifecycle: WorkspaceLifecycleCoordinator) {
  const leases = new WeakMap<FastifyRequest, { lease: WorkspaceLifecycleLease; handlerSettled: boolean; responseClosed: boolean }>();
  const release = (request: FastifyRequest) => {
    leases.get(request)?.lease.release();
    leases.delete(request);
  };

  app.addHook('preHandler', async (request, reply) => {
    if (request.routeOptions.url?.startsWith('/ws/')) return;
    if (request.method === 'DELETE' && request.routeOptions.url === '/api/projects/:projectId/workspaces/:workspaceId') return;
    const projectId = (request.params as { projectId?: string } | undefined)?.projectId;
    if (!projectId) return;
    const blockedReason = registry.blockReason(projectId);
    if (blockedReason) return reply.code(409).send({ error: blockedReason });
    let project;
    try {
      project = registry.get(projectId);
    } catch {
      return;
    }
    try {
      const state = { lease: lifecycle.acquireActivity(project.path), handlerSettled: false, responseClosed: false };
      leases.set(request, state);
      reply.raw.once('close', () => {
        state.responseClosed = true;
        if (state.handlerSettled) release(request);
      });
    } catch (error) {
      if (!(error instanceof WorkspaceLifecycleConflictError)) throw error;
      return reply.code(error.statusCode).send({ error: error.message });
    }
  });

  app.addHook('onSend', async (request, _reply, payload) => {
    const state = leases.get(request);
    if (state) {
      state.handlerSettled = true;
      if (state.responseClosed) release(request);
    }
    return payload;
  });
  app.addHook('onResponse', async (request) => release(request));
  app.addHook('onError', async (request) => release(request));
}

export function workspaceLifecycleKey(workspacePath: string) {
  return existingWorkspaceKey(workspacePath) ?? lexicalWorkspaceKey(workspacePath);
}

function existingWorkspaceKey(workspacePath: string) {
  try {
    const canonical = realpathSync.native(path.resolve(workspacePath));
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  } catch {
    return undefined;
  }
}

function lexicalWorkspaceKey(workspacePath: string) {
  const resolved = path.resolve(workspacePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function mappedIdentity(identities: Map<string, string>, candidate: string) {
  const existing = identities.get(candidate);
  if (existing) return existing;
  let matchedAlias: string | undefined;
  let matchedIdentity: string | undefined;
  for (const [alias, identity] of identities) {
    if (pathContains(alias, candidate) && (!matchedAlias || alias.length > matchedAlias.length)) {
      matchedAlias = alias;
      matchedIdentity = identity;
    }
  }
  return matchedAlias && matchedIdentity
    ? lexicalWorkspaceKey(path.join(matchedIdentity, path.relative(matchedAlias, candidate)))
    : undefined;
}

function pathsOverlap(first: string, second: string) {
  return pathContains(first, second) || pathContains(second, first);
}

function pathContains(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
