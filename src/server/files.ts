import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants, watch, type Dirent, type FSWatcher, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rename as renamePath, rm, stat, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { ProjectRegistry } from './projects.js';
import { projectUploadRoot, sessionUploadRoot } from './uploads.js';
import { resolveWithin } from './util.js';

const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_FILE_SAVE_BODY_BYTES = MAX_TEXT_BYTES * 6 + 1024;
const MAX_SEARCH_RESULTS = 50;
const MAX_QUICK_SEARCH_VISITS = 5_000;
const MAX_INDEXED_FILES = 50_000;
const MAX_FILE_INDEX_VISITS = 100_000;
const FILE_INDEX_CACHE_TTL_MS = 60_000;
const MAX_FILE_INDEX_CACHE_ENTRIES = 20;
const FILE_SEARCH_CACHE_TTL_MS = 30_000;
const MAX_FILE_SEARCH_CACHE_ENTRIES = 500;
const FILE_WATCH_DEBOUNCE_MS = 250;
const FILE_WATCH_RESCAN_DEBOUNCE_MS = 1_000;
const MAX_FILE_WATCH_DIRECTORIES = 5_000;
const SKIPPED_SEARCH_DIRS = new Set(['.git', 'node_modules', '.pi-web']);
const FILE_WATCH_SKIPPED_DIRS = new Set(['.git', 'node_modules']);
const PROTECTED_FILE_ACTION_ROOTS = new Set(['.git', 'node_modules']);

type FileSearchResult = { path: string; name: string; directory: string };
type FileSearchEntry = FileSearchResult & { searchText: string; nameSearch: string };
type FileIndexCacheEntry = { expiresAt: number; files: FileSearchEntry[]; promise?: Promise<FileSearchEntry[]> };
type FileEntryType = 'directory' | 'file';
type FileWatchSession = { projectId: string; root: string; sockets: Set<WebSocket>; watchers: Map<string, FSWatcher>; timer?: NodeJS.Timeout; rescanTimer?: NodeJS.Timeout; scanPromise?: Promise<void>; closed?: boolean };
type WebSocket = { readyState: number; send(data: string): void; close(): void; on(event: 'close' | 'error' | 'message', listener: (...args: any[]) => void): void };

class TrustedMvUnavailableError extends Error {
  constructor() {
    super('Trusted mv command is not available');
  }
}

class FileChangedOnDiskError extends Error {
  constructor() {
    super('File changed on disk. Reload before saving.');
  }
}

const fileIndexCache = new Map<string, FileIndexCacheEntry>();
const fileSearchCache = new Map<string, { expiresAt: number; files: FileSearchResult[] }>();
const fileCacheVersions = new Map<string, number>();
const fileSaveLocks = new Map<string, Promise<void>>();

const CONTENT_TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.avif', 'image/avif'], ['.bmp', 'image/bmp'], ['.svg', 'image/svg+xml'],
  ['.mp4', 'video/mp4'], ['.webm', 'video/webm'], ['.mov', 'video/quicktime'], ['.m4v', 'video/x-m4v'],
  ['.pdf', 'application/pdf'], ['.txt', 'text/plain; charset=utf-8'], ['.md', 'text/markdown; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.jsx', 'text/javascript; charset=utf-8'], ['.ts', 'text/typescript; charset=utf-8'], ['.tsx', 'text/typescript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'],
]);
const SANDBOXED_ASSET_EXTENSIONS = new Set(['.html', '.htm', '.svg', '.xml', '.xhtml']);
const SANDBOXED_ASSET_CSP = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'";
const TRUSTED_MV_PATHS = ['/usr/bin/mv', '/bin/mv'];
const execFileAsync = promisify(execFile);

