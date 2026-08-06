import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Project, ProjectWorkspace } from './types.js';
import { assertDirectory, projectId, resolveWithin, safeProjectName } from './util.js';
import { workspaceLifecycleKey, WorkspaceLifecycleConflictError, type WorkspaceLifecycleCoordinator } from './workspaceLifecycle.js';

type ProjectMetadataUpdate = { color?: string | null; image?: string | null };
type ProjectRouteOptions = {
  workspaceLifecycle?: WorkspaceLifecycleCoordinator;
  worktreeRoot?: string;
  beforeWorkspaceDelete?: (worktreePath: string, projectPaths: string[]) => Promise<void>;
  platform?: NodeJS.Platform;
};
type WorktreeEntry = { path?: string; branch?: string; locked?: boolean; prunable?: boolean };
type OpenFilesystemIdentity = {
  handle: { close: () => Promise<void> };
  dev: bigint;
  ino: bigint;
  kind: 'directory' | 'file' | 'other';
};
type WorktreeFilesystemIdentity = {
  root?: OpenFilesystemIdentity;
  administrationPath?: string;
  administration?: OpenFilesystemIdentity;
};

class WorkspaceDeletionConflictError extends Error {
  readonly statusCode = 409;
}

const PROJECT_COLOR_IDS = new Set([
  'slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
]);
const PROJECT_METADATA_PATH = path.join('.pi-web', 'project.json');
const WORKTREE_BRANCH_PREFIX = 'pi-web/';
const WORKTREE_ROOT = path.join(homedir(), '.pi-web', 'worktrees');
const execFileAsync = promisify(execFile);

export class ProjectRegistry {
  private readonly projects = new Map<string, Project>();
  private readonly blockedProjects = new Map<string, string>();
  private readonly managedWorktreeRoots = new Set<string>();

  constructor(initialWorkspace?: string) {
    if (initialWorkspace) this.add(initialWorkspace);
  }

  list(options?: { includeHidden?: boolean }) {
    return [...this.projects.values()].filter((project) => options?.includeHidden || !project.hidden);
  }

  add(projectPath: string, options?: { hidden?: boolean }) {
    const resolved = assertDirectory(path.resolve(projectPath));
    if ([...this.managedWorktreeRoots].some((worktreeRoot) => isManagedDeletionQuarantineProjectPath(resolved, worktreeRoot))) {
      throw new Error('This path resolves into a preserved workspace deletion quarantine and is available only for manual recovery.');
    }
    const id = projectId(resolved);
    const existing = this.projects.get(id);
    const project: Project = {
      id,
      name: safeProjectName(resolved),
      path: resolved,
      ...readProjectMetadata(resolved),
      hidden: options?.hidden ? (existing ? existing.hidden : true) : undefined,
    };
    this.projects.set(project.id, project);
    return project;
  }

  addManagedWorktreeRoot(worktreeRoot: string) {
    this.managedWorktreeRoots.add(path.resolve(worktreeRoot));
    if ([...this.projects.values()].some((project) => isManagedDeletionQuarantineProjectPath(project.path, worktreeRoot))) {
      throw new Error('A configured project resolves into a preserved workspace deletion quarantine and is available only for manual recovery.');
    }
  }

  get(id: string) {
    const project = this.projects.get(id);
    if (!project) throw new Error(`Unknown project: ${id}`);
    return project;
  }

  getOrAdd(id: string, projectPath?: string, options?: { hidden?: boolean }) {
    const project = this.projects.get(id);
    if (project) return project;
    if (!projectPath) throw new Error(`Unknown project: ${id}`);

    const resolved = assertDirectory(projectPath);
    if (projectId(resolved) !== id) throw new Error(`Unknown project: ${id}`);
    return this.add(resolved, options);
  }

  async update(id: string, update: ProjectMetadataUpdate) {
    const project = this.get(id);
    const nextProject = { ...project };
    if ('color' in update) nextProject.color = normalizeProjectColor(update.color);
    if ('image' in update) nextProject.image = normalizeProjectImage(project.path, update.image);
    await writeProjectMetadata(nextProject);
    this.projects.set(id, nextProject);
    return nextProject;
  }

  remove(id: string) {
    const project = this.get(id);
    this.projects.delete(id);
    this.blockedProjects.delete(id);
    return project;
  }

  blockReason(id: string) {
    return this.blockedProjects.get(id);
  }

  blockWithin(rootPath: string, reason: string) {
    for (const id of this.idsWithin(rootPath)) this.blockedProjects.set(id, reason);
  }

  projectsWithin(rootPath: string) {
    const rootKey = workspaceLifecycleKey(rootPath);
    const rootLexical = lexicalPath(rootPath);
    return [...this.projects.values()]
      .filter((project) => pathContains(rootKey, workspaceLifecycleKey(project.path)) || pathContains(rootLexical, lexicalPath(project.path)));
  }

  idsWithin(rootPath: string) {
    return this.projectsWithin(rootPath).map((project) => project.id);
  }

  removeIds(ids: Iterable<string>) {
    for (const id of ids) {
      this.projects.delete(id);
      this.blockedProjects.delete(id);
    }
  }
}

