import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Project, ProjectWorkspace } from './types.js';
import { assertDirectory, projectId, resolveWithin, safeProjectName } from './util.js';

type ProjectMetadataUpdate = { color?: string | null; image?: string | null };

const PROJECT_COLOR_IDS = new Set([
  'slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
]);
const PROJECT_METADATA_PATH = path.join('.pi-web', 'project.json');
const WORKTREE_BRANCH_PREFIX = 'pi-web/';
const WORKTREE_ROOT = path.join(homedir(), '.pi-web', 'worktrees');
const execFileAsync = promisify(execFile);

export class ProjectRegistry {
  private readonly projects = new Map<string, Project>();

  constructor(initialWorkspace?: string) {
    if (initialWorkspace) this.add(initialWorkspace);
  }

  list(options?: { includeHidden?: boolean }) {
    return [...this.projects.values()].filter((project) => options?.includeHidden || !project.hidden);
  }

  add(projectPath: string, options?: { hidden?: boolean }) {
    const resolved = assertDirectory(projectPath);
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

  get(id: string) {
    const project = this.projects.get(id);
    if (!project) throw new Error(`Unknown project: ${id}`);
    return project;
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
    return project;
  }
}

export async function registerProjectRoutes(app: FastifyInstance, registry: ProjectRegistry) {
  app.get('/api/projects', async () => ({ projects: registry.list() }));

  app.get<{ Querystring: { query?: string } }>('/api/projects/folders', async (request) => ({ folders: await findFolders(request.query.query ?? '') }));

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/workspaces', async (request, reply) => {
    try {
      return { workspaces: await listProjectWorkspaces(registry, registry.get(request.params.projectId)) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not list workspaces' });
    }
  });