export async function registerFileRoutes(app: FastifyInstance, registry: ProjectRegistry) {
  const fileWatchSessions = new Map<string, FileWatchSession>();

  app.addHook('onClose', async () => {
    for (const session of fileWatchSessions.values()) closeFileWatchSession(session);
    fileWatchSessions.clear();
  });

  await app.register(multipart, {
    limits: { fileSize: 256 * 1024 * 1024, files: 20 },
  });

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/files/invalidate', async (request, reply) => {
    try {
      const project = registry.get(request.params.projectId);
      clearProjectFileCaches(project.id);
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not invalidate file caches' });
    }
  });

  app.get<{ Params: { projectId: string } }>('/ws/projects/:projectId/files', { websocket: true }, (connection: any, request) => {
    const socket: WebSocket = connection.socket ?? connection;
    try {
      const project = registry.get(request.params.projectId);
      let session = fileWatchSessions.get(project.id);
      if (!session) {
        session = createFileWatchSession(project.id, project.path);
        fileWatchSessions.set(project.id, session);
      }
      attachFileWatchSocket(fileWatchSessions, session, socket);
    } catch (error) {
      sendFileWatchMessage(socket, { type: 'error', message: error instanceof Error ? error.message : 'Could not watch files' });
      socket.close();
    }
  });

  app.get<{ Params: { projectId: string }; Querystring: { query?: string } }>('/api/projects/:projectId/files/search', async (request, reply) => {
    try {
      const project = registry.get(request.params.projectId);
      const query = (request.query.query ?? '').trim().toLowerCase();
      const cacheKey = `${project.id}:${query}`;
      const cached = fileSearchCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return { files: cached.files };
      const tokens = query.split(/[\s/.]+/).filter(Boolean);
      const useQuickSearch = shouldUseQuickFileSearch(query, project.id);
      let cacheVersion = fileCacheVersion(project.id);
      let results = useQuickSearch
        ? await quickSearchProjectFiles(project.id, project.path, tokens)
        : searchFileIndex(await projectFileIndex(project.id, project.path), tokens);

      if (!useQuickSearch && cacheVersion !== fileCacheVersion(project.id)) {
        cacheVersion = fileCacheVersion(project.id);
        results = searchFileIndex(await projectFileIndex(project.id, project.path), tokens);
      }

      if (!useQuickSearch && cacheVersion === fileCacheVersion(project.id)) {
        fileSearchCache.set(cacheKey, { expiresAt: Date.now() + FILE_SEARCH_CACHE_TTL_MS, files: results });
        pruneFileSearchCache();
      }
      return { files: results };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not search files' });
    }
  });

  app.get<{ Params: { projectId: string }; Querystring: { path?: string } }>('/api/projects/:projectId/files', async (request, reply) => {
    try {
      const project = registry.get(request.params.projectId);
      const target = resolveWithin(project.path, request.query.path ?? '.');
      const entries = await readDirectoryWithin(project.path, target);
      return {
        path: projectRelativePathFromAbsolute(project.path, target),
        entries: entries
          .filter((entry) => !['.git', 'node_modules'].includes(entry.name))
          .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }))
          .sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name)),
      };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not list files' });
    }
  });

  app.get<{ Params: { projectId: string }; Querystring: { path?: string } }>('/api/projects/:projectId/file', async (request, reply) => {
    if (!request.query.path) return reply.code(400).send({ error: 'Missing path' });
    try {
      const project = registry.get(request.params.projectId);
      const target = resolveWithin(project.path, request.query.path);
      const preview = await readTextPreview(project.path, target);
      return { path: request.query.path, ...preview };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not read file' });
    }
  });

  app.put<{ Params: { projectId: string }; Querystring: { path?: string }; Body: { content?: unknown; mtimeMs?: unknown; etag?: unknown; contentHash?: unknown } }>('/api/projects/:projectId/file', { bodyLimit: MAX_FILE_SAVE_BODY_BYTES }, async (request, reply) => {
    if (!request.query.path) return reply.code(400).send({ error: 'Missing path' });
    if (typeof request.body?.content !== 'string') return reply.code(400).send({ error: 'Missing content' });
    const contentByteLength = Buffer.byteLength(request.body.content, 'utf8');
    if (contentByteLength > MAX_TEXT_BYTES) return reply.code(413).send({ error: 'File content exceeds the 10 MB edit limit' });
    if (request.body.mtimeMs !== undefined && typeof request.body.mtimeMs !== 'number') return reply.code(400).send({ error: 'Invalid file version' });
    if (request.body.etag !== undefined && typeof request.body.etag !== 'string') return reply.code(400).send({ error: 'Invalid file version' });
    if (request.body.contentHash !== undefined && typeof request.body.contentHash !== 'string') return reply.code(400).send({ error: 'Invalid file version' });
    try {
      const project = registry.get(request.params.projectId);
      const target = resolveWithin(project.path, request.query.path);
      const realTarget = await assertRealPathWithin(project.path, target);

      const file = await open(realTarget, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let fileStat!: Stats;
      try {
        await assertOpenHandleWithin(project.path, file, realTarget);
        fileStat = await file.stat();
        if (!fileStat.isFile()) throw new Error('Path is not a file');
        const changedSincePreview = typeof request.body.contentHash === 'string' || fileChangedSinceVersion(fileStat, request.body.mtimeMs, request.body.etag);
        if (changedSincePreview && !(await openFileContentUnchangedOrEquals(project.path, realTarget, fileStat, request.body.contentHash, request.body.content, contentByteLength))) {
          return reply.code(409).send({ error: 'File changed on disk. Reload before saving.' });
        }
      } finally {
        await file.close();
      }

      const savedStat = await writeFileInPlaceWithin(project.path, realTarget, fileStat, request.body.content);
      clearProjectFileCaches(project.id);
      return { path: request.query.path, content: request.body.content, truncated: false, mtimeMs: savedStat.mtimeMs, size: savedStat.size, etag: fileVersionEtag(savedStat), contentHash: fileContentHash(request.body.content) };
    } catch (error) {
      if (error instanceof FileChangedOnDiskError) return reply.code(409).send({ error: error.message });
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not save file' });
    }
  });

  app.post<{ Params: { projectId: string }; Body: { name?: unknown; directory?: unknown } }>('/api/projects/:projectId/file', async (request, reply) => {
    if (typeof request.body?.name !== 'string') return reply.code(400).send({ error: 'Missing file name' });
    if (request.body.directory !== undefined && typeof request.body.directory !== 'string') return reply.code(400).send({ error: 'Invalid directory path' });
    try {
      const project = registry.get(request.params.projectId);
      const name = cleanEntryName(request.body.name, 'create');
      const relativeDir = projectDirectoryRelativePath(request.body.directory ?? '', 'create');
      const relativePath = joinProjectRelativePath(relativeDir, name);
      await createFileWithin(project.path, relativeDir, name);
      clearProjectFileCaches(project.id);
      return { path: relativePath, name, type: 'file' as const };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not create file' });
    }
  });

  app.patch<{ Params: { projectId: string }; Querystring: { path?: string }; Body: { name?: unknown } }>('/api/projects/:projectId/file', async (request, reply) => {
    if (!request.query.path) return reply.code(400).send({ error: 'Missing path' });
    if (typeof request.body?.name !== 'string') return reply.code(400).send({ error: 'Missing file name' });
    try {
      const project = registry.get(request.params.projectId);
      const name = cleanEntryName(request.body.name, 'rename');
      const relativePath = mutableProjectRelativePath(request.query.path, 'rename');
      const nextRelativePath = joinProjectRelativePath(parentRelativePath(relativePath), name);
      const type = await renameEntryWithin(project.path, relativePath, nextRelativePath);
      clearProjectFileCaches(project.id);
      return { path: nextRelativePath, name, type };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not rename file' });
    }
  });

  app.delete<{ Params: { projectId: string }; Querystring: { path?: string } }>('/api/projects/:projectId/file', async (request, reply) => {
    if (!request.query.path) return reply.code(400).send({ error: 'Missing path' });
    try {
      const project = registry.get(request.params.projectId);
      const relativePath = mutableProjectRelativePath(request.query.path, 'delete');
      await deleteEntryWithin(project.path, relativePath);
      clearProjectFileCaches(project.id);
      return { deleted: relativePath };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not delete file' });
    }
  });

  app.get<{ Params: { projectId: string }; Querystring: { path?: string } }>('/api/projects/:projectId/asset', async (request, reply) => {
    if (!request.query.path) return reply.code(400).send({ error: 'Missing path' });
    try {
      const project = registry.get(request.params.projectId);
      const target = resolveWithin(project.path, request.query.path);
      const realTarget = await assertRealPathWithin(project.path, target);
      const file = await open(realTarget, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let streamOwnsFile = false;
      try {
        await assertOpenHandleWithin(project.path, file, realTarget);
        const fileStat = await file.stat();
        if (!fileStat.isFile()) throw new Error('Path is not a file');
        const etag = assetEtag(fileStat.size, fileStat.mtimeMs);
        reply.header('cache-control', 'no-cache');
        reply.header('etag', etag);
        reply.header('last-modified', fileStat.mtime.toUTCString());
        reply.header('x-content-type-options', 'nosniff');
        reply.header('cross-origin-resource-policy', 'same-origin');
        const assetCsp = assetContentSecurityPolicy(target);
        if (assetCsp) reply.header('content-security-policy', assetCsp);
        if (assetNotModified(request.headers['if-none-match'], request.headers['if-modified-since'], etag, fileStat.mtime)) return reply.code(304).send();
        reply.header('content-type', contentTypeForPath(target));
        reply.header('content-disposition', `inline; filename="${safeHeaderFilename(target)}"`);
        const stream = file.createReadStream();
        streamOwnsFile = true;
        return reply.send(stream);
      } finally {
        if (!streamOwnsFile) await file.close().catch(() => undefined);
      }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not read asset' });
    }
  });

  app.post<{ Params: { projectId: string }; Querystring: { sessionId?: string } }>('/api/projects/:projectId/uploads', async (request, reply) => {
    try {
      const project = registry.get(request.params.projectId);
      const uploadRoot = request.query.sessionId ? sessionUploadRoot(project.path, request.query.sessionId) : projectUploadRoot(project.path);
      const uploadDir = projectRelativePathFromAbsolute(project.path, uploadRoot);

      const uploaded: Array<{ filename: string; path: string; bytes: number }> = [];
      for await (const part of request.parts()) {
        if (part.type !== 'file') continue;
        uploaded.push(await writeUploadWithin(project.path, uploadDir, part.filename || `upload-${Date.now()}`, part.file));
      }

      if (uploaded.length) clearProjectFileCaches(project.id);
      return { uploaded };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Upload failed' });
    }
  });
}

export function clearProjectFileCaches(projectId: string) {
  fileCacheVersions.set(projectId, fileCacheVersion(projectId) + 1);
  fileIndexCache.delete(projectId);
  clearFileSearchCache(projectId);
}

function fileCacheVersion(projectId: string) {
  return fileCacheVersions.get(projectId) ?? 0;
}

function createFileWatchSession(projectId: string, root: string): FileWatchSession {
  const session: FileWatchSession = { projectId, root, sockets: new Set(), watchers: new Map() };
  void refreshFileWatchers(session);
  return session;
}

function attachFileWatchSocket(sessions: Map<string, FileWatchSession>, session: FileWatchSession, socket: WebSocket) {
  session.sockets.add(socket);
  if (!session.watchers.size && !session.scanPromise) void refreshFileWatchers(session);
  sendFileWatchMessage(socket, { type: 'ready', watching: session.watchers.size > 0 || Boolean(session.scanPromise) });
  socket.on('close', () => {
    session.sockets.delete(socket);
    if (!session.sockets.size) {
      closeFileWatchSession(session);
      sessions.delete(session.projectId);
    }
  });
}

function closeFileWatchSession(session: FileWatchSession) {
  session.closed = true;
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = undefined;
  }
  if (session.rescanTimer) {
    clearTimeout(session.rescanTimer);
    session.rescanTimer = undefined;
  }
  for (const watcher of session.watchers.values()) watcher.close();
  session.watchers.clear();
  for (const socket of session.sockets) socket.close();
  session.sockets.clear();
}