export async function registerProjectRoutes(app: FastifyInstance, registry: ProjectRegistry, options: ProjectRouteOptions = {}) {
  const worktreeRoot = options.worktreeRoot ?? WORKTREE_ROOT;
  registry.addManagedWorktreeRoot(worktreeRoot);
  app.get('/api/projects', async () => ({ projects: registry.list() }));

  app.get<{ Querystring: { query?: string } }>('/api/projects/folders', async (request) => ({ folders: await findFolders(request.query.query ?? '') }));

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/workspaces', async (request, reply) => {
    try {
      return { workspaces: await listProjectWorkspaces(registry, registry.get(request.params.projectId), worktreeRoot, options.workspaceLifecycle) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not list workspaces' });
    }
  });

  app.post<{ Params: { projectId: string }; Body: { name?: string } }>('/api/projects/:projectId/workspaces', async (request, reply) => {
    try {
      return { workspace: await createProjectWorkspace(registry, registry.get(request.params.projectId), request.body?.name, worktreeRoot) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not create workspace' });
    }
  });

  app.get<{ Params: { projectId: string; workspaceId: string } }>('/api/projects/:projectId/workspaces/:workspaceId/deletion-scope', async (request, reply) => {
    try {
      return await projectWorkspaceDeletionScope(registry, registry.get(request.params.projectId), request.params.workspaceId, worktreeRoot);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not resolve workspace deletion scope' });
    }
  });

  app.delete<{ Params: { projectId: string; workspaceId: string }; Querystring: { force?: string; scope?: string } }>('/api/projects/:projectId/workspaces/:workspaceId', async (request, reply) => {
    try {
      await deleteProjectWorkspace(registry, registry.get(request.params.projectId), request.params.workspaceId, {
        force: request.query.force === 'true',
        workspaceLifecycle: options.workspaceLifecycle,
        worktreeRoot,
        beforeWorkspaceDelete: options.beforeWorkspaceDelete,
        platform: options.platform ?? process.platform,
        expectedScope: request.query.scope,
      });
      return { ok: true };
    } catch (error) {
      const statusCode = error instanceof WorkspaceLifecycleConflictError || error instanceof WorkspaceDeletionConflictError ? error.statusCode : 400;
      return reply.code(statusCode).send({ error: error instanceof Error ? error.message : 'Could not delete workspace' });
    }
  });

  app.post<{ Body: { path: string } }>('/api/projects', async (request, reply) => {
    if (!request.body?.path) return reply.code(400).send({ error: 'Missing path' });
    const projectPath = expandHome(request.body.path, homedir());
    let workspaceLease;
    try {
      workspaceLease = options.workspaceLifecycle?.acquireActivity(projectPath);
      return { project: registry.add(projectPath) };
    } catch (error) {
      const statusCode = error instanceof WorkspaceLifecycleConflictError ? error.statusCode : 400;
      return reply.code(statusCode).send({ error: error instanceof Error ? error.message : 'Invalid project' });
    } finally {
      workspaceLease?.release();
    }
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId', async (request, reply) => {
    try {
      return { project: registry.get(request.params.projectId) };
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : 'Unknown project' });
    }
  });

  app.patch<{ Params: { projectId: string }; Body: ProjectMetadataUpdate }>('/api/projects/:projectId', async (request, reply) => {
    try {
      const body = request.body && typeof request.body === 'object' ? request.body : {};
      return { project: await registry.update(request.params.projectId, body) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not update project' });
    }
  });

  app.delete<{ Params: { projectId: string } }>('/api/projects/:projectId', async (request, reply) => {
    try {
      return { project: registry.remove(request.params.projectId) };
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : 'Unknown project' });
    }
  });
}

async function listProjectWorkspaces(
  registry: ProjectRegistry,
  project: Project,
  worktreeRoot: string,
  workspaceLifecycle?: WorkspaceLifecycleCoordinator,
): Promise<ProjectWorkspace[]> {
  const context = await gitWorkspaceContext(project.path);
  const entries = parseWorktreeList((await runGit(context.repoRoot, ['worktree', 'list', '--porcelain'])).stdout);
  const localBranch = (await runGit(project.path, ['branch', '--show-current']).catch(() => ({ stdout: '' }))).stdout.trim();
  const workspaces: ProjectWorkspace[] = [{
    id: project.id,
    rootProjectId: project.id,
    name: project.name,
    path: project.path,
    branch: localBranch || undefined,
    local: true,
    removable: false,
  }];

  for (const entry of entries) {
    if (!entry.path) continue;
    if (samePath(entry.path, context.repoRoot)) continue;
    const workspacePath = path.join(entry.path, context.relativeProjectPath);
    if (!isDirectory(workspacePath)
      || isManagedDeletionQuarantinePath(entry.path, worktreeRoot)
      || workspaceLifecycle?.isDeleting(workspacePath)) continue;
    const workspaceProject = registry.add(workspacePath, { hidden: true });
    const branch = normalizeBranch(entry.branch);
    workspaces.push({
      id: workspaceProject.id,
      rootProjectId: project.id,
      name: workspaceName(context.repoRoot, entry.path, branch),
      path: workspacePath,
      branch,
      local: false,
      removable: isManagedWorktreePath(project.id, entry.path, worktreeRoot),
    });
  }

  return workspaces;
}

async function createProjectWorkspace(registry: ProjectRegistry, project: Project, name: string | undefined, worktreeRoot: string): Promise<ProjectWorkspace> {
  const context = await gitWorkspaceContext(project.path);
  const info = await nextWorktreeInfo(project.id, context.repoRoot, name, worktreeRoot);
  await mkdir(path.dirname(info.directory), { recursive: true });

  const created = await runGit(context.repoRoot, ['worktree', 'add', '--no-checkout', '-b', info.branch, info.directory]).catch((error) => {
    throw new Error(gitErrorMessage(error, 'Failed to create git worktree'));
  });
  if (created.stderr && /fatal:/i.test(created.stderr)) throw new Error(created.stderr.trim());

  await runGit(info.directory, ['reset', '--hard']).catch(async (error) => {
    await runGit(context.repoRoot, ['worktree', 'remove', '--force', info.directory]).catch(() => undefined);
    await removeWorktreeDirectory(info.directory).catch(() => undefined);
    await runGit(context.repoRoot, ['branch', '-D', info.branch]).catch(() => undefined);
    throw new Error(gitErrorMessage(error, 'Failed to populate git worktree'));
  });

  try {
    const workspacePath = path.join(info.directory, context.relativeProjectPath);
    const workspaceProject = registry.add(workspacePath, { hidden: true });
    return {
      id: workspaceProject.id,
      rootProjectId: project.id,
      name: workspaceName(context.repoRoot, info.directory, info.branch),
      path: workspacePath,
      branch: info.branch,
      local: false,
      removable: true,
    };
  } catch (error) {
    await runGit(context.repoRoot, ['worktree', 'remove', '--force', info.directory]).catch(() => undefined);
    await removeWorktreeDirectory(info.directory).catch(() => undefined);
    await runGit(context.repoRoot, ['branch', '-D', info.branch]).catch(() => undefined);
    throw error;
  }
}

