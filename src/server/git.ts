import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ProjectRegistry } from './projects.js';
import type { GitFileChange, GitStatus } from './types.js';
import { resolveWithin } from './util.js';

const execFileAsync = promisify(execFile);
const MAX_GIT_FILE_DIFF_BYTES = 1024 * 1024;
const GIT_ENV = { ...process.env, GIT_LITERAL_PATHSPECS: '1' };
const GIT_DISCOVERY_PATHSPECS = ['.', ':(exclude,glob)**/.pi-web', ':(exclude,glob)**/.pi-web/**'];
type GitProjectContext = { projectPrefix: string };
type GitFileChangeAccumulator = GitFileChange & { stagedStatus: string; unstagedStatus: string };

export async function registerGitRoutes(app: FastifyInstance, registry: ProjectRegistry) {
  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/git/status', async (request, reply) => {
    try {
      return { status: await getGitStatus(registry.get(request.params.projectId).path) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Git status failed' });
    }
  });

  app.get<{ Params: { projectId: string }; Querystring: { path?: string; staged?: string } }>(
    '/api/projects/:projectId/git/diff',
    async (request, reply) => {
      try {
        const cwd = registry.get(request.params.projectId).path;
        return { diff: await gitDiff(cwd, request.query.path, request.query.staged === 'true') };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : 'Git diff failed' });
      }
    },
  );

  app.get<{ Params: { projectId: string }; Querystring: { path?: string; staged?: string } }>(
    '/api/projects/:projectId/git/file-diff',
    async (request, reply) => {
      if (!request.query.path) return reply.code(400).send({ error: 'Missing path' });
      try {
        const cwd = registry.get(request.params.projectId).path;
        return await gitFileDiff(cwd, request.query.path, request.query.staged === 'true');
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : 'Git file diff failed' });
      }
    },
  );

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/git/log', async (request, reply) => {
    try {
      const cwd = registry.get(request.params.projectId).path;
      const { stdout } = await runGit(cwd, ['log', '--graph', '--decorate', '--oneline', '--date=relative', '--pretty=format:%h%x09%an%x09%ar%x09%d%x09%s', '-80']);
      return { log: stdout.split('\n').filter(Boolean) };
    } catch {
      return { log: [] };
    }
  });

  app.post<{ Params: { projectId: string }; Body: { path?: string } }>('/api/projects/:projectId/git/stage', async (request, reply) => {
    if (!request.body?.path) return reply.code(400).send({ error: 'Missing path' });
    try {
      const cwd = registry.get(request.params.projectId).path;
      await stageChanges(cwd, request.body.path);
      return { status: await getGitStatus(cwd) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Git stage failed' });
    }
  });

  app.post<{ Params: { projectId: string }; Body: { path?: string } }>('/api/projects/:projectId/git/unstage', async (request, reply) => {
    if (!request.body?.path) return reply.code(400).send({ error: 'Missing path' });
    try {
      const cwd = registry.get(request.params.projectId).path;
      await unstageChanges(cwd, request.body.path);
      return { status: await getGitStatus(cwd) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Git unstage failed' });
    }
  });

  app.post<{ Params: { projectId: string }; Body: { path?: string } }>('/api/projects/:projectId/git/discard', async (request, reply) => {
    if (!request.body?.path) return reply.code(400).send({ error: 'Missing path' });
    try {
      const cwd = registry.get(request.params.projectId).path;
      await discardChanges(cwd, request.body.path);
      return { status: await getGitStatus(cwd) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Git discard failed' });
    }
  });

  app.post<{ Params: { projectId: string }; Body: { message?: string } }>('/api/projects/:projectId/git/commit', async (request, reply) => {
    if (!request.body?.message?.trim()) return reply.code(400).send({ error: 'Missing commit message' });
    try {
      const cwd = registry.get(request.params.projectId).path;
      await assertNoStagedChangesOutsideProject(cwd);
      await runGit(cwd, ['commit', '-m', request.body.message.trim()]);
      return { status: await getGitStatus(cwd) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Git commit failed' });
    }
  });
}

export async function getGitBranch(cwd: string) {
  const { stdout } = await runGit(cwd, ['branch', '--show-current']);
  return stdout.trim() || 'detached';
}

export async function getGitStatus(cwd: string): Promise<GitStatus> {
  const context = await gitProjectContext(cwd).catch(() => undefined);
  if (!context) return { branch: 'detached', files: [] };

  const [{ stdout: branchOut }, { stdout: statusOut }, stagedStats, unstagedStats] = await Promise.all([
    runGit(cwd, ['branch', '--show-current']).catch(() => ({ stdout: '' })),
    runGitDiscovery(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...GIT_DISCOVERY_PATHSPECS]).catch(() => ({ stdout: '' })),
    diffStats(cwd, true, context),
    diffStats(cwd, false, context),
  ]);

  const byPath = new Map<string, GitFileChangeAccumulator>();
  const statusEntries = statusOut.split('\0');
  for (let index = 0; index < statusEntries.length; index += 1) {
    const line = statusEntries[index];
    if (!line) continue;
    const x = line[0] ?? ' ';
    const y = line[1] ?? ' ';
    const rawFilePath = line.slice(3);
    const rawOldPath = /[RC]/.test(`${x}${y}`) ? statusEntries[++index] : undefined;
    const filePath = gitPathToProjectPath(context, rawFilePath);
    if (filePath === undefined || isReservedAppStatePath(filePath)) continue;
    const oldPath = rawOldPath ? gitPathToProjectPath(context, rawOldPath) : undefined;
    const existing = byPath.get(filePath) ?? emptyGitFileChange(filePath);
    const stagedStatus = x !== ' ' && x !== '?' ? x : ' ';
    const unstagedStatus = x === '?' ? '?' : y;
    if (oldPath) existing.oldPath ??= oldPath;
    if (stagedStatus !== ' ') existing.stagedStatus = stagedStatus;
    if (unstagedStatus !== ' ') existing.unstagedStatus = unstagedStatus;
    existing.staged = existing.staged || stagedStatus !== ' ';
    existing.unstaged = existing.unstaged || unstagedStatus !== ' ';
    existing.status = formatGitStatus(existing.stagedStatus, existing.unstagedStatus);
    byPath.set(filePath, existing);
  }

  for (const [filePath, stat] of stagedStats) {
    const existing = byPath.get(filePath) ?? emptyGitFileChange(filePath);
    if (!existing.staged) {
      existing.staged = true;
      existing.stagedStatus = 'M';
      existing.status = formatGitStatus(existing.stagedStatus, existing.unstagedStatus);
    }
    existing.additions = (existing.additions ?? 0) + stat.additions;
    existing.deletions = (existing.deletions ?? 0) + stat.deletions;
    existing.stagedAdditions = (existing.stagedAdditions ?? 0) + stat.additions;
    existing.stagedDeletions = (existing.stagedDeletions ?? 0) + stat.deletions;
    byPath.set(filePath, existing);
  }

  for (const [filePath, stat] of unstagedStats) {
    const existing = byPath.get(filePath) ?? emptyGitFileChange(filePath);
    if (!existing.unstaged) {
      existing.unstaged = true;
      existing.unstagedStatus = 'M';
      existing.status = formatGitStatus(existing.stagedStatus, existing.unstagedStatus);
    }
    existing.additions = (existing.additions ?? 0) + stat.additions;
    existing.deletions = (existing.deletions ?? 0) + stat.deletions;
    existing.unstagedAdditions = (existing.unstagedAdditions ?? 0) + stat.additions;
    existing.unstagedDeletions = (existing.unstagedDeletions ?? 0) + stat.deletions;
    byPath.set(filePath, existing);
  }

  return {
    branch: branchOut.trim() || 'detached',
    files: [...byPath.values()]
      .map(({ stagedStatus, unstagedStatus, ...file }) => file)
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function emptyGitFileChange(filePath: string): GitFileChangeAccumulator {
  return {
    path: filePath,
    status: 'M',
    staged: false,
    unstaged: false,
    additions: 0,
    deletions: 0,
    stagedAdditions: 0,
    stagedDeletions: 0,
    unstagedAdditions: 0,
    unstagedDeletions: 0,
    stagedStatus: ' ',
    unstagedStatus: ' ',
  };
}

function formatGitStatus(stagedStatus: string, unstagedStatus: string) {
  if (stagedStatus === ' ' && unstagedStatus === '?') return '??';
  if (stagedStatus === ' ') return unstagedStatus.trim() || 'M';
  if (unstagedStatus === ' ') return stagedStatus;
  return `${stagedStatus}${unstagedStatus}`;
}

async function gitDiff(cwd: string, filePath?: string, staged = false, oldPath?: string) {
  const args = ['diff', '--no-ext-diff', '--no-color'];
  if (staged) args.push('--cached');
  if (filePath) {
    const paths = oldPath && oldPath !== filePath ? [oldPath, filePath] : [filePath];
    for (const path of paths) {
      resolveWithin(cwd, path);
      if (isReservedAppStatePath(path)) throw new Error('Pi Web app state is not reviewable');
    }
    args.push('--', ...paths);
  } else {
    args.push('--', ...GIT_DISCOVERY_PATHSPECS);
  }
  const { stdout } = filePath ? await runGit(cwd, args) : await runGitDiscovery(cwd, args);
  return stdout;
}

async function gitFileDiff(cwd: string, filePath: string, staged = false) {
  resolveWithin(cwd, filePath);
  if (isReservedAppStatePath(filePath)) throw new Error('Pi Web app state is not reviewable');
  const context = await gitProjectContext(cwd);
  const file = (await getGitStatus(cwd)).files.find((item) => item.path === filePath);
  const originalPath = staged ? file?.oldPath ?? filePath : filePath;
  resolveWithin(cwd, originalPath);
  const gitPath = projectPathToGitPath(context, filePath);
  const originalGitPath = projectPathToGitPath(context, originalPath);
  const [original, modified] = await Promise.all([
    staged ? gitBlob(cwd, 'HEAD', originalGitPath) : gitBlob(cwd, '', gitPath),
    staged ? gitBlob(cwd, '', gitPath) : workingTreeFile(cwd, filePath),
  ]);
  const unavailable = original.unavailable ?? modified.unavailable;
  const patchOldPath = staged ? file?.oldPath : undefined;
  if (unavailable) {
    const fallbackPatch = await gitDiff(cwd, filePath, staged, patchOldPath).catch(() => '');
    if (fallbackPatch.trim()) {
      return {
        path: filePath,
        staged,
        original: '',
        modified: '',
        patch: fallbackPatch,
        message: `${unavailable} Showing patch diff instead.`,
      };
    }
    return {
      path: filePath,
      staged,
      original: '',
      modified: '',
      unavailable: true,
      message: unavailable,
    };
  }
  const metadataPatch = await gitDiff(cwd, filePath, staged, patchOldPath).catch(() => '');
  if (metadataPatch.trim() && original.content !== modified.content && patchNeedsPatchPreview(metadataPatch)) {
    return {
      path: filePath,
      staged,
      original: '',
      modified: '',
      patch: metadataPatch,
      message: 'Showing git patch because this change includes metadata changes.',
    };
  }
  const untrackedPatch = !staged && file?.status.includes('?') ? await untrackedFilePatch(cwd, filePath, modified.content) : '';
  if (untrackedPatch && original.content !== modified.content && patchNeedsPatchPreview(untrackedPatch)) {
    return {
      path: filePath,
      staged,
      original: '',
      modified: '',
      patch: untrackedPatch,
      message: 'Showing git patch because this change includes metadata changes.',
    };
  }
  if (original.content === modified.content) {
    if (metadataPatch.trim()) {
      return {
        path: filePath,
        staged,
        original: '',
        modified: '',
        patch: metadataPatch,
        message: 'Showing git patch because this change has no content differences.',
      };
    }
    if (untrackedPatch) {
      return {
        path: filePath,
        staged,
        original: '',
        modified: '',
        patch: untrackedPatch,
        message: 'Showing git patch for empty untracked file.',
      };
    }
  }
  return {
    path: filePath,
    staged,
    original: original.content,
    modified: modified.content,
    unavailable: false,
  };
}

async function gitBlob(cwd: string, ref: string, filePath: string) {
  const revision = ref ? `${ref}:${filePath}` : `:${filePath}`;
  const size = await gitObjectSize(cwd, revision);
  if (size === undefined) return { content: '' };
  if (size > MAX_GIT_FILE_DIFF_BYTES) return { content: '', unavailable: largeDiffMessage(size) };
  return textContent(await runGitBuffer(cwd, ['show', revision]));
}

async function gitObjectSize(cwd: string, revision: string) {
  const { stdout } = await runGit(cwd, ['cat-file', '-s', revision]).catch(() => ({ stdout: '' }));
  const value = stdout.trim();
  if (!value) return undefined;
  const size = Number(value);
  return Number.isFinite(size) ? size : undefined;
}

export async function getReviewableFile(cwd: string, filePath: string, staged: boolean, status?: GitStatus) {
  const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalizedPath || normalizedPath === '.' || path.isAbsolute(filePath)) throw new Error('Invalid review file path');
  if (isReservedAppStatePath(normalizedPath)) throw new Error('Pi Web app state is not reviewable');
  resolveWithin(cwd, normalizedPath);
  const file = (status ?? await getGitStatus(cwd)).files.find((item) => item.path === normalizedPath);
  if (staged ? !file?.staged : !file?.unstaged) {
    throw new Error(staged ? 'Review threads require a staged file' : 'Review threads require an unstaged or untracked file');
  }
  const result = staged
    ? await gitBlob(cwd, '', projectPathToGitPath(await gitProjectContext(cwd), normalizedPath))
    : await workingTreeFile(cwd, normalizedPath);
  if (result.unavailable !== undefined) throw new Error(result.unavailable);
  return result.content;
}

export function getReviewableWorkingTreeFile(cwd: string, filePath: string, status?: GitStatus) {
  return getReviewableFile(cwd, filePath, false, status);
}

async function workingTreeFile(cwd: string, filePath: string) {
  const target = resolveWithin(cwd, filePath);
  const fileStat = await lstat(target).catch(() => undefined);
  if (!fileStat) return { content: '' };
  if (fileStat.isSymbolicLink()) return { content: await readlink(target) };
  if (!fileStat.isFile()) return { content: '', unavailable: 'Diff preview is not available for folders.' };
  if (fileStat.size > MAX_GIT_FILE_DIFF_BYTES) return { content: '', unavailable: largeDiffMessage(fileStat.size) };
  return textContent(await readFile(target));
}

async function untrackedFilePatch(cwd: string, filePath: string, content: string) {
  const fileStat = await lstat(resolveWithin(cwd, filePath)).catch(() => undefined);
  if (!fileStat?.isFile()) return '';
  const executable = Boolean(fileStat.mode & 0o111);
  if (fileStat.size !== 0 && !executable) return '';
  const mode = executable ? '100755' : '100644';
  const patchPath = normalizeGitPath(filePath);
  if (fileStat.size === 0) return `diff --git a/${patchPath} b/${patchPath}\nnew file mode ${mode}\nindex 0000000..e69de29\n`;
  const hasTrailingNewline = content.endsWith('\n');
  const lines = hasTrailingNewline ? content.split('\n').slice(0, -1) : content.split('\n');
  const body = lines.map((line) => `+${line}`).join('\n');
  const noNewline = hasTrailingNewline ? '' : '\n\\ No newline at end of file';
  return `diff --git a/${patchPath} b/${patchPath}\nnew file mode ${mode}\n--- /dev/null\n+++ b/${patchPath}\n@@ -0,0 +1,${lines.length} @@\n${body}${noNewline}\n`;
}

function patchNeedsPatchPreview(patch: string) {
  const metadataLines = patch
    .split('\n')
    .filter((line) => /^(old mode|new mode|new file mode|deleted file mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to) /.test(line));

  return metadataLines.some((line) => line !== 'new file mode 100644');
}

function textContent(content: Buffer) {
  if (isProbablyBinary(content)) return { content: '', unavailable: 'Binary file diff is not available.' };
  return { content: content.toString('utf8') };
}

function isProbablyBinary(content: Buffer) {
  return content.subarray(0, Math.min(content.length, 8000)).includes(0);
}

function largeDiffMessage(size: number) {
  return `Diff preview is not available for files larger than ${formatBytes(MAX_GIT_FILE_DIFF_BYTES)} (${formatBytes(size)}).`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function stageChanges(cwd: string, filePath: string) {
  resolveWithin(cwd, filePath);
  if (isReservedAppStatePath(filePath)) throw new Error('Pi Web app state cannot be staged');
  await runGit(cwd, ['add', '--', filePath]);
}

async function unstageChanges(cwd: string, filePath: string) {
  resolveWithin(cwd, filePath);
  if (isReservedAppStatePath(filePath)) throw new Error('Pi Web app state cannot be changed through Git routes');
  const file = (await getGitStatus(cwd)).files.find((item) => item.path === filePath);
  if (!file?.staged) throw new Error('File has no staged changes');
  const paths = file.oldPath ? [file.oldPath, filePath] : [filePath];
  for (const path of paths) resolveWithin(cwd, path);
  if (await hasHead(cwd)) {
    await runGit(cwd, ['restore', '--staged', '--', ...paths]);
    return;
  }
  await runGit(cwd, ['rm', '--cached', '-r', '-f', '--', ...paths]);
}

async function hasHead(cwd: string) {
  const { stdout } = await runGit(cwd, ['rev-parse', '--verify', 'HEAD']).catch(() => ({ stdout: '' }));
  return Boolean(stdout.trim());
}

async function discardChanges(cwd: string, filePath: string) {
  resolveWithin(cwd, filePath);
  if (isReservedAppStatePath(filePath)) throw new Error('Pi Web app state cannot be changed through Git routes');
  const file = (await getGitStatus(cwd)).files.find((item) => item.path === filePath);
  if (!file?.unstaged) throw new Error('File has no unstaged changes');
  if (file.status.includes('?')) await runGit(cwd, ['clean', '-fd', '--', filePath]);
  else await runGit(cwd, ['restore', '--worktree', '--', filePath]);
}

async function assertNoStagedChangesOutsideProject(cwd: string) {
  const context = await gitProjectContext(cwd);
  const { stdout: reservedOut } = await runGit(cwd, ['diff', '--cached', '--name-only', '-z']);
  const hasReservedState = reservedOut.split('\0').some((filePath) => {
    const projectPath = gitPathToProjectPath(context, filePath);
    return projectPath !== undefined && isReservedAppStatePath(projectPath);
  });
  if (hasReservedState) throw new Error('Cannot commit Pi Web app state. Unstage the nested .pi-web directory first.');
  if (!context.projectPrefix) return;
  const { stdout } = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  const outsidePaths = new Set<string>();
  const statusEntries = stdout.split('\0');
  for (let index = 0; index < statusEntries.length; index += 1) {
    const line = statusEntries[index];
    if (!line) continue;
    const x = line[0] ?? ' ';
    const y = line[1] ?? ' ';
    const rawFilePath = line.slice(3);
    const rawOldPath = /[RC]/.test(`${x}${y}`) ? statusEntries[++index] : undefined;
    if (x === ' ' || x === '?') continue;
    if (gitPathToProjectPath(context, rawFilePath) === undefined) outsidePaths.add(rawFilePath);
    if (rawOldPath && gitPathToProjectPath(context, rawOldPath) === undefined) outsidePaths.add(rawOldPath);
  }
  if (outsidePaths.size) {
    const [firstPath] = outsidePaths;
    const suffix = outsidePaths.size > 1 ? ` and ${outsidePaths.size - 1} more staged ${outsidePaths.size === 2 ? 'path' : 'paths'}` : '';
    throw new Error(`Cannot commit because “${firstPath}${suffix}” is outside this project. Open the repository root or unstage outside changes first.`);
  }
}

async function gitProjectContext(cwd: string): Promise<GitProjectContext> {
  const { stdout } = await runGit(cwd, ['rev-parse', '--show-toplevel', '--show-prefix']);
  const [, prefix = ''] = stdout.split('\n');
  return { projectPrefix: normalizeGitPrefix(prefix.trim()) };
}

function gitPathToProjectPath(context: GitProjectContext, gitPath: string) {
  const normalized = normalizeGitPath(gitPath);
  const prefix = context.projectPrefix;
  if (!prefix) return normalized || '.';
  if (normalized === prefix.slice(0, -1)) return '.';
  if (!normalized.startsWith(prefix)) return undefined;
  return normalized.slice(prefix.length) || '.';
}

function projectPathToGitPath(context: GitProjectContext, projectPath: string) {
  const normalized = normalizeGitPath(projectPath);
  return context.projectPrefix ? `${context.projectPrefix}${normalized}` : normalized;
}

function normalizeGitPrefix(prefix: string) {
  const normalized = normalizeGitPath(prefix);
  return normalized && !normalized.endsWith('/') ? `${normalized}/` : normalized;
}

function normalizeGitPath(filePath: string) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

async function diffStats(cwd: string, staged: boolean, context: GitProjectContext) {
  const args = ['diff', '--numstat', '-z', '--find-renames'];
  if (staged) args.push('--cached');
  args.push('--', ...GIT_DISCOVERY_PATHSPECS);
  const { stdout } = await runGitDiscovery(cwd, args).catch(() => ({ stdout: '' }));
  const entries = stdout.split('\0');
  const stats: Array<readonly [string, { additions: number; deletions: number }]> = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const parsed = parseNumstatEntry(entry);
    if (!parsed) continue;
    const rawFilePath = parsed.filePath || entries[index + 2];
    if (!rawFilePath) continue;
    if (!parsed.filePath) index += 2;
    const filePath = gitPathToProjectPath(context, rawFilePath);
    if (filePath === undefined || isReservedAppStatePath(filePath)) continue;
    stats.push([
      filePath,
      { additions: Number(parsed.additions) || 0, deletions: Number(parsed.deletions) || 0 },
    ] as const);
  }
  return stats;
}

function parseNumstatEntry(entry: string) {
  const firstTab = entry.indexOf('\t');
  const secondTab = firstTab === -1 ? -1 : entry.indexOf('\t', firstTab + 1);
  if (firstTab === -1 || secondTab === -1) return undefined;
  return {
    additions: entry.slice(0, firstTab),
    deletions: entry.slice(firstTab + 1, secondTab),
    filePath: entry.slice(secondTab + 1),
  };
}

function isReservedAppStatePath(filePath: string) {
  return normalizeGitPath(filePath).split('/').includes('.pi-web');
}

async function runGit(cwd: string, args: string[]) {
  return execFileAsync('git', args, { cwd, env: GIT_ENV, maxBuffer: 20 * 1024 * 1024 });
}

async function runGitDiscovery(cwd: string, args: string[]) {
  return execFileAsync('git', args, { cwd, env: process.env, maxBuffer: 20 * 1024 * 1024 });
}

async function runGitBuffer(cwd: string, args: string[]) {
  return new Promise<Buffer>((resolve, reject) => {
    execFile('git', args, { cwd, env: GIT_ENV, encoding: 'buffer', maxBuffer: MAX_GIT_FILE_DIFF_BYTES + 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout as Buffer);
    });
  });
}