function refreshFileWatchers(session: FileWatchSession) {
  if (session.closed) return Promise.resolve();
  if (session.scanPromise) return session.scanPromise;
  session.scanPromise = reconcileFileWatchers(session)
    .catch((error) => {
      broadcastFileWatchMessage(session, { type: 'error', message: error instanceof Error ? error.message : 'File watcher failed' });
    })
    .finally(() => {
      session.scanPromise = undefined;
    });
  return session.scanPromise;
}

async function reconcileFileWatchers(session: FileWatchSession) {
  const directories = await collectFileWatchDirectories(session.root);
  if (session.closed) return;
  const nextDirectories = new Set(directories);
  for (const [directory, watcher] of session.watchers) {
    if (nextDirectories.has(directory)) continue;
    watcher.close();
    session.watchers.delete(directory);
  }
  for (const directory of directories) {
    if (!session.watchers.has(directory)) await watchDirectory(session, directory);
  }
}

async function collectFileWatchDirectories(root: string) {
  const directories: string[] = [];
  const pending = [root];
  while (pending.length && directories.length < MAX_FILE_WATCH_DIRECTORIES) {
    const directory = pending.shift()!;
    directories.push(directory);
    let entries: Dirent[];
    try {
      entries = await readDirectoryWithin(root, directory);
    } catch {
      continue;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (directories.length + pending.length >= MAX_FILE_WATCH_DIRECTORIES) break;
      if (!entry.isDirectory() || FILE_WATCH_SKIPPED_DIRS.has(entry.name)) continue;
      pending.push(path.join(directory, entry.name));
    }
  }
  return directories;
}

async function watchDirectory(session: FileWatchSession, directory: string) {
  if (session.closed) return;
  let openDirectory: OpenDirectoryPath | undefined;
  try {
    openDirectory = await openDirectoryPathWithin(session.root, directory);
    if (session.closed || session.watchers.has(directory)) return;
    const watcher = watch(openDirectory.path, (eventType, filename) => {
      if (shouldIgnoreFileWatchPath(filename)) return;
      scheduleFileWatchInvalidation(session);
      if (eventType === 'rename') scheduleFileWatchRescan(session);
    });
    watcher.on('error', () => {
      watcher.close();
      session.watchers.delete(directory);
      scheduleFileWatchRescan(session);
    });
    session.watchers.set(directory, watcher);
  } catch {
    // The directory may have disappeared while scanning; the next rescan will reconcile it.
  } finally {
    await openDirectory?.close().catch(() => undefined);
  }
}

function scheduleFileWatchRescan(session: FileWatchSession) {
  if (session.closed || session.rescanTimer) return;
  session.rescanTimer = setTimeout(() => {
    session.rescanTimer = undefined;
    void refreshFileWatchers(session);
  }, FILE_WATCH_RESCAN_DEBOUNCE_MS);
}

function scheduleFileWatchInvalidation(session: FileWatchSession) {
  if (session.closed || session.timer) return;
  session.timer = setTimeout(() => {
    session.timer = undefined;
    clearProjectFileCaches(session.projectId);
    broadcastFileWatchMessage(session, { type: 'files:change' });
  }, FILE_WATCH_DEBOUNCE_MS);
}

function shouldIgnoreFileWatchPath(filename: string | Buffer | null) {
  if (!filename) return false;
  return filename.toString().replace(/\\/g, '/').split('/').some((segment) => FILE_WATCH_SKIPPED_DIRS.has(segment));
}

function broadcastFileWatchMessage(session: FileWatchSession, message: Record<string, unknown>) {
  for (const socket of session.sockets) sendFileWatchMessage(socket, message);
}