async function projectWorkspaceDeletionScope(registry: ProjectRegistry, project: Project, workspaceId: string, worktreeRoot: string) {
  if (workspaceId === project.id) throw new Error('Cannot delete the local workspace');
  const workspaceProject = registry.get(workspaceId);
  const context = await gitWorkspaceContext(project.path);
  const entries = parseWorktreeList((await runGit(context.repoRoot, ['worktree', 'list', '--porcelain'])).stdout);
  const entry = entries.find((item) => item.path && sameLexicalPath(path.join(item.path, context.relativeProjectPath), workspaceProject.path));
  const worktreePath = entry?.path ?? worktreePathFromWorkspacePath(workspaceProject.path, context.relativeProjectPath);
  if (!sameLexicalPath(path.join(worktreePath, context.relativeProjectPath), workspaceProject.path)) throw new Error('Unknown git worktree');
  if (!isManagedWorktreePath(project.id, worktreePath, worktreeRoot)) throw new Error('Only pi-web generated workspaces can be deleted');
  return workspaceDeletionScope(registry, worktreePath, workspaceId);
}

function workspaceDeletionScope(registry: ProjectRegistry, worktreePath: string, workspaceId: string) {
  const projects = [registry.get(workspaceId), ...registry.projectsWithin(worktreePath)]
    .filter((project, index, items) => items.findIndex((item) => item.id === project.id) === index);
  const workspaceIds = projects.map((project) => project.id).sort();
  const projectPaths = projects.map((project) => project.path);
  const lockTargets = workspaceDeletionLockTargets(worktreePath, projectPaths);
  const participants = registry.list({ includeHidden: true }).filter((project) => (
    workspaceIds.includes(project.id)
    || lockTargets.some(({ key }) => pathsOverlap(key, workspaceLifecycleKey(project.path)))
  ));
  const participantIds = participants.map((project) => project.id).sort();
  const identity = {
    workspaces: workspaceIds.map((id) => {
      const project = registry.get(id);
      return [id, lexicalPath(project.path), workspaceLifecycleKey(project.path)];
    }),
    participants: participantIds.map((id) => {
      const project = registry.get(id);
      return [id, workspaceLifecycleKey(project.path)];
    }),
  };
  const scopeToken = createHash('sha256').update(JSON.stringify(identity)).digest('base64url');
  return { workspaceIds, projectPaths, participantIds, scopeToken };
}

function workspaceDeletionLockTargets(worktreePath: string, projectPaths: string[]) {
  const candidates = [worktreePath, ...projectPaths]
    .map((projectPath) => ({ path: projectPath, key: workspaceLifecycleKey(projectPath) }))
    .filter(({ key }, index, items) => items.findIndex((item) => item.key === key) === index)
    .sort((left, right) => left.key.split(path.sep).length - right.key.split(path.sep).length || left.key.localeCompare(right.key));
  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    if (!selected.some(({ key }) => pathContains(key, candidate.key))) selected.push(candidate);
  }
  return selected;
}

function workspaceDeletionLockPaths(worktreePath: string, projectPaths: string[]) {
  return workspaceDeletionLockTargets(worktreePath, projectPaths).map((item) => item.path);
}