  app.post<{ Params: { projectId: string }; Body: { name?: string } }>('/api/projects/:projectId/workspaces', async (request, reply) => {
    try {
      return { workspace: await createProjectWorkspace(registry, registry.get(request.params.projectId), request.body?.name) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not create workspace' });
    }
  });

  app.delete<{ Params: { projectId: string; workspaceId: string }; Querystring: { force?: string } }>('/api/projects/:projectId/workspaces/:workspaceId', async (request, reply) => {
    try {
      await deleteProjectWorkspace(registry, registry.get(request.params.projectId), request.params.workspaceId, { force: request.query.force === 'true' });
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not delete workspace' });
    }
  });

  app.post<{ Body: { path: string } }>('/api/projects', async (request, reply) => {
    if (!request.body?.path) return reply.code(400).send({ error: 'Missing path' });
    try {
      return { project: registry.add(expandHome(request.body.path, homedir())) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid project' });
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

async function listProjectWorkspaces(registry: ProjectRegistry, project: Project): Promise<ProjectWorkspace[]> {
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
    if (!isDirectory(workspacePath)) continue;
    const workspaceProject = registry.add(workspacePath, { hidden: true });
    const branch = normalizeBranch(entry.branch);
    workspaces.push({
      id: workspaceProject.id,
      rootProjectId: project.id,
      name: workspaceName(context.repoRoot, entry.path, branch),
      path: workspacePath,
      branch,
      local: false,
      removable: isManagedWorktreePath(project.id, entry.path),
    });
  }

  return workspaces;
}

async function createProjectWorkspace(registry: ProjectRegistry, project: Project, name?: string): Promise<ProjectWorkspace> {
  const context = await gitWorkspaceContext(project.path);
  const info = await nextWorktreeInfo(project.id, context.repoRoot, name);
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

async function deleteProjectWorkspace(registry: ProjectRegistry, project: Project, workspaceId: string, options?: { force?: boolean }) {
  if (workspaceId === project.id) throw new Error('Cannot delete the local workspace');
  const workspaceProject = registry.get(workspaceId);
  const context = await gitWorkspaceContext(project.path);
  const entries = parseWorktreeList((await runGit(context.repoRoot, ['worktree', 'list', '--porcelain'])).stdout);
  const entry = entries.find((item) => item.path && samePath(path.join(item.path, context.relativeProjectPath), workspaceProject.path));
  const worktreePath = entry?.path ?? worktreePathFromWorkspacePath(workspaceProject.path, context.relativeProjectPath);
  const branch = normalizeBranch(entry?.branch) ?? (entry?.path ? undefined : managedBranchFromWorktreePath(worktreePath));
  if (!samePath(path.join(worktreePath, context.relativeProjectPath), workspaceProject.path)) throw new Error('Unknown git worktree');
  if (!isManagedWorktreePath(project.id, worktreePath)) throw new Error('Only pi-web generated workspaces can be deleted');
  if (entry?.path && !options?.force) await assertWorkspaceClean(workspaceProject.path);

  await stopFsmonitor(worktreePath);
  if (entry?.path) await removeGitWorktree(context.repoRoot, worktreePath);
  await removeWorktreeDirectory(worktreePath);
  if (branch?.startsWith(WORKTREE_BRANCH_PREFIX)) {
    await runGit(context.repoRoot, ['branch', '-d', branch]).catch(() => undefined);
  }
  registry.remove(workspaceId);
}

async function assertWorkspaceClean(workspacePath: string) {
  const { stdout } = await runGit(workspacePath, ['status', '--porcelain=v1']).catch((error) => {
    throw new Error(gitErrorMessage(error, 'Could not verify workspace status'));
  });
  const changeCount = stdout.split('\n').filter(Boolean).length;
  if (changeCount) {
    throw new Error(`Workspace has ${changeCount} uncommitted ${changeCount === 1 ? 'change' : 'changes'}. Review them or force delete the workspace to discard them.`);
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

async function nextWorktreeInfo(projectIdValue: string, repoRoot: string, name?: string) {
  const base = slugify(name || `workspace-${Date.now().toString(36)}`) || `workspace-${Date.now().toString(36)}`;
  for (let index = 0; index < 50; index += 1) {
    const slug = index === 0 ? base : `${base}-${index + 1}`;
    const branch = `${WORKTREE_BRANCH_PREFIX}${slug}`;
    const directory = path.join(WORKTREE_ROOT, projectIdValue, slug);
    if (existsSync(directory)) continue;
    const branchExists = await runGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true).catch(() => false);
    if (!branchExists) return { branch, directory };
  }
  throw new Error('Failed to generate a unique workspace name');
}

function parseWorktreeList(text: string) {
  return text.split('\n').reduce<Array<{ path?: string; branch?: string }>>((items, line) => {
    const trimmed = line.trim();
    if (!trimmed) return items;
    if (trimmed.startsWith('worktree ')) {
      items.push({ path: trimmed.slice('worktree '.length).trim() });
      return items;
    }
    const current = items[items.length - 1];
    if (current && trimmed.startsWith('branch ')) current.branch = trimmed.slice('branch '.length).trim();
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

function managedBranchFromWorktreePath(worktreePath: string) {
  const name = path.basename(worktreePath);
  return name ? `${WORKTREE_BRANCH_PREFIX}${name}` : undefined;
}

async function stopFsmonitor(worktreePath: string) {
  if (isDirectory(worktreePath)) await runGit(worktreePath, ['fsmonitor--daemon', 'stop']).catch(() => undefined);
}

async function removeGitWorktree(repoRoot: string, worktreePath: string) {
  await runGit(repoRoot, ['worktree', 'remove', '--force', worktreePath]).catch(async (error) => {
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

function isManagedWorktreePath(projectIdValue: string, worktreePath: string) {
  const root = canonicalPath(path.join(WORKTREE_ROOT, projectIdValue));
  const target = canonicalPath(worktreePath);
  return target !== root && target.startsWith(`${root}${path.sep}`);
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

type FolderSuggestion = { path: string; displayPath: string; name: string };

async function findFolders(rawQuery: string) {
  const query = rawQuery.trim();
  const home = homedir();
  const candidates = new Map<string, FolderSuggestion>();
  const addFolder = async (folderPath: string) => {
    try {
      const resolved = assertDirectory(folderPath);
      candidates.set(resolved, { path: resolved, displayPath: displayPath(resolved, home), name: path.basename(resolved) || resolved });
    } catch {
      // Ignore missing/inaccessible folders while building suggestions.
    }
  };

  const addChildren = async (folderPath: string, filter = '') => {
    try {
      const resolved = assertDirectory(folderPath);
      const entries = await readdir(resolved, { withFileTypes: true });
      const normalizedFilter = filter.toLowerCase();
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        if (normalizedFilter && !entry.name.toLowerCase().includes(normalizedFilter)) continue;
        await addFolder(path.join(resolved, entry.name));
      }
    } catch {
      // Ignore missing/inaccessible folders while building suggestions.
    }
  };

  if (looksLikePath(query)) {
    const expanded = expandHome(query, home);
    const base = query.endsWith('/') || query.endsWith(path.sep) ? expanded : path.dirname(expanded);
    const filter = query.endsWith('/') || query.endsWith(path.sep) ? '' : path.basename(expanded);
    await addFolder(expanded);
    await addChildren(base, filter);
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
      await addChildren(root, query);
    }
  }

  const normalizedQuery = query.toLowerCase();
  return [...candidates.values()]
    .filter((folder) => !normalizedQuery || looksLikePath(query) || folder.displayPath.toLowerCase().includes(normalizedQuery) || folder.name.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => a.displayPath.localeCompare(b.displayPath))
    .slice(0, 50);
}

function looksLikePath(query: string) {
  return query.startsWith('/') || query.startsWith('~') || query.startsWith('.') || query.includes(path.sep);
}

function expandHome(value: string, home: string) {
  if (value === '~') return home;
  if (value.startsWith(`~${path.sep}`)) return path.join(home, value.slice(2));
  return path.resolve(value || home);
}

function displayPath(value: string, home: string) {
  return value === home ? '~/' : value.startsWith(`${home}${path.sep}`) ? `~/${path.relative(home, value)}/` : `${value}/`;
}