function sendFileWatchMessage(socket: WebSocket, message: Record<string, unknown>) {
  if (socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // Ignore closed sockets; the close handler will clean them up.
  }
}

async function assertRealPathWithin(root: string, target: string) {
  const resolvedRoot = await realpath(root);
  const resolvedTarget = await realpath(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('Path escapes workspace');
  return resolvedTarget;
}

async function assertOpenHandleWithin(root: string, file: FileHandle, expectedPath?: string) {
  if (usesFdBackedPathChecks()) {
    try {
      return await fileHandlePathWithin(root, file);
    } catch (error) {
      if (!expectedPath || isPathEscapesWorkspaceError(error)) throw error;
    }
  }

  if (!expectedPath) throw new Error('Could not verify file handle');
  return assertOpenHandleMatchesPath(root, file, expectedPath);
}

async function fileHandlePathWithin(root: string, file: FileHandle) {
  const resolvedRoot = await realpath(root);
  const handlePath = await fileHandlePath(file);
  if (handlePath.realPath !== resolvedRoot && !handlePath.realPath.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('Path escapes workspace');
  return handlePath;
}

function usesFdBackedPathChecks() {
  return process.platform === 'linux';
}

function isPathEscapesWorkspaceError(error: unknown) {
  return error instanceof Error && error.message === 'Path escapes workspace';
}

async function assertOpenHandleMatchesPath(root: string, file: FileHandle, expectedPath: string) {
  const realTarget = await assertRealPathWithin(root, expectedPath);
  const [handleStat, pathStat] = await Promise.all([file.stat(), stat(realTarget)]);
  if (!sameFileIdentity(handleStat, pathStat)) throw new Error('Path changed while opening');
  return { path: realTarget, realPath: realTarget };
}

function sameFileIdentity(left: Stats, right: Stats) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function unlinkIfSameFile(target: string, expected: Stats) {
  const current = await lstat(target);
  if (sameFileIdentity(current, expected)) await unlink(target);
}

async function fileHandlePath(file: FileHandle) {
  const candidates = [`/proc/self/fd/${file.fd}`, `/dev/fd/${file.fd}`];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return { path: candidate, realPath: await realpath(candidate) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

type OpenDirectoryPath = { path: string; externalPath: string; realPath: string; close: () => Promise<void> };

async function openDirectoryPathWithin(root: string, target: string): Promise<OpenDirectoryPath> {
  const realTarget = await assertRealPathWithin(root, target);
  if (!usesFdBackedPathChecks()) {
    const directoryStat = await stat(realTarget);
    if (!directoryStat.isDirectory()) throw new Error('Path is not a directory');
    return { path: realTarget, externalPath: realTarget, realPath: realTarget, close: async () => {} };
  }

  const directory = await open(realTarget, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const handlePath = await fileHandlePathWithin(root, directory);
    const directoryStat = await directory.stat();
    if (!directoryStat.isDirectory()) throw new Error('Path is not a directory');
    return { path: handlePath.path, externalPath: fileHandleExternalPath(directory), realPath: handlePath.realPath, close: () => directory.close() };
  } catch (error) {
    await directory.close().catch(() => undefined);
    if (isPathEscapesWorkspaceError(error)) throw error;
    const directoryStat = await stat(realTarget);
    if (!directoryStat.isDirectory()) throw new Error('Path is not a directory');
    return { path: realTarget, externalPath: realTarget, realPath: realTarget, close: async () => {} };
  }
}

async function readDirectoryWithin(root: string, target: string) {
  const directory = await openDirectoryPathWithin(root, target);
  try {
    return await readdir(directory.path, { withFileTypes: true });
  } finally {
    await directory.close();
  }
}

async function createFileWithin(root: string, relativeDir: string, name: string) {
  const directory = await openDirectoryPathWithin(root, resolveWithin(root, relativeDir || '.'));
  try {
    const file = await createFileHandleWithin(root, directory, name, 0o644).catch((error) => {
      if (isErrorCode(error, 'EEXIST')) throw fileExistsError();
      throw error;
    });
    await file.close().catch(() => undefined);
  } finally {
    await directory.close();
  }
}

async function createFileHandleWithin(root: string, directory: OpenDirectoryPath, name: string, mode: number) {
  const target = path.join(directory.path, name);
  const file = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
  const createdStat = await file.stat();
  let verified = false;
  try {
    await assertOpenHandleWithin(root, file, path.join(directory.realPath, name));
    verified = true;
    return file;
  } finally {
    if (!verified) {
      try {
        await file.close();
      } finally {
        await unlinkIfSameFile(target, createdStat).catch(() => undefined);
      }
    }
  }
}

async function renameEntryWithin(root: string, relativePath: string, nextRelativePath: string): Promise<FileEntryType> {
  const sourceDirectory = await openDirectoryPathWithin(root, resolveWithin(root, parentRelativePath(relativePath) || '.'));
  try {
    const sourceName = entryNameFromRelativePath(relativePath);
    const sourcePath = path.join(sourceDirectory.path, sourceName);
    const sourceStat = await lstat(sourcePath);
    if (!sourceStat.isFile() && !sourceStat.isDirectory()) throw new Error('Only files and folders can be renamed');
    await assertRealPathWithin(root, sourcePath);

    const destinationDirectory = await openDirectoryPathWithin(root, resolveWithin(root, parentRelativePath(nextRelativePath) || '.'));
    try {
      const destinationName = entryNameFromRelativePath(nextRelativePath);
      const destinationPath = path.join(destinationDirectory.path, destinationName);
      if (sourceName === destinationName) return sourceStat.isDirectory() ? 'directory' : 'file';
      if (!usesFdBackedPathChecks() && isCaseOnlyNameChange(sourceName, destinationName) && await pathStillReferencesFile(destinationPath, sourceStat)) {
        await renamePath(sourcePath, destinationPath);
        return renamedEntryType(root, destinationPath);
      }
      return await renameNoReplace(root, sourcePath, path.join(sourceDirectory.externalPath, sourceName), destinationPath, destinationDirectory, destinationName, sourceStat);
    } finally {
      await destinationDirectory.close();
    }
  } finally {
    await sourceDirectory.close();
  }
}

async function renameNoReplace(root: string, sourcePath: string, externalSourcePath: string, destinationPath: string, destinationDirectory: OpenDirectoryPath, destinationName: string, sourceStat: Stats): Promise<FileEntryType> {
  if (process.platform === 'linux') {
    await assertSameDevice(sourceStat, destinationDirectory);
    try {
      return await renameNoReplaceWithMv(root, sourcePath, externalSourcePath, path.join(destinationDirectory.externalPath, destinationName), destinationPath, sourceStat);
    } catch (error) {
      if (!(error instanceof TrustedMvUnavailableError)) throw error;
    }
  }
  if (sourceStat.isDirectory()) return renameDirectoryBestEffort(root, sourcePath, destinationPath, sourceStat);
  return renameFileNoReplace(root, sourcePath, destinationPath, sourceStat);
}

async function renameNoReplaceWithMv(root: string, sourcePath: string, externalSourcePath: string, externalDestinationPath: string, destinationPath: string, sourceStat: Stats): Promise<FileEntryType> {
  try {
    await execTrustedMv(['-T', '-n', '--', externalSourcePath, externalDestinationPath]);
  } catch (error) {
    if (error instanceof TrustedMvUnavailableError) throw error;
    if (await sameExistingPath(destinationPath, sourceStat)) throw fileExistsError();
    throw new Error(error instanceof Error ? error.message : 'Could not rename file');
  }

  if (await pathStillReferencesFile(sourcePath, sourceStat)) throw fileExistsError();
  const destinationStat = await lstat(destinationPath);
  if (!sameFileIdentity(destinationStat, sourceStat)) throw new Error('Path changed while renaming');
  return renamedEntryType(root, destinationPath);
}

async function execTrustedMv(args: string[]) {
  let lastError: unknown;
  for (const command of TRUSTED_MV_PATHS) {
    try {
      return await execFileAsync(command, args, { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
    } catch (error) {
      lastError = error;
      if (isErrorCode(error, 'ENOENT')) continue;
      throw error;
    }
  }
  if (lastError && isErrorCode(lastError, 'ENOENT')) throw new TrustedMvUnavailableError();
  throw lastError;
}

async function sameExistingPath(target: string, expected: Stats) {
  try {
    const current = await lstat(target);
    return !sameFileIdentity(current, expected);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
}

async function pathStillReferencesFile(target: string, expected: Stats) {
  try {
    return sameFileIdentity(await lstat(target), expected);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
}

async function assertSameDevice(sourceStat: Stats, destinationDirectory: OpenDirectoryPath) {
  const destinationDirectoryStat = await stat(destinationDirectory.path);
  if (sourceStat.dev !== destinationDirectoryStat.dev) throw new Error('Safe rename across filesystems is not supported');
}

async function renameFileNoReplace(root: string, sourcePath: string, destinationPath: string, sourceStat: Stats): Promise<FileEntryType> {
  try {
    await link(sourcePath, destinationPath);
  } catch (error) {
    if (isErrorCode(error, 'EEXIST')) throw fileExistsError();
    if (isHardLinkUnsupported(error)) throw new Error('Safe rename is not supported on this filesystem');
    throw error;
  }

  const destinationStat = await lstat(destinationPath);
  let keepDestination = false;
  try {
    if (!sameFileIdentity(destinationStat, sourceStat)) throw new Error('Path changed while renaming');
    await unlinkIfSameFile(sourcePath, destinationStat).catch((error) => {
      if (!isErrorCode(error, 'ENOENT')) throw error;
    });
    const type = await renamedEntryType(root, destinationPath);
    keepDestination = true;
    return type;
  } finally {
    if (!keepDestination) await unlinkIfSameFile(destinationPath, destinationStat).catch(() => undefined);
  }
}

async function renameDirectoryBestEffort(root: string, sourcePath: string, destinationPath: string, sourceStat: Stats): Promise<FileEntryType> {
  await assertPathDoesNotExist(destinationPath);
  await renamePath(sourcePath, destinationPath);
  const destinationStat = await lstat(destinationPath);
  if (!destinationStat.isDirectory() || !sameFileIdentity(destinationStat, sourceStat)) throw new Error('Path changed while renaming');
  await assertRealPathWithin(root, destinationPath);
  return 'directory';
}

function isHardLinkUnsupported(error: unknown) {
  return ['EXDEV', 'EPERM', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL', 'EMLINK', 'ENOTSUP'].some((code) => isErrorCode(error, code));
}

async function renamedEntryType(root: string, target: string): Promise<FileEntryType> {
  const targetStat = await lstat(target);
  if (targetStat.isDirectory()) {
    await assertRealPathWithin(root, target);
    return 'directory';
  }
  if (targetStat.isFile()) {
    await assertRealPathWithin(root, target);
    return 'file';
  }
  await unlinkIfSameFile(target, targetStat).catch(() => undefined);
  throw new Error('Renamed path is not a file or folder');
}

async function deleteEntryWithin(root: string, relativePath: string) {
  const directory = await openDirectoryPathWithin(root, resolveWithin(root, parentRelativePath(relativePath) || '.'));
  try {
    const target = path.join(directory.path, entryNameFromRelativePath(relativePath));
    const targetStat = await lstat(target);
    if (targetStat.isFile()) {
      await assertRealPathWithin(root, target);
      await unlink(target);
      return;
    }
    if (targetStat.isDirectory()) {
      await assertRealPathWithin(root, target);
      await rm(target, { recursive: true, force: false });
      return;
    }
    throw new Error('Only files and folders can be deleted');
  } finally {
    await directory.close();
  }
}

async function writeFileInPlaceWithin(root: string, target: string, expectedStat: Stats, content: string) {
  return withFileSaveLock(target, async () => {
    const directory = await openDirectoryPathWithin(root, path.dirname(target));
    const destinationPath = path.join(directory.path, path.basename(target));
    let tempPath: string | undefined;
    let tempStat: Stats | undefined;
    let replaced = false;
    try {
      const temp = await writeTempSaveFileWithin(root, directory, expectedStat, content);
      tempPath = temp.path;
      tempStat = temp.stat;

      const savedStat = await replaceFileWithTempIfUnchanged(directory, destinationPath, expectedStat, tempPath, tempStat);
      replaced = true;
      return savedStat;
    } finally {
      if (!replaced && tempPath && tempStat) await unlinkIfSameFile(tempPath, tempStat).catch(() => undefined);
      await directory.close();
    }
  });
}

async function withFileSaveLock<T>(target: string, action: () => Promise<T>) {
  const key = path.resolve(target);
  const previous = fileSaveLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => gate);
  fileSaveLocks.set(key, queued);

  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (fileSaveLocks.get(key) === queued) fileSaveLocks.delete(key);
  }
}

async function writeTempSaveFileWithin(root: string, directory: OpenDirectoryPath, expectedStat: Stats, content: string) {
  const mode = expectedStat.mode & 0o777;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const name = `.pi-web-save-${process.pid}-${Date.now()}-${attempt}.tmp`;
    let file: FileHandle;
    try {
      file = await createFileHandleWithin(root, directory, name, mode || 0o600);
    } catch (error) {
      if (isErrorCode(error, 'EEXIST')) continue;
      throw error;
    }

    const tempPath = path.join(directory.path, name);
    const tempStat = await file.stat();
    let completed = false;
    try {
      await file.writeFile(content, 'utf8');
      if ((tempStat.mode & 0o777) !== mode) await file.chmod(mode);
      await file.sync();
      completed = true;
      return { path: tempPath, stat: tempStat };
    } finally {
      await file.close().catch(() => undefined);
      if (!completed) await unlinkIfSameFile(tempPath, tempStat).catch(() => undefined);
    }
  }
  throw new Error('Could not create a temporary save file');
}

async function replaceFileWithTempIfUnchanged(directory: OpenDirectoryPath, destinationPath: string, expectedStat: Stats, tempPath: string, tempStat: Stats) {
  await assertHardLinkSupportedForSave(directory, tempPath, tempStat);
  const backup = await moveCurrentFileToBackup(directory, destinationPath);
  let destinationHasTemp = false;
  let saved = false;

  try {
    const backupMatchesExpected = backup.stat.isFile() && sameFileIdentity(backup.stat, expectedStat) && fileVersionEtag(backup.stat) === fileVersionEtag(expectedStat);
    if (!backupMatchesExpected) throw new FileChangedOnDiskError();

    try {
      await link(tempPath, destinationPath);
    } catch (error) {
      if (isErrorCode(error, 'EEXIST')) throw new FileChangedOnDiskError();
      if (isHardLinkUnsupported(error)) throw new Error('Safe save is not supported on this filesystem');
      throw error;
    }

    const savedStat = await lstat(destinationPath);
    destinationHasTemp = sameFileIdentity(savedStat, tempStat);
    if (!savedStat.isFile() || !destinationHasTemp) throw new Error('Saved path changed while saving');
    await syncDirectory(directory.path);
    saved = true;
    return savedStat;
  } finally {
    if (saved) {
      await unlinkIfSameFile(tempPath, tempStat).catch(() => undefined);
      await unlinkIfSameFile(backup.path, backup.stat).catch(() => undefined);
    } else {
      if (destinationHasTemp) await unlinkIfSameFile(destinationPath, tempStat).catch(() => undefined);
      await restoreMovedBackupNoReplace(backup.path, backup.stat, destinationPath).catch(() => undefined);
      await unlinkIfSameFile(tempPath, tempStat).catch(() => undefined);
    }
  }
}

async function moveCurrentFileToBackup(directory: OpenDirectoryPath, destinationPath: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const backupPath = path.join(directory.path, saveScratchName('old', attempt));
    try {
      await lstat(backupPath);
      continue;
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) throw error;
    }

    try {
      await renamePath(destinationPath, backupPath);
      return { path: backupPath, stat: await lstat(backupPath) };
    } catch (error) {
      if (['ENOENT', 'ELOOP', 'EISDIR'].some((code) => isErrorCode(error, code))) throw new FileChangedOnDiskError();
      throw error;
    }
  }
  throw new Error('Could not create a temporary save backup');
}

async function assertHardLinkSupportedForSave(directory: OpenDirectoryPath, tempPath: string, tempStat: Stats) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const probePath = path.join(directory.path, saveScratchName('probe', attempt));
    try {
      await link(tempPath, probePath);
    } catch (error) {
      if (isErrorCode(error, 'EEXIST')) continue;
      if (isHardLinkUnsupported(error)) throw new Error('Safe save is not supported on this filesystem');
      throw error;
    }

    const probeStat = await lstat(probePath);
    try {
      if (!sameFileIdentity(probeStat, tempStat)) throw new Error('Path changed while checking save support');
      return;
    } finally {
      await unlinkIfSameFile(probePath, probeStat).catch(() => undefined);
    }
  }
  throw new Error('Could not check save support');
}

async function restoreMovedBackupNoReplace(backupPath: string, backupStat: Stats, destinationPath: string) {
  if (backupStat.isFile()) {
    try {
      await link(backupPath, destinationPath);
    } catch (error) {
      if (isErrorCode(error, 'EEXIST')) return false;
      throw error;
    }

    const restoredStat = await lstat(destinationPath);
    if (!sameFileIdentity(restoredStat, backupStat)) throw new Error('Path changed while restoring file');
    await unlinkIfSameFile(backupPath, backupStat).catch(() => undefined);
    return true;
  }

  try {
    await lstat(destinationPath);
    return false;
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) throw error;
  }
  await renamePath(backupPath, destinationPath);
  const restoredStat = await lstat(destinationPath);
  if (!sameFileIdentity(restoredStat, backupStat)) throw new Error('Path changed while restoring file');
  return true;
}

function saveScratchName(kind: string, attempt: number) {
  return `.pi-web-save-${kind}-${process.pid}-${Date.now()}-${randomBytes(8).toString('hex')}-${attempt}.tmp`;
}

async function syncDirectory(directoryPath: string) {
  let directory: FileHandle | undefined;
  try {
    directory = await open(directoryPath, constants.O_RDONLY);
    await directory.sync();
  } catch {
    // Directory fsync is a durability best-effort and is unsupported on some platforms/filesystems.
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

function entryNameFromRelativePath(value: string) {
  const name = value.split('/').filter(Boolean).at(-1);
  if (!name) throw new Error('Missing path');
  return name;
}

async function ensureDirectoryWithin(root: string, relativePath: string) {
  const segments = projectRelativePathSegments(relativePath);
  let directory = await openDirectoryPathWithin(root, root);
  try {
    for (const segment of segments) {
      const nextPath = path.join(directory.path, segment);
      try {
        await mkdir(nextPath, { mode: 0o700 });
      } catch (error) {
        if (!isErrorCode(error, 'EEXIST')) throw error;
      }
      const previousDirectory = directory;
      directory = await openDirectoryPathWithin(root, nextPath);
      await previousDirectory.close().catch(() => undefined);
    }
    return directory;
  } catch (error) {
    await directory.close().catch(() => undefined);
    throw error;
  }
}

async function writeUploadWithin(root: string, uploadDir: string, filename: string, input: NodeJS.ReadableStream) {
  const directory = await ensureDirectoryWithin(root, uploadDir);
  try {
    const cleanName = cleanUploadFilename(filename);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const prefix = `${Date.now()}-${attempt ? `${attempt}-` : ''}`;
      const name = `${prefix}${cleanName.slice(0, Math.max(1, 255 - prefix.length))}`;
      const target = path.join(directory.path, name);
      let file: FileHandle;
      try {
        file = await createFileHandleWithin(root, directory, name, 0o600);
      } catch (error) {
        if (isErrorCode(error, 'EEXIST')) continue;
        throw error;
      }

      const fileStat = await file.stat();
      let completed = false;
      let bytes = 0;
      try {
        await pipeline(input, new Transform({
          transform(chunk: Buffer | string, _encoding, callback) {
            bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
            callback(null, chunk);
          },
        }), file.createWriteStream());
        completed = true;
        return { filename: cleanName, path: joinProjectRelativePath(uploadDir, name), bytes };
      } finally {
        await file.close().catch(() => undefined);
        if (!completed) await unlinkIfSameFile(target, fileStat).catch(() => undefined);
      }
    }
    throw new Error('Could not create a unique upload file');
  } finally {
    await directory.close();
  }
}

function cleanUploadFilename(value: string) {
  return path.posix.basename(value.replace(/\\/g, '/')).replace(/[\0\r\n]/g, '').trim().slice(0, 255) || 'upload';
}

function projectRelativePathFromAbsolute(root: string, target: string) {
  const relativePath = path.relative(root, target).replace(/\\/g, '/');
  if (!relativePath || relativePath === '.') return '';
  if (path.posix.isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith('../')) throw new Error('Path escapes workspace');
  return path.posix.normalize(relativePath);
}

function fileHandleExternalPath(file: FileHandle) {
  return process.platform === 'linux' ? `/proc/${process.pid}/fd/${file.fd}` : `/dev/fd/${file.fd}`;
}

function projectRelativePathSegments(value: string) {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  if (!normalized || normalized === '.') return [];
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) throw new Error('Path escapes workspace');
  return normalized.split('/').filter(Boolean);
}

function projectDirectoryRelativePath(value: string, action: FileMutationAction) {
  const normalized = path.posix.normalize(value.trim().replace(/\\/g, '/'));
  if (!normalized || normalized === '.') return '';
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) throw new Error('Path escapes workspace');
  assertNoProtectedPathSegments(normalized, action);
  return normalized;
}