async function deleteProjectWorkspace(
  registry: ProjectRegistry,
  project: Project,
  workspaceId: string,
  options: { force?: boolean; workspaceLifecycle?: WorkspaceLifecycleCoordinator; worktreeRoot: string; beforeWorkspaceDelete?: (worktreePath: string, projectPaths: string[]) => Promise<void>; platform: NodeJS.Platform; expectedScope?: string },
) {
  if (workspaceId === project.id) throw new Error('Cannot delete the local workspace');
  const workspaceProject = registry.get(workspaceId);
  if (options.platform === 'win32') {
    throw new WorkspaceDeletionConflictError('Workspace deletion is disabled on Windows because Pi Web cannot prove that all terminal and command processes have exited. Nothing was deleted.');
  }
  const context = await gitWorkspaceContext(project.path);
  const entries = parseWorktreeList((await runGit(context.repoRoot, ['worktree', 'list', '--porcelain'])).stdout);
  const initialEntry = entries.find((item) => item.path && sameLexicalPath(path.join(item.path, context.relativeProjectPath), workspaceProject.path));
  const worktreePath = initialEntry?.path ?? worktreePathFromWorkspacePath(workspaceProject.path, context.relativeProjectPath);
  if (!samePath(path.join(worktreePath, context.relativeProjectPath), workspaceProject.path)) throw new Error('Unknown git worktree');
  if (!isManagedWorktreePath(project.id, worktreePath, options.worktreeRoot)) throw new Error('Only pi-web generated workspaces can be deleted');
  if (isDeletionQuarantinePath(worktreePath)) {
    throw new WorkspaceDeletionConflictError('This path is a preserved workspace deletion quarantine. Nothing was deleted; recover or remove it manually.');
  }
  const preservedQuarantine = await findPreservedQuarantine(worktreePath);
  if (preservedQuarantine) {
    const message = `A previous deletion could not restore this workspace. Nothing was deleted; workspace files remain at ${preservedQuarantine} for manual recovery.`;
    registry.blockWithin(worktreePath, message);
    throw new WorkspaceDeletionConflictError(message);
  }
  if (initialEntry?.locked) throw new WorkspaceDeletionConflictError('Workspace is locked by Git. Unlock it before deleting.');
  if (initialEntry?.prunable) throw new WorkspaceDeletionConflictError('Git reports this workspace as prunable or missing. Nothing was deleted; inspect the worktree path and run Git worktree repair or prune manually.');
  const initialFilesystemIdentity = await captureWorktreeFilesystemIdentity(worktreePath);
  const initialScope = workspaceDeletionScope(registry, worktreePath, workspaceId);
  const deletionLeases: Array<{ release: () => void }> = [];
  try {
    if (initialEntry?.path && (!initialFilesystemIdentity.root || !initialFilesystemIdentity.administrationPath || !initialFilesystemIdentity.administration)) {
      throw new WorkspaceDeletionConflictError('Could not verify the Git worktree identity. Nothing was deleted; repair the worktree metadata manually.');
    }
    for (const lockPath of workspaceDeletionLockPaths(worktreePath, initialScope.projectPaths)) {
      const lease = options.workspaceLifecycle?.acquireDeletion(lockPath);
      if (lease) deletionLeases.push(lease);
    }
    const lockedScope = workspaceDeletionScope(registry, worktreePath, workspaceId);
    if (lockedScope.scopeToken !== initialScope.scopeToken) {
      throw new WorkspaceDeletionConflictError('Workspace deletion scope changed while deletion was locking. Nothing was deleted; refresh the workspace list and retry.');
    }
    if (options.expectedScope && options.expectedScope !== lockedScope.scopeToken) {
      throw new WorkspaceDeletionConflictError('Workspace deletion scope changed. Nothing was deleted; refresh the workspace list and retry.');
    }
    const projectIdsToRemove = lockedScope.workspaceIds;
    await options.beforeWorkspaceDelete?.(worktreePath, lockedScope.projectPaths);
    const refreshedScope = workspaceDeletionScope(registry, worktreePath, workspaceId);
    if (refreshedScope.scopeToken !== lockedScope.scopeToken) {
      throw new WorkspaceDeletionConflictError('Workspace deletion scope changed while deletion was preparing. Nothing was deleted; refresh the workspace list and retry.');
    }
    const quarantineAfterLease = await findPreservedQuarantine(worktreePath);
    if (quarantineAfterLease) {
      const message = `A previous deletion could not restore this workspace. Nothing was deleted; workspace files remain at ${quarantineAfterLease} for manual recovery.`;
      registry.blockWithin(worktreePath, message);
      throw new WorkspaceDeletionConflictError(message);
    }
    const refreshedEntries = parseWorktreeList((await runGit(context.repoRoot, ['worktree', 'list', '--porcelain'])).stdout);
    const entry = refreshedEntries.find((item) => item.path && sameLexicalPath(path.join(item.path, context.relativeProjectPath), workspaceProject.path));
    const refreshedPath = await lstat(worktreePath).catch(() => undefined);
    const registrationChanged = Boolean(initialEntry?.path) !== Boolean(entry?.path)
      || !await worktreeFilesystemIdentityMatches(worktreePath, initialFilesystemIdentity);
    if (registrationChanged) {
      throw new WorkspaceDeletionConflictError('The Git worktree identity changed while deletion was preparing. Nothing was deleted; refresh the workspace list and retry.');
    }

    if (!entry?.path) {
      const stalePath = refreshedPath;
      if (!stalePath) {
        registry.removeIds(projectIdsToRemove);
        return;
      }
      if (!options.force) {
        throw new WorkspaceDeletionConflictError('Git no longer recognizes this workspace. Nothing was deleted. Force deletion is available only after Pi Web verifies the managed worktree metadata.');
      }
      await forceRemoveStaleManagedWorktree(context.repoRoot, worktreePath, initialFilesystemIdentity);
      registry.removeIds(projectIdsToRemove);
      return;
    }

    if (entry.locked || entry.prunable) {
      throw new WorkspaceDeletionConflictError('The Git worktree state changed while deletion was preparing. Nothing was deleted; refresh the workspace list and retry.');
    }
    if (await hasInitializedSubmodules(worktreePath)) {
      throw new WorkspaceDeletionConflictError('Git cannot safely move a linked worktree with initialized submodules. Nothing was deleted; deinitialize its submodules or remove the worktree manually.');
    }

    const quarantinePath = path.join(path.dirname(worktreePath), `.${path.basename(worktreePath)}.deleting-${randomUUID()}`);
    options.workspaceLifecycle?.bindDeletionAlias(worktreePath, quarantinePath);
    await moveGitWorktree(context.repoRoot, worktreePath, quarantinePath);
    try {
      await assertWorktreeFilesystemIdentity(quarantinePath, initialFilesystemIdentity);
      if (!options.force) await assertWorkspaceClean(quarantinePath);
      await stopFsmonitor(quarantinePath);
      await assertWorktreeFilesystemIdentity(quarantinePath, initialFilesystemIdentity);
      await removeGitWorktree(context.repoRoot, quarantinePath, Boolean(options.force));
      if (existsSync(quarantinePath)) {
        throw new Error(`Git removed the worktree registration, but files remain at ${quarantinePath}. Pi Web left them in place for manual recovery.`);
      }
      const branch = normalizeBranch(entry.branch);
      if (branch?.startsWith(WORKTREE_BRANCH_PREFIX)) {
        await runGit(context.repoRoot, ['branch', '-d', branch]).catch(() => undefined);
      }
      registry.removeIds([...projectIdsToRemove, ...registry.idsWithin(quarantinePath)]);
    } catch (error) {
      const preservedPath = await restoreMovedWorktree(context.repoRoot, quarantinePath, worktreePath);
      if (preservedPath) {
        const message = `${error instanceof Error ? error.message : 'Could not delete workspace'}. Workspace files were preserved at ${preservedPath}.`;
        registry.blockWithin(worktreePath, message);
        throw new WorkspaceDeletionConflictError(message);
      }
      throw error;
    }
  } finally {
    for (const lease of deletionLeases.reverse()) lease.release();
    await closeWorktreeFilesystemIdentity(initialFilesystemIdentity);
  }
}

async function worktreeAdministrationIdentity(worktreePath: string, markerBasePath = worktreePath) {
  const markerPath = path.join(worktreePath, '.git');
  const marker = await lstat(markerPath).catch(() => undefined);
  if (!marker?.isFile() || marker.isSymbolicLink()) return undefined;
  const match = /^gitdir:\s*(.+)\s*$/i.exec((await readFile(markerPath, 'utf8').catch(() => '')).trim());
  return match ? canonicalPath(path.resolve(markerBasePath, match[1])) : undefined;
}