function mutableProjectRelativePath(value: string, action: FileMutationAction) {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  if (!normalized || normalized === '.') throw new Error(`Cannot ${action} the workspace root`);
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) throw new Error('Path escapes workspace');
  assertNoProtectedPathSegments(normalized, action);
  return normalized;
}

type FileMutationAction = 'create' | 'rename' | 'delete';

function assertNoProtectedPathSegments(value: string, action: FileMutationAction) {
  for (const segment of value.split('/')) {
    if (PROTECTED_FILE_ACTION_ROOTS.has(segment)) throw new Error(`Cannot ${action} ${segment}`);
  }
}

function cleanEntryName(value: string, action?: FileMutationAction) {
  const name = value.trim();
  if (!name) throw new Error('File name is required');
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new Error('File name cannot include path separators');
  if (action) assertNoProtectedPathSegments(name, action);
  return name;
}

function isCaseOnlyNameChange(previousName: string, nextName: string) {
  return previousName !== nextName && previousName.toLowerCase() === nextName.toLowerCase();
}

function parentRelativePath(value: string) {
  const parts = value.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function joinProjectRelativePath(base: string, name: string) {
  return base ? `${base}/${name}` : name;
}

async function assertPathDoesNotExist(target: string) {
  try {
    await lstat(target);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return;
    throw error;
  }
  throw fileExistsError();
}

function fileExistsError() {
  return new Error('A file or folder with that name already exists');
}

function isErrorCode(error: unknown, code: string) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

function shouldUseQuickFileSearch(query: string, projectId: string) {
  const cached = fileIndexCache.get(projectId);
  return query.length < 2 && !cached?.files.length;
}

async function quickSearchProjectFiles(projectId: string, projectPath: string, tokens: string[]) {
  const results: FileSearchResult[] = [];
  const pending = [''];
  let visited = 0;

  while (pending.length && results.length < MAX_SEARCH_RESULTS && visited < MAX_QUICK_SEARCH_VISITS) {
    const relativeDir = pending.shift()!;
    const target = resolveWithin(projectPath, relativeDir || '.');
    let entries: Dirent[];
    try {
      entries = await readDirectoryWithin(projectPath, target);
    } catch {
      continue;
    }

    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (visited >= MAX_QUICK_SEARCH_VISITS || results.length >= MAX_SEARCH_RESULTS) break;
      if (SKIPPED_SEARCH_DIRS.has(entry.name)) continue;
      visited += 1;
      const entryPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (tokens.length && !tokens.every((token) => entryPath.toLowerCase().includes(token))) continue;
      results.push({ path: entryPath, name: entry.name, directory: relativeDir });
    }
  }

  void projectFileIndex(projectId, projectPath).catch(() => undefined);
  return results;
}

async function projectFileIndex(projectId: string, projectPath: string) {
  const cached = fileIndexCache.get(projectId);
  const now = Date.now();
  if (cached?.promise && !cached.files.length) return cached.promise;
  if (cached && cached.expiresAt > now) return cached.files;
  if (cached?.promise) return cached.files.length ? cached.files : cached.promise;

  const entry = cached ?? { expiresAt: now + FILE_INDEX_CACHE_TTL_MS, files: [] } satisfies FileIndexCacheEntry;
  const promise = buildFileIndex(projectPath)
    .then((files) => {
      if (fileIndexCache.get(projectId) !== entry) return files;
      entry.files = files;
      entry.promise = undefined;
      entry.expiresAt = Date.now() + FILE_INDEX_CACHE_TTL_MS;
      fileIndexCache.set(projectId, entry);
      clearFileSearchCache(projectId);
      pruneFileIndexCache();
      return files;
    })
    .catch((error) => {
      if (fileIndexCache.get(projectId) === entry) {
        entry.promise = undefined;
        if (!entry.files.length) {
          fileIndexCache.delete(projectId);
          throw error;
        }
        entry.expiresAt = Date.now() + 10_000;
      }
      return entry.files;
    });

  entry.promise = promise;
  fileIndexCache.set(projectId, entry);

  if (entry.files.length) {
    entry.expiresAt = now + 10_000;
    return entry.files;
  }

  entry.expiresAt = now + FILE_INDEX_CACHE_TTL_MS;
  return promise;
}