function filesystemKind(stats: { isDirectory: () => boolean; isFile: () => boolean }): OpenFilesystemIdentity['kind'] {
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  return 'other';
}

async function captureOpenFilesystemIdentity(filePath: string) {
  let handle;
  try {
    const before = await lstat(filePath, { bigint: true });
    handle = await open(filePath, 'r');
    const opened = await handle.stat({ bigint: true });
    if (before.dev !== opened.dev || before.ino !== opened.ino || filesystemKind(before) !== filesystemKind(opened)) {
      throw new Error('Filesystem identity changed while it was being captured.');
    }
    return { handle, dev: before.dev, ino: before.ino, kind: filesystemKind(before) } satisfies OpenFilesystemIdentity;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new WorkspaceDeletionConflictError(`Could not capture the workspace filesystem identity: ${error instanceof Error ? error.message : 'identity inspection failed'}. Nothing was deleted.`);
  }
}

async function captureWorktreeFilesystemIdentity(worktreePath: string): Promise<WorktreeFilesystemIdentity> {
  const root = await captureOpenFilesystemIdentity(worktreePath);
  try {
    const administrationPath = await worktreeAdministrationIdentity(worktreePath);
    const administration = administrationPath ? await captureOpenFilesystemIdentity(administrationPath) : undefined;
    return { root, administrationPath, administration };
  } catch (error) {
    await root?.handle.close().catch(() => undefined);
    throw error;
  }
}

async function openFilesystemIdentityMatches(filePath: string, identity: OpenFilesystemIdentity | undefined) {
  const current = await lstat(filePath, { bigint: true }).catch(() => undefined);
  if (!identity) return !current;
  return Boolean(current)
    && current!.dev === identity.dev
    && current!.ino === identity.ino
    && filesystemKind(current!) === identity.kind;
}

async function worktreeFilesystemIdentityMatches(worktreePath: string, identity: WorktreeFilesystemIdentity, markerBasePath = worktreePath) {
  if (!await openFilesystemIdentityMatches(worktreePath, identity.root)) return false;
  const administrationPath = await worktreeAdministrationIdentity(worktreePath, markerBasePath);
  if (administrationPath !== identity.administrationPath) return false;
  return administrationPath
    ? openFilesystemIdentityMatches(administrationPath, identity.administration)
    : !identity.administration;
}

async function assertWorktreeFilesystemIdentity(worktreePath: string, identity: WorktreeFilesystemIdentity, markerBasePath = worktreePath) {
  if (!await worktreeFilesystemIdentityMatches(worktreePath, identity, markerBasePath)) {
    throw new WorkspaceDeletionConflictError('The Git worktree identity changed during deletion isolation. Nothing was deleted; workspace files were preserved for recovery.');
  }
}

async function closeWorktreeFilesystemIdentity(identity: WorktreeFilesystemIdentity) {
  await Promise.allSettled([identity.root?.handle.close(), identity.administration?.handle.close()].filter((task): task is Promise<void> => Boolean(task)));
}

async function hasInitializedSubmodules(worktreePath: string) {
  const { stdout } = await runGit(worktreePath, ['submodule', 'status', '--recursive']).catch((error) => {
    throw new WorkspaceDeletionConflictError(`Could not verify workspace submodules: ${gitErrorMessage(error, 'Git submodule status failed')}`);
  });
  return stdout.split(/\r?\n/).some((line) => line.length > 0 && !line.startsWith('-'));
}

async function assertWorkspaceClean(worktreePath: string) {
  const { stdout } = await runGit(worktreePath, [
    '-c', 'status.showUntrackedFiles=all',
    '-c', 'core.fsmonitor=false',
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none',
  ]).catch((error) => {
    throw new WorkspaceDeletionConflictError(`Could not verify all workspace files: ${gitErrorMessage(error, 'Git status failed')}`);
  });
  if (stdout.length) {
    throw new WorkspaceDeletionConflictError('Workspace contains uncommitted changes, untracked files, or ignored local files. Review them or force delete the workspace to permanently discard them.');
  }
  const { stdout: indexEntries } = await runGit(worktreePath, ['ls-files', '-v', '-z']).catch((error) => {
    throw new WorkspaceDeletionConflictError(`Could not verify all workspace files: ${gitErrorMessage(error, 'Git index inspection failed')}`);
  });
  if (indexEntries.split('\0').some((entry) => entry && (/^[a-z]$/.test(entry[0]) || entry[0] === 'S'))) {
    throw new WorkspaceDeletionConflictError('Workspace has tracked files hidden by Git index flags such as assume-unchanged or skip-worktree. Review them or force delete the workspace to permanently discard local changes.');
  }
}

async function assertStaleManagedWorktreeProvenance(repoRoot: string, quarantinedPath: string, originalWorktreePath: string) {
  const directory = await lstat(quarantinedPath).catch(() => undefined);
  const markerPath = path.join(quarantinedPath, '.git');
  const marker = await lstat(markerPath).catch(() => undefined);
  if (!directory?.isDirectory() || directory.isSymbolicLink() || !marker?.isFile() || marker.isSymbolicLink()) {
    throw new WorkspaceDeletionConflictError('Pi Web could not verify the stale workspace directory. Nothing was deleted; remove it manually after reviewing the path.');
  }
  const match = /^gitdir:\s*(.+)\s*$/i.exec((await readFile(markerPath, 'utf8')).trim());
  const commonGitOutput = await runGit(repoRoot, ['rev-parse', '--git-common-dir']).catch((error) => {
    throw new Error(gitErrorMessage(error, 'Could not verify the Git repository'));
  });
  const commonGitDirectory = path.resolve(repoRoot, commonGitOutput.stdout.trim());
  const administrationDirectory = match ? path.resolve(originalWorktreePath, match[1]) : '';
  if (!match || !pathIsWithin(path.join(commonGitDirectory, 'worktrees'), administrationDirectory)) {
    throw new WorkspaceDeletionConflictError('Pi Web could not verify the stale workspace Git metadata. Nothing was deleted; remove it manually after reviewing the path.');
  }
  const administration = await lstat(administrationDirectory).catch(() => undefined);
  if (administration?.isDirectory()) {
    const backpointer = await readFile(path.join(administrationDirectory, 'gitdir'), 'utf8').catch(() => '');
    if (!sameLexicalPath(path.resolve(administrationDirectory, backpointer.trim()), path.join(originalWorktreePath, '.git'))) {
      throw new WorkspaceDeletionConflictError('Pi Web could not verify the stale workspace Git backpointer. Nothing was deleted; remove it manually after reviewing the path.');
    }
  }
  return canonicalPath(administrationDirectory);
}