async function buildFileIndex(projectPath: string): Promise<FileSearchEntry[]> {
  const files: FileSearchEntry[] = [];
  const pending = [''];
  let visited = 0;

  while (pending.length && visited < MAX_FILE_INDEX_VISITS && files.length < MAX_INDEXED_FILES) {
    const relativeDir = pending.shift()!;
    const target = resolveWithin(projectPath, relativeDir || '.');
    let entries: Dirent[];
    try {
      entries = await readDirectoryWithin(projectPath, target);
    } catch {
      continue;
    }

    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (visited >= MAX_FILE_INDEX_VISITS || files.length >= MAX_INDEXED_FILES) break;
      if (SKIPPED_SEARCH_DIRS.has(entry.name)) continue;
      visited += 1;
      const entryPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      files.push({ path: entryPath, name: entry.name, directory: relativeDir, searchText: entryPath.toLowerCase(), nameSearch: entry.name.toLowerCase() });
    }
  }

  return files;
}

function searchFileIndex(files: FileSearchEntry[], tokens: string[]): FileSearchResult[] {
  if (!tokens.length) return files.slice(0, MAX_SEARCH_RESULTS).map(fileSearchResult);
  return files
    .map((file) => {
      let score = 0;
      for (const token of tokens) {
        const pathIndex = file.searchText.indexOf(token);
        if (pathIndex === -1) return undefined;
        const nameIndex = file.nameSearch.indexOf(token);
        score += nameIndex === 0 ? 0 : nameIndex > 0 ? 2 : pathIndex === 0 ? 4 : 8;
        score += Math.min(pathIndex, 200) / 200;
      }
      return { file, score };
    })
    .filter((item): item is { file: FileSearchEntry; score: number } => Boolean(item))
    .sort((a, b) => a.score - b.score || a.file.path.length - b.file.path.length || a.file.path.localeCompare(b.file.path))
    .slice(0, MAX_SEARCH_RESULTS)
    .map(({ file }) => fileSearchResult(file));
}