async function forceRemoveStaleManagedWorktree(repoRoot: string, worktreePath: string, expectedIdentity: WorktreeFilesystemIdentity) {
  const quarantinePath = path.join(path.dirname(worktreePath), `.${path.basename(worktreePath)}.deleting-${randomUUID()}`);
  await rename(worktreePath, quarantinePath);
  try {
    await assertWorktreeFilesystemIdentity(quarantinePath, expectedIdentity, worktreePath);
    const administrationIdentity = await assertStaleManagedWorktreeProvenance(repoRoot, quarantinePath, worktreePath);
    if (!expectedIdentity.administrationPath || administrationIdentity !== expectedIdentity.administrationPath) {
      throw new WorkspaceDeletionConflictError('The stale Git worktree identity changed while deletion was preparing. Nothing was deleted.');
    }
  } catch (error) {
    if (!await lstat(worktreePath).catch(() => undefined)) {
      await rename(quarantinePath, worktreePath).catch(() => undefined);
    }
    if (await lstat(quarantinePath).catch(() => undefined)) {
      throw new WorkspaceDeletionConflictError(`${error instanceof Error ? error.message : 'Pi Web could not verify the stale workspace.'} The selected directory was preserved at ${quarantinePath}.`);
    }
    throw error;
  }
  try {
    await assertWorktreeFilesystemIdentity(quarantinePath, expectedIdentity, worktreePath);
    await removeWorktreeDirectory(quarantinePath);
  } catch (error) {
    throw new Error(`${gitErrorMessage(error, 'Could not remove stale workspace')}. The workspace was moved to ${quarantinePath} for recovery.`);
  }
}

async function gitWorkspaceContext(projectPath: string) {
  const repoRoot = (await runGit(projectPath, ['rev-parse', '--show-toplevel']).catch(() => {
    throw new Error('Workspaces require a git repository');
  })).stdout.trim();
  if (!repoRoot) throw new Error('Workspaces require a git repository');
  const relativeProjectPath = path.relative(realpathSync.native(repoRoot), realpathSync.native(projectPath));
  if (relativeProjectPath.startsWith('..') || path.isAbsolute(relativeProjectPath)) throw new Error('Project is outside the git repository');
  return { repoRoot, relativeProjectPath };
}

async function nextWorktreeInfo(projectIdValue: string, repoRoot: string, name: string | undefined, worktreeRoot: string) {
  const base = slugify(name || `workspace-${Date.now().toString(36)}`) || `workspace-${Date.now().toString(36)}`;
  for (let index = 0; index < 50; index += 1) {
    const slug = index === 0 ? base : `${base}-${index + 1}`;
    const branch = `${WORKTREE_BRANCH_PREFIX}${slug}`;
    const directory = path.join(worktreeRoot, projectIdValue, slug);
    if (existsSync(directory)) continue;
    const branchExists = await runGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true).catch(() => false);
    if (!branchExists) return { branch, directory };
  }
  throw new Error('Failed to generate a unique workspace name');
}

function parseWorktreeList(text: string) {
  return text.split('\n').reduce<WorktreeEntry[]>((items, line) => {
    const trimmed = line.trim();
    if (!trimmed) return items;
    if (trimmed.startsWith('worktree ')) {
      items.push({ path: trimmed.slice('worktree '.length).trim() });
      return items;
    }
    const current = items[items.length - 1];
    if (current && trimmed.startsWith('branch ')) current.branch = trimmed.slice('branch '.length).trim();
    if (current && (trimmed === 'locked' || trimmed.startsWith('locked '))) current.locked = true;
    if (current && (trimmed === 'prunable' || trimmed.startsWith('prunable '))) current.prunable = true;
    return items;
  }, []);
}

function normalizeBranch(branch?: string) {
  return branch?.replace(/^refs\/heads\//, '');
}

function workspaceName(primaryRoot: string, worktreeRoot: string, branch?: string) {
  if (branch?.startsWith(WORKTREE_BRANCH_PREFIX)) return branch.slice(WORKTREE_BRANCH_PREFIX.length);
  const name = safeProjectName(worktreeRoot);
  return name.toLowerCase() === safeProjectName(primaryRoot).toLowerCase() ? safeProjectName(path.dirname(worktreeRoot)) : name;
}

function worktreePathFromWorkspacePath(workspacePath: string, relativeProjectPath: string) {
  const depth = relativeProjectPath.split(/[\\/]+/).filter((part) => part && part !== '.').length;
  return path.resolve(workspacePath, ...Array(depth).fill('..'));
}

async function stopFsmonitor(worktreePath: string) {
  if (isDirectory(worktreePath)) await runGit(worktreePath, ['fsmonitor--daemon', 'stop']).catch(() => undefined);
}

function isDeletionQuarantinePath(worktreePath: string) {
  const name = path.basename(worktreePath);
  return name.startsWith('.') && name.includes('.deleting-');
}

async function findPreservedQuarantine(worktreePath: string) {
  const prefix = `.${path.basename(worktreePath)}.deleting-`;
  const entries = await readdir(path.dirname(worktreePath), { withFileTypes: true }).catch((error) => {
    throw new WorkspaceDeletionConflictError(`Could not inspect the managed workspace directory for preserved recovery data: ${error instanceof Error ? error.message : 'directory inspection failed'}. Nothing was deleted.`);
  });
  const match = entries.find((candidate) => candidate.name.startsWith(prefix) && isDeletionQuarantinePath(candidate.name));
  return match ? path.join(path.dirname(worktreePath), match.name) : undefined;
}

async function moveGitWorktree(repoRoot: string, worktreePath: string, quarantinePath: string) {
  await runGit(repoRoot, ['worktree', 'move', worktreePath, quarantinePath]).catch((error) => {
    throw new WorkspaceDeletionConflictError(`Could not safely isolate the workspace before deletion: ${gitErrorMessage(error, 'Git worktree move failed')}`);
  });
}

async function restoreMovedWorktree(repoRoot: string, quarantinePath: string, worktreePath: string) {
  if (!await lstat(quarantinePath).catch(() => undefined)) return undefined;
  if (await lstat(worktreePath).catch(() => undefined)) return quarantinePath;
  try {
    await runGit(repoRoot, ['worktree', 'move', quarantinePath, worktreePath]);
    return undefined;
  } catch {
    return quarantinePath;
  }
}

async function removeGitWorktree(repoRoot: string, worktreePath: string, force: boolean) {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(worktreePath);
  await runGit(repoRoot, args).catch(async (error) => {
    const { stdout } = await runGit(repoRoot, ['worktree', 'list', '--porcelain']).catch((listError) => {
      throw new Error(gitErrorMessage(listError, gitErrorMessage(error, 'Failed to remove git worktree')));
    });
    const stillRegistered = parseWorktreeList(stdout).some((entry) => entry.path && samePath(entry.path, worktreePath));
    if (stillRegistered) throw new Error(gitErrorMessage(error, 'Failed to remove git worktree'));
  });
}

async function removeWorktreeDirectory(worktreePath: string) {
  const attempts = process.platform === 'win32' ? 50 : 5;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(worktreePath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function isManagedWorktreePath(projectIdValue: string, worktreePath: string, worktreeRoot: string) {
  const root = canonicalPath(path.join(worktreeRoot, projectIdValue));
  const target = canonicalPath(worktreePath);
  return path.dirname(target) === root;
}

function isManagedDeletionQuarantinePath(worktreePath: string, worktreeRoot: string) {
  return isManagedDeletionQuarantineProjectPath(worktreePath, worktreeRoot);
}

function isManagedDeletionQuarantineProjectPath(projectPath: string, worktreeRoot: string) {
  return pathContainsManagedDeletionQuarantine(lexicalPath(projectPath), lexicalPath(worktreeRoot))
    || pathContainsManagedDeletionQuarantine(canonicalPath(projectPath), canonicalPath(worktreeRoot));
}

function pathContainsManagedDeletionQuarantine(projectPath: string, worktreeRoot: string) {
  const relative = path.relative(worktreeRoot, projectPath);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep);
  return segments.length >= 2 && isDeletionQuarantinePath(segments[1]);
}

function pathsOverlap(first: string, second: string) {
  return pathContains(first, second) || pathContains(second, first);
}

function pathContains(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function lexicalPath(filePath: string) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameLexicalPath(left: string, right: string) {
  return lexicalPath(left) === lexicalPath(right);
}

function pathIsWithin(root: string, target: string) {
  const normalizedRoot = process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
  const normalizedTarget = process.platform === 'win32' ? path.resolve(target).toLowerCase() : path.resolve(target);
  return normalizedTarget !== normalizedRoot && normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

function isDirectory(value: string) {
  try {
    return existsSync(value) && assertDirectory(value) === path.resolve(value);
  } catch {
    return false;
  }
}

function samePath(left: string, right: string) {
  return canonicalPath(left) === canonicalPath(right);
}

function canonicalPath(value: string) {
  const resolved = path.resolve(value);
  try {
    const realPath = realpathSync.native(resolved);
    return process.platform === 'win32' ? realPath.toLowerCase() : realPath;
  } catch {
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}

async function runGit(cwd: string, args: string[]) {
  return execFileAsync('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 });
}

function gitErrorMessage(error: unknown, fallback: string) {
  const failed = error as { stderr?: string; stdout?: string; message?: string };
  return (failed.stderr || failed.stdout || failed.message || fallback).trim();
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

function readProjectMetadata(projectPath: string): Pick<Project, 'color' | 'image'> {
  try {
    const value = JSON.parse(readFileSync(path.join(projectPath, PROJECT_METADATA_PATH), 'utf8')) as ProjectMetadataUpdate;
    return {
      color: normalizeProjectColor(value.color),
      image: normalizeProjectImage(projectPath, value.image),
    };
  } catch {
    return {};
  }
}

async function writeProjectMetadata(project: Project) {
  const metadata = JSON.stringify({ color: project.color, image: project.image }, (_key, value) => value === undefined ? undefined : value, 2);
  const filePath = path.join(project.path, PROJECT_METADATA_PATH);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${metadata}\n`, 'utf8');
}

function normalizeProjectColor(value: unknown) {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !PROJECT_COLOR_IDS.has(value)) throw new Error('Invalid project color');
  return value;
}

function normalizeProjectImage(projectPath: string, value: unknown) {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('Invalid project image');
  const resolved = resolveWithin(projectPath, value);
  return path.relative(projectPath, resolved).split(path.sep).join('/');
}

type FolderSuggestion = { path: string; displayPath: string; name: string; search: string };

const SKIP_DIRECTORY_NAMES = new Set(['node_modules']);
const MIN_RECURSIVE_FOLDER_QUERY_LENGTH = 2;

async function findFolders(rawQuery: string) {
  const query = rawQuery.trim();
  const home = homedir();
  const candidates = new Map<string, FolderSuggestion>();
  const addFolder = async (folderPath: string) => {
    try {
      const resolved = assertDirectory(folderPath);
      const displayed = displayPath(resolved, home);
      const name = path.basename(resolved) || resolved;
      candidates.set(resolved, { path: resolved, displayPath: displayed, name, search: folderSuggestionSearch(resolved, displayed, name) });
      return true;
    } catch {
      // Ignore missing/inaccessible folders while building suggestions.
      return false;
    }
  };

  const addChildren = async (folderPath: string, filter = '', skipNames?: Set<string>) => {
    try {
      const resolved = assertDirectory(folderPath);
      const entries = await readdir(resolved, { withFileTypes: true });
      const normalizedFilter = filter.toLowerCase();
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        if (skipNames?.has(entry.name)) continue;
        if (normalizedFilter && !folderSuggestionMatches(entry.name, normalizedFilter)) continue;
        await addFolder(path.join(resolved, entry.name));
      }
    } catch {
      // Ignore missing/inaccessible folders while building suggestions.
    }
  };

  const addRecursiveMatches = async (folderPath: string, filter: string, maxDepth: number, limit: number, seen: Set<string>) => {
    const queue: { path: string; depth: number }[] = [{ path: folderPath, depth: 0 }];
    const maxExplored = 5000;
    while (queue.length > 0 && candidates.size < limit && seen.size < maxExplored) {
      const { path: currentPath, depth } = queue.shift()!;
      if (seen.has(currentPath)) continue;
      seen.add(currentPath);
      let entries: Dirent[];
      try {
        entries = await readdir(currentPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue;
        const childDepth = depth + 1;
        const childPath = path.join(currentPath, entry.name);
        if (childDepth <= maxDepth && folderSuggestionMatches(entry.name, filter)) await addFolder(childPath);
        if (childDepth < maxDepth) queue.push({ path: childPath, depth: childDepth });
      }
    }
  };

  if (looksLikePath(query)) {
    const expanded = expandHome(query, home);
    const queryHasTrailingSeparator = hasTrailingPathSeparator(query);
    const base = queryHasTrailingSeparator ? expanded : path.dirname(expanded);
    const filter = queryHasTrailingSeparator ? '' : path.basename(expanded);
    const expandedExists = await addFolder(expanded);
    await addChildren(base, filter);
    if (expandedExists && !queryHasTrailingSeparator) await addChildren(expanded);
  } else {
    const roots = [
      home,
      process.cwd(),
      path.dirname(process.cwd()),
      path.join(home, 'projects'),
      path.join(home, 'work'),
      path.join(home, 'code'),
      path.join(home, 'src'),
      path.join(home, 'Downloads'),
      path.join(home, 'courses'),
      path.join(home, 'notes'),
      path.join(home, 'Documents'),
    ];
    for (const root of roots) {
      await addFolder(root);
      await addChildren(root, query, SKIP_DIRECTORY_NAMES);
    }
    const recursiveQuery = normalizeFolderSuggestionSearch(query).replace(/\s/g, '');
    if (recursiveQuery.length >= MIN_RECURSIVE_FOLDER_QUERY_LENGTH) {
      const recursiveRoots = [...new Set([process.cwd(), path.dirname(process.cwd()), home])];
      const recursiveSeen = new Set<string>();
      for (const root of recursiveRoots) {
        await addRecursiveMatches(root, query, 5, 50, recursiveSeen);
      }
    }
  }

  const normalizedQuery = query.toLowerCase();
  return [...candidates.values()]
    .filter((folder) => !normalizedQuery || looksLikePath(query) || folderSuggestionMatches(folder.search, normalizedQuery))
    .sort((a, b) => folderSuggestionRank(a, query) - folderSuggestionRank(b, query) || a.displayPath.localeCompare(b.displayPath))
    .slice(0, 50);
}

function folderSuggestionSearch(folderPath: string, displayedPath: string, name: string) {
  const withoutSlash = (value: string) => value.replace(/[\\/]+$/g, '') || value;
  const withSlash = (value: string) => value.endsWith('/') ? value : `${value}/`;
  return [...new Set([folderPath, withSlash(folderPath), displayedPath, withoutSlash(displayedPath), withSlash(displayedPath), name].filter(Boolean))].join('\n');
}

function folderSuggestionMatches(value: string, query: string) {
  const haystack = value.toLowerCase();
  const needle = query.toLowerCase();
  if (haystack.includes(needle)) return true;
  const normalizedHaystack = normalizeFolderSuggestionSearch(haystack);
  const normalizedNeedle = normalizeFolderSuggestionSearch(needle);
  if (!normalizedNeedle) return false;
  return normalizedNeedle.split(' ').every((part) => normalizedHaystack.includes(part));
}

function folderSuggestionRank(folder: FolderSuggestion, query: string) {
  const normalizedQuery = normalizeFolderSuggestionPath(query);
  if (!normalizedQuery) return 0;
  const paths = [folder.path, folder.displayPath].map(normalizeFolderSuggestionPath);
  if (paths.includes(normalizedQuery)) return 0;
  if (folder.name.toLowerCase() === normalizedQuery) return 1;
  if (paths.some((value) => value.startsWith(`${normalizedQuery}/`) || value.startsWith(`${normalizedQuery}\\`))) return 2;
  if (folder.name.toLowerCase().startsWith(normalizedQuery)) return 3;
  return 4;
}

function normalizeFolderSuggestionPath(value: string) {
  return value.trim().toLowerCase().replace(/[\\/]+$/g, '');
}

function normalizeFolderSuggestionSearch(value: string) {
  return value.toLowerCase().replace(/[\\/_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function hasTrailingPathSeparator(query: string) {
  return /[\\/]$/.test(query);
}

function looksLikePath(query: string) {
  return query.startsWith('/') || query.startsWith('~') || query.startsWith('.') || query.includes('/') || query.includes('\\') || /^[A-Za-z]:[\\/]/.test(query);
}

function expandHome(value: string, home: string) {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    const rest = value.slice(2).replace(/^[\\/]+/, '');
    return rest ? path.join(home, rest) : home;
  }
  return path.resolve(value || home);
}

function displayPath(value: string, home: string) {
  const normalizedValue = value.split(path.sep).join('/');
  const normalizedHome = home.split(path.sep).join('/');
  if (normalizedValue === normalizedHome) return '~/';
  if (normalizedValue.startsWith(`${normalizedHome}/`)) return `~/${normalizedValue.slice(normalizedHome.length + 1)}/`;
  return `${normalizedValue}/`;
}