function fileSearchResult(file: FileSearchEntry): FileSearchResult {
  return { path: file.path, name: file.name, directory: file.directory };
}

function assetEtag(size: number, mtimeMs: number) {
  return `W/"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}"`;
}

function fileVersionEtag(fileStat: Stats) {
  return fileVersionEtagFromParts(fileStat.mtimeMs, fileStat.size);
}

function fileVersionEtagFromParts(mtimeMs: number, size: number) {
  return `${mtimeMs.toString(36)}-${size.toString(36)}`;
}

function fileChangedSinceVersion(fileStat: Stats, previewMtimeMs: unknown, previewEtag: unknown) {
  if (typeof previewEtag === 'string') return previewEtag !== fileVersionEtag(fileStat);
  if (typeof previewMtimeMs === 'number') return Math.abs(fileStat.mtimeMs - previewMtimeMs) > 1;
  return false;
}

function fileContentHash(content: Buffer | string) {
  return createHash('sha256').update(content).digest('base64url');
}

function assetNotModified(ifNoneMatch: string | string[] | undefined, ifModifiedSince: string | undefined, etag: string, mtime: Date) {
  const etags = Array.isArray(ifNoneMatch) ? ifNoneMatch : ifNoneMatch ? [ifNoneMatch] : [];
  if (etags.length) {
    return etags.some((value) => value.split(',').map((item) => item.trim()).some((item) => item === '*' || weakEtagMatch(item, etag)));
  }
  if (!ifModifiedSince) return false;
  const since = Date.parse(ifModifiedSince);
  return Number.isFinite(since) && Math.floor(mtime.getTime() / 1000) <= Math.floor(since / 1000);
}

function weakEtagMatch(left: string, right: string) {
  return left.replace(/^W\//i, '') === right.replace(/^W\//i, '');
}

function assetContentSecurityPolicy(filePath: string) {
  return SANDBOXED_ASSET_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ? SANDBOXED_ASSET_CSP : undefined;
}

function safeHeaderFilename(filePath: string) {
  return path.basename(filePath).replace(/["\\\r\n]/g, '') || 'file';
}

function pruneFileIndexCache() {
  const now = Date.now();
  for (const [key, cached] of fileIndexCache) {
    if (!cached.promise && cached.expiresAt <= now) fileIndexCache.delete(key);
  }
  while (fileIndexCache.size > MAX_FILE_INDEX_CACHE_ENTRIES) {
    const key = fileIndexCache.keys().next().value;
    if (!key) break;
    fileIndexCache.delete(key);
  }
}

function pruneFileSearchCache() {
  const now = Date.now();
  for (const [key, cached] of fileSearchCache) {
    if (cached.expiresAt <= now) fileSearchCache.delete(key);
  }
  while (fileSearchCache.size > MAX_FILE_SEARCH_CACHE_ENTRIES) {
    const key = fileSearchCache.keys().next().value;
    if (!key) break;
    fileSearchCache.delete(key);
  }
}

function clearFileSearchCache(projectId: string) {
  const prefix = `${projectId}:`;
  for (const key of fileSearchCache.keys()) {
    if (key.startsWith(prefix)) fileSearchCache.delete(key);
  }
}

async function readTextPreview(root: string, target: string) {
  const realTarget = await assertRealPathWithin(root, target);
  const file = await open(realTarget, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    await assertOpenHandleWithin(root, file, realTarget);
    const fileStat = await file.stat();
    if (!fileStat.isFile()) throw new Error('Path is not a file');
    const buffer = Buffer.alloc(Math.min(fileStat.size, MAX_TEXT_BYTES));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const contentBuffer = buffer.subarray(0, bytesRead);
    const truncated = fileStat.size > MAX_TEXT_BYTES;
    return { content: contentBuffer.toString('utf8'), truncated, mtimeMs: fileStat.mtimeMs, size: fileStat.size, etag: fileVersionEtag(fileStat), contentHash: !truncated && bytesRead === fileStat.size ? fileContentHash(contentBuffer) : undefined };
  } finally {
    await file.close();
  }
}

async function openFileContentUnchangedOrEquals(root: string, target: string, expectedStat: Stats, baseContentHash: unknown, content: string, contentByteLength: number) {
  let file: FileHandle | undefined;
  try {
    file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    await assertOpenHandleWithin(root, file, target);
    const fileStat = await file.stat();
    if (!sameFileIdentity(fileStat, expectedStat) || fileStat.size > MAX_TEXT_BYTES) return false;
    const buffer = Buffer.alloc(fileStat.size);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== fileStat.size) return false;
    if (typeof baseContentHash === 'string' && fileContentHash(buffer) === baseContentHash) return true;
    return contentByteLength === fileStat.size && buffer.equals(Buffer.from(content, 'utf8'));
  } catch {
    return false;
  } finally {
    await file?.close();
  }
}

function contentTypeForPath(filePath: string) {
  return CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}
