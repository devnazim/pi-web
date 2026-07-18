import { getAgentDir, SessionManager, SettingsManager, type SessionInfo } from '@earendil-works/pi-coding-agent';
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { open, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectRegistry } from './projects.js';
import { cleanupOrphanedSessionReviewThreads, deleteSessionReviewThreads } from './reviewThreads.js';
import type { SessionDetail, SessionSummary } from './types.js';
import { cleanupOrphanedSessionUploads, deleteSessionUploads } from './uploads.js';
import { pathFromSessionId, sessionDirForCwd, sessionIdFromPath } from './util.js';

const DEFAULT_SESSION_LIMIT = 30;
const MAX_SESSION_LIMIT = 100;
const SESSION_PAGE_SCAN_BATCH_SIZE = 10;
const SESSION_UPLOAD_CLEANUP_INTERVAL_MS = 5 * 60_000;
const PENDING_SESSION_FILE_TTL_MS = 24 * 60 * 60_000;
const PI_SESSION_DIR_ENV = 'PI_CODING_AGENT_SESSION_DIR';

type SessionListOptions = { cursor?: string; limit?: string | number };
type SessionListPage = { sessions: SessionSummary[]; nextCursor?: string; total: number };
type SessionFileInfo = { path: string; modifiedMs: number; size: number };
type SessionListCursor = { path: string; updatedMs: number };
type SessionFileEntry = { type?: string; timestamp?: string; name?: string; message?: unknown; id?: unknown; [key: string]: unknown };
type DeletedSessionFile = { path: string; sessionUuid: string };
type SessionSummaryCacheEntry = { modifiedMs: number; size: number; summary: SessionSummary | null };

const sessionSummaryCache = new Map<string, SessionSummaryCacheEntry>();
const sessionResourceCleanupTimes = new Map<string, number>();
const pendingSessionFiles = new Map<string, number>();
const pendingSessionNames = new Map<string, string>();
const pendingSessionUuids = new Map<string, string>();
const pendingSessionCwds = new Map<string, string>();
const pendingSessionManagers = new Map<string, SessionManager>();

export async function listSessions(projectId: string, cwd: string): Promise<SessionSummary[]> {
  const sessions = await SessionManager.list(cwd, projectSessionDir(cwd));
  return sessions.map((session) => sessionSummaryFromInfo(projectId, session)).sort(compareSessionSummaries);
}

export async function listSessionPage(projectId: string, cwd: string, options: SessionListOptions = {}): Promise<SessionListPage> {
  const sessionFiles = await listSessionFiles(projectSessionDir(cwd));
  const limit = sessionLimit(options.limit);
  const parsedOffset = Number.parseInt(options.cursor ?? '', 10);
  const offset = String(parsedOffset) === options.cursor && Number.isFinite(parsedOffset) ? Math.max(0, Math.min(parsedOffset, sessionFiles.length)) : undefined;
  const cursor = offset === undefined ? parseSessionCursor(options.cursor) : undefined;
  const candidateLimit = (offset ?? 0) + limit;
  const candidates: SessionSummary[] = [];
  let hasMore = false;

  if (offset === sessionFiles.length) return { sessions: [], total: sessionFiles.length };

  for (let index = 0; index < sessionFiles.length;) {
    const pageLast = candidates[candidateLimit - 1];
    // Files are scanned newest mtime first; once the remaining files are older than the page tail, they cannot affect this page.
    if (pageLast && sessionFiles[index].modifiedMs < sessionUpdatedMs(pageLast)) {
      hasMore = true;
      break;
    }

    const batch = sessionFiles.slice(index, index + SESSION_PAGE_SCAN_BATCH_SIZE);
    index += batch.length;
    const summaries = await Promise.all(batch.map((file) => sessionSummaryFromFile(projectId, file)));

    for (const summary of summaries) {
      if (!summary || (cursor && !sessionComesAfterCursor(summary, cursor))) continue;
      candidates.push(summary);
    }

    candidates.sort(compareSessionSummaries);
    if (candidates.length > candidateLimit + 1) candidates.length = candidateLimit + 1;
  }

  const pageSessions = candidates.slice(offset ?? 0, candidateLimit);
  return {
    sessions: pageSessions,
    total: sessionFiles.length,
    ...((hasMore || candidates.length > candidateLimit) && pageSessions.length ? { nextCursor: sessionCursorForSession(pageSessions[pageSessions.length - 1]) } : {}),
  };
}

export async function createSessionFile(cwd: string) {
  const manager = SessionManager.create(cwd, projectSessionDir(cwd));
  const filePath = manager.getSessionFile();
  const header = manager.getHeader();
  if (!filePath || !header) throw new Error('Could not create pi session');
  if (!header.id) throw new Error('Could not determine pi session UUID');
  rememberPendingSessionFile(filePath, header.id, cwd, manager);
  return filePath;
}

export async function deleteSessionFile(sessionId: string, cwd: string): Promise<DeletedSessionFile> {
  const sessionDir = path.resolve(projectSessionDir(cwd));
  const { filePath, sessionUuid } = await resolveSessionIdentity(sessionId, cwd);
  if (path.dirname(path.resolve(filePath)) !== sessionDir) throw new Error('Session does not belong to this project');
  if (existsSync(filePath)) await unlink(filePath);
  else if (!isPendingSessionFile(filePath)) throw new Error('Unknown session');
  pendingSessionFiles.delete(path.resolve(filePath));
  pendingSessionNames.delete(path.resolve(filePath));
  pendingSessionUuids.delete(path.resolve(filePath));
  pendingSessionCwds.delete(path.resolve(filePath));
  pendingSessionManagers.delete(path.resolve(filePath));
  sessionSummaryCache.delete(filePath);
  return { path: filePath, sessionUuid };
}

export async function resolveSessionFile(sessionId: string, cwd: string) {
  const sessionDir = path.resolve(projectSessionDir(cwd));
  let decodedPath: string | undefined;
  try {
    decodedPath = path.resolve(pathFromSessionId(sessionId));
  } catch {
    // The id may be pi's session UUID rather than this web server's path token.
  }
  // New pi sessions intentionally do not hit disk until the first assistant reply.
  if (decodedPath?.endsWith('.jsonl') && path.dirname(decodedPath) === sessionDir) {
    if (existsSync(decodedPath)) {
      await assertSessionFileOwnership(decodedPath, cwd);
      pendingSessionFiles.delete(decodedPath);
      pendingSessionNames.delete(decodedPath);
      pendingSessionUuids.delete(decodedPath);
      pendingSessionCwds.delete(decodedPath);
      pendingSessionManagers.delete(decodedPath);
      return decodedPath;
    }
    if (isPendingSessionFile(decodedPath)) {
      assertPendingSessionOwnership(decodedPath, cwd);
      return decodedPath;
    }
  }

  cleanupPendingSessionFiles();
  const pendingPath = [...pendingSessionUuids.entries()].find(([filePath, uuid]) => (
    uuid === sessionId
    && path.dirname(filePath) === sessionDir
    && path.resolve(pendingSessionCwds.get(filePath) ?? '') === path.resolve(cwd)
  ))?.[0];
  if (pendingPath) {
    pendingSessionFiles.set(pendingPath, Date.now() + PENDING_SESSION_FILE_TTL_MS);
    return pendingPath;
  }

  const sessions = await SessionManager.list(cwd, sessionDir);
  const session = sessions.find((item) => item.id === sessionId || sessionIdFromPath(item.path) === sessionId || path.basename(item.path, '.jsonl').includes(sessionId));
  if (!session) throw new Error('Unknown session');
  await assertSessionFileOwnership(session.path, cwd);
  return session.path;
}

export async function resolveSessionIdentity(sessionId: string, cwd: string): Promise<{ filePath: string; sessionUuid: string }> {
  const sessionDir = path.resolve(projectSessionDir(cwd));
  const filePath = await resolveSessionFile(sessionId, cwd);
  const resolvedPath = path.resolve(filePath);
  if (path.dirname(resolvedPath) !== sessionDir) throw new Error('Session does not belong to this project');
  if (existsSync(resolvedPath)) {
    const header = await sessionHeaderFromFile(resolvedPath);
    if (!header?.id) throw new Error('Could not determine pi session UUID');
    const normalSessionDir = path.resolve(sessionDirForCwd(cwd));
    if (header.cwd ? path.resolve(header.cwd) !== path.resolve(cwd) : sessionDir !== normalSessionDir) {
      throw new Error('Session does not belong to this project');
    }
    return { filePath, sessionUuid: header.id };
  }
  const sessionUuid = pendingSessionUuids.get(resolvedPath);
  const pendingCwd = pendingSessionCwds.get(resolvedPath);
  if (!sessionUuid) throw new Error('Could not determine pi session UUID');
  if (!pendingCwd || path.resolve(pendingCwd) !== path.resolve(cwd)) throw new Error('Session does not belong to this project');
  return { filePath, sessionUuid };
}

export async function currentSessionUuids(cwd: string): Promise<string[]> {
  cleanupPendingSessionFiles();
  const sessionDir = path.resolve(projectSessionDir(cwd));
  const sessions = await SessionManager.list(cwd, sessionDir);
  const sessionHeaders = await Promise.all(sessions.map((session) => sessionHeaderFromFile(session.path)));
  return [...new Set([
    ...sessionHeaders
      .filter((header): header is { id: string; cwd: string | undefined } => Boolean(
        header?.id && (header.cwd ? path.resolve(header.cwd) === path.resolve(cwd) : sessionDir === path.resolve(sessionDirForCwd(cwd))),
      ))
      .map((header) => header.id),
    ...[...pendingSessionUuids.entries()]
      .filter(([filePath]) => path.dirname(filePath) === sessionDir && path.resolve(pendingSessionCwds.get(filePath) ?? '') === path.resolve(cwd))
      .map(([, uuid]) => uuid),
  ])];
}

export async function resolveSessionManager(
  sessionId: string,
  cwd: string,
  managerApi: Pick<typeof SessionManager, 'open'> = SessionManager,
): Promise<SessionManager> {
  const { filePath } = await resolveSessionIdentity(sessionId, cwd);
  const resolvedPath = path.resolve(filePath);
  const pendingManager = !existsSync(resolvedPath) ? pendingSessionManagers.get(resolvedPath) : undefined;
  const manager = pendingManager ?? managerApi.open(filePath, projectSessionDir(cwd), cwd);
  applyPendingSessionInfo(manager);
  return manager;
}

export async function sessionManagerForSession(sessionId: string, cwd: string): Promise<SessionManager> {
  return resolveSessionManager(sessionId, cwd);
}

export function readSessionDetail(filePath: string, cwd?: string): SessionDetail {
  const resolvedPath = path.resolve(filePath);
  const manager = !existsSync(resolvedPath) ? pendingSessionManagers.get(resolvedPath) ?? SessionManager.open(filePath, undefined, cwd) : SessionManager.open(filePath, undefined, cwd);
  applyPendingSessionInfo(manager);
  return sessionDetailFromManager(filePath, manager);
}

export function sessionDetailFromManager(filePath: string, manager: SessionManager): SessionDetail {
  const entries = manager.getEntries();
  const leafId = manager.getLeafId();
  return {
    sessionId: sessionIdFromPath(filePath),
    path: filePath,
    header: manager.getHeader(),
    entries,
    branch: sessionBranchFromEntries(entries, leafId),
    // Do not serialize the nested tree from SessionManager.getTree(). Long linear
    // sessions create thousands of nested child objects and can overflow
    // JSON.stringify's call stack in Fastify. The web client reconstructs the
    // tree iteratively from the flat entries instead.
    tree: [],
    leafId,
    name: manager.getSessionName(),
  };
}

function sessionBranchFromEntries(entries: SessionDetail['entries'], leafId: string | null) {
  if (!leafId) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: SessionDetail['entries'] = [];
  const visited = new Set<string>();
  let entry = byId.get(leafId);
  while (entry && !visited.has(entry.id)) {
    visited.add(entry.id);
    branch.push(entry);
    entry = entry.parentId ? byId.get(entry.parentId) : undefined;
  }
  return branch.reverse();
}

type PendingSessionInfoManager = Pick<SessionManager, 'appendSessionInfo' | 'getSessionFile'> & Partial<Pick<SessionManager, 'getSessionName'>>;

export function applyPendingSessionInfo(manager: PendingSessionInfoManager) {
  const filePath = manager.getSessionFile();
  if (!filePath || existsSync(filePath)) return;
  const key = path.resolve(filePath);
  const name = pendingSessionNames.get(key);
  if (name !== undefined && normalizeSessionName(manager.getSessionName?.()) !== normalizeSessionName(name)) manager.appendSessionInfo(name);
}

export function projectSessionDir(cwd: string) {
  const envSessionDir = process.env[PI_SESSION_DIR_ENV]?.trim();
  if (envSessionDir) return normalizeSessionDir(envSessionDir, cwd);
  const settingsSessionDir = SettingsManager.create(cwd, getAgentDir()).getSessionDir();
  return settingsSessionDir ? normalizeSessionDir(settingsSessionDir, cwd) : sessionDirForCwd(cwd);
}

function normalizeSessionDir(sessionDir: string, cwd: string) {
  let normalized = sessionDir;
  if (normalized === '~') return homedir();
  if (normalized.startsWith('~/') || normalized.startsWith('~\\')) normalized = path.join(homedir(), normalized.slice(2));
  else if (normalized.startsWith('file://')) normalized = fileURLToPath(normalized);
  return path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(cwd, normalized);
}

function rememberPendingSessionFile(filePath: string, sessionUuid: string, cwd: string, manager: SessionManager) {
  cleanupPendingSessionFiles();
  const resolved = path.resolve(filePath);
  pendingSessionFiles.set(resolved, Date.now() + PENDING_SESSION_FILE_TTL_MS);
  pendingSessionUuids.set(resolved, sessionUuid);
  pendingSessionCwds.set(resolved, path.resolve(cwd));
  pendingSessionManagers.set(resolved, manager);
}

function isPendingSessionFile(filePath: string) {
  cleanupPendingSessionFiles();
  const resolved = path.resolve(filePath);
  if (!pendingSessionFiles.has(resolved)) return false;
  pendingSessionFiles.set(resolved, Date.now() + PENDING_SESSION_FILE_TTL_MS);
  return true;
}

function cleanupPendingSessionFiles() {
  const now = Date.now();
  for (const [filePath, expiresAt] of pendingSessionFiles) {
    if (expiresAt <= now || existsSync(filePath)) {
      pendingSessionFiles.delete(filePath);
      pendingSessionNames.delete(filePath);
      pendingSessionUuids.delete(filePath);
      pendingSessionCwds.delete(filePath);
      pendingSessionManagers.delete(filePath);
    }
  }
}

function rememberPendingSessionName(filePath: string, name: string) {
  cleanupPendingSessionFiles();
  if (isPendingSessionFile(filePath) && !existsSync(filePath)) pendingSessionNames.set(path.resolve(filePath), name);
}

function appendSessionInfoIfChanged(manager: SessionManager, name: string) {
  if (normalizeSessionName(manager.getSessionName()) !== normalizeSessionName(name)) manager.appendSessionInfo(name);
}

function normalizeSessionName(name: string | undefined) {
  return name?.trim() || undefined;
}

function sessionHasAssistant(manager: SessionManager) {
  return manager.getEntries().some((entry) => entry.type === 'message' && entry.message.role === 'assistant');
}

async function currentSessionUploadIds(cwd: string) {
  return [
    ...sessionUploadIdsFromSummaries((await SessionManager.list(cwd, projectSessionDir(cwd))).map((session) => sessionSummaryFromInfo('', session))),
    ...pendingSessionUploadIds(cwd),
  ];
}

function pendingSessionUploadIds(cwd: string) {
  cleanupPendingSessionFiles();
  const sessionDir = path.resolve(projectSessionDir(cwd));
  return [...pendingSessionFiles.keys()]
    .filter((filePath) => path.dirname(filePath) === sessionDir)
    .flatMap((filePath) => [sessionIdFromPath(filePath), path.basename(filePath, '.jsonl')]);
}

function sessionUploadIdsFromSummaries(sessions: SessionSummary[]) {
  return sessions.flatMap((session) => [session.id, session.sessionUuid, sessionIdFromPath(session.path), path.basename(session.path, '.jsonl')]);
}

function sessionUploadIdsFromDeletedSession(deleted: DeletedSessionFile, requestedId: string) {
  return [requestedId, deleted.sessionUuid, sessionIdFromPath(deleted.path), path.basename(deleted.path, '.jsonl')];
}

async function assertSessionFileOwnership(filePath: string, cwd: string) {
  const header = await sessionHeaderFromFile(filePath);
  if (!header?.id) throw new Error('Could not determine pi session UUID');
  const sessionDir = path.resolve(projectSessionDir(cwd));
  if (header.cwd ? path.resolve(header.cwd) !== path.resolve(cwd) : sessionDir !== path.resolve(sessionDirForCwd(cwd))) {
    throw new Error('Session does not belong to this project');
  }
}

function assertPendingSessionOwnership(filePath: string, cwd: string) {
  const pendingCwd = pendingSessionCwds.get(path.resolve(filePath));
  if (!pendingCwd || path.resolve(pendingCwd) !== path.resolve(cwd)) throw new Error('Session does not belong to this project');
}

async function sessionHeaderFromFile(filePath: string) {
  try {
    const line = await readFirstLine(filePath);
    const header = JSON.parse(line) as unknown;
    if (!isRecord(header) || header.type !== 'session' || typeof header.id !== 'string') return undefined;
    return { id: header.id, cwd: typeof header.cwd === 'string' ? header.cwd : undefined };
  } catch {
    return undefined;
  }
}

async function readFirstLine(filePath: string) {
  const file = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    let offset = 0;
    let line = '';
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) return line;
      line += buffer.subarray(0, bytesRead).toString('utf8');
      const newlineIndex = line.indexOf('\n');
      if (newlineIndex !== -1) return line.slice(0, newlineIndex);
      offset += bytesRead;
    }
  } finally {
    await file.close();
  }
}

type SessionRouteBridge = {
  lockSessionDeletion(projectPath: string, sessionId: string, filePath?: string): Promise<(() => void) | undefined>;
  lockSessionMutation(projectPath: string, sessionId: string, filePath?: string): Promise<(() => void) | undefined>;
  disposeSession(projectPath: string, sessionId: string, filePath?: string): Promise<void>;
  renameSession(projectPath: string, sessionId: string, name: string, filePath?: string): Promise<SessionDetail | undefined>;
};

export async function registerSessionRoutes(app: FastifyInstance, registry: ProjectRegistry, bridge?: SessionRouteBridge) {
  app.get<{ Params: { projectId: string }; Querystring: { cursor?: string; limit?: string } }>('/api/projects/:projectId/sessions', async (request, reply) => {
    try {
      const project = registry.get(request.params.projectId);
      if (!request.query.cursor && !request.query.limit) {
        const sessions = await listSessions(project.id, project.path);
        maybeCleanupOrphanedSessionResources(project.path, request.log);
        return { sessions };
      }
      const page = await listSessionPage(project.id, project.path, request.query);
      maybeCleanupOrphanedSessionResources(project.path, request.log);
      return page;
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : 'Unknown project' });
    }
  });

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/sessions', async (request, reply) => {
    try {
      const project = registry.get(request.params.projectId);
      const filePath = await createSessionFile(project.path);
      return { session: sessionSummaryFromDetail(project.id, readSessionDetail(filePath, project.path)) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not create session' });
    }
  });

  app.delete<{ Params: { projectId: string; sessionId: string } }>('/api/projects/:projectId/sessions/:sessionId', async (request, reply) => {
    try {
      const project = registry.get(request.params.projectId);
      const filePath = await resolveSessionFile(request.params.sessionId, project.path);
      const releaseDeleteLock = await bridge?.lockSessionDeletion(project.path, request.params.sessionId, filePath);
      if (bridge && !releaseDeleteLock) return reply.code(409).send({ error: 'Session is running. Stop it before deleting.' });
      try {
        const deleted = await deleteSessionFile(request.params.sessionId, project.path);
        await bridge?.disposeSession(project.path, request.params.sessionId, deleted.path).catch((error) => request.log.warn({ err: error }, 'Could not dispose cached session'));
        await deleteSessionUploads(project.path, sessionUploadIdsFromDeletedSession(deleted, request.params.sessionId)).catch((error) => request.log.warn({ err: error }, 'Could not delete session uploads'));
        await deleteSessionReviewThreads(project.path, deleted.sessionUuid).catch((error) => request.log.warn({ err: error }, 'Could not delete session review threads'));
        return { ok: true };
      } finally {
        releaseDeleteLock?.();
      }
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : 'Unknown session' });
    }
  });

  app.delete<{ Params: { projectId: string }; Querystring: { sessionId?: string } }>('/api/projects/:projectId/session', async (request, reply) => {
    try {
      if (!request.query.sessionId) return reply.code(400).send({ error: 'Missing sessionId' });
      const project = registry.get(request.params.projectId);
      const filePath = await resolveSessionFile(request.query.sessionId, project.path);
      const releaseDeleteLock = await bridge?.lockSessionDeletion(project.path, request.query.sessionId, filePath);
      if (bridge && !releaseDeleteLock) return reply.code(409).send({ error: 'Session is running. Stop it before deleting.' });
      try {
        const deleted = await deleteSessionFile(request.query.sessionId, project.path);
        await bridge?.disposeSession(project.path, request.query.sessionId, deleted.path).catch((error) => request.log.warn({ err: error }, 'Could not dispose cached session'));
        await deleteSessionUploads(project.path, sessionUploadIdsFromDeletedSession(deleted, request.query.sessionId)).catch((error) => request.log.warn({ err: error }, 'Could not delete session uploads'));
        await deleteSessionReviewThreads(project.path, deleted.sessionUuid).catch((error) => request.log.warn({ err: error }, 'Could not delete session review threads'));
        return { ok: true };
      } finally {
        releaseDeleteLock?.();
      }
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : 'Unknown session' });
    }
  });

  app.get<{ Params: { projectId: string }; Querystring: { sessionId?: string } }>('/api/projects/:projectId/session', async (request, reply) => {
    try {
      if (!request.query.sessionId) return reply.code(400).send({ error: 'Missing sessionId' });
      const project = registry.get(request.params.projectId);
      return readSessionDetail(await resolveSessionFile(request.query.sessionId, project.path), project.path);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : 'Unknown session' });
    }
  });

  app.post<{ Params: { projectId: string }; Querystring: { sessionId?: string }; Body: { entryId?: string; label?: string } }>('/api/projects/:projectId/session/label', async (request, reply) => {
    try {
      if (!request.query.sessionId) return reply.code(400).send({ error: 'Missing sessionId' });
      const body = request.body ?? {};
      if (!body.entryId) return reply.code(400).send({ error: 'Missing entryId' });
      const project = registry.get(request.params.projectId);
      const filePath = await resolveSessionFile(request.query.sessionId, project.path);
      const releaseMutationLock = await bridge?.lockSessionMutation(project.path, request.query.sessionId, filePath);
      if (bridge && !releaseMutationLock) return reply.code(409).send({ error: 'Session is being deleted.' });
      try {
        const manager = SessionManager.open(filePath, undefined, project.path);
        if (!manager.getEntry(body.entryId)) return reply.code(404).send({ error: 'Unknown entry' });
        manager.appendLabelChange(body.entryId, body.label?.trim() || undefined);
        return readSessionDetail(filePath, project.path);
      } finally {
        releaseMutationLock?.();
      }
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : 'Unknown session' });
    }
  });

  app.post<{ Params: { projectId: string }; Querystring: { sessionId?: string }; Body: { name?: string } }>('/api/projects/:projectId/session/rename', async (request, reply) => {
    try {
      if (!request.query.sessionId) return reply.code(400).send({ error: 'Missing sessionId' });
      const body = request.body ?? {};
      const name = body.name?.trim() ?? '';
      const project = registry.get(request.params.projectId);
      const filePath = await resolveSessionFile(request.query.sessionId, project.path);
      const releaseMutationLock = await bridge?.lockSessionMutation(project.path, request.query.sessionId, filePath);
      if (bridge && !releaseMutationLock) return reply.code(409).send({ error: 'Session is being deleted.' });
      try {
        const fileExists = existsSync(filePath);

        if (fileExists) {
          const manager = SessionManager.open(filePath, undefined, project.path);
          if (!sessionHasAssistant(manager)) return reply.code(409).send({ error: 'Session can be renamed after the first assistant response.' });
          const activeDetail = await bridge?.renameSession(project.path, request.query.sessionId, name, filePath);
          sessionSummaryCache.delete(filePath);
          if (activeDetail) return activeDetail;
          appendSessionInfoIfChanged(manager, name);
          return sessionDetailFromManager(filePath, manager);
        }

        rememberPendingSessionName(filePath, name);
        const activeDetail = await bridge?.renameSession(project.path, request.query.sessionId, name, filePath);
        sessionSummaryCache.delete(filePath);
        return activeDetail ?? readSessionDetail(filePath, project.path);
      } finally {
        releaseMutationLock?.();
      }
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : 'Unknown session' });
    }
  });

  app.get<{ Params: { sessionId: string }; Querystring: { projectId?: string } }>('/api/sessions/:sessionId', async (request, reply) => {
    try {
      if (request.query.projectId) {
        const project = registry.get(request.query.projectId);
        return readSessionDetail(await resolveSessionFile(request.params.sessionId, project.path), project.path);
      }
      return readSessionDetail(pathFromSessionId(request.params.sessionId));
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : 'Unknown session' });
    }
  });
}

function maybeCleanupOrphanedSessionResources(projectPath: string, log: { warn: (...args: any[]) => void }) {
  const now = Date.now();
  const lastCleanup = sessionResourceCleanupTimes.get(projectPath) ?? 0;
  if (now - lastCleanup < SESSION_UPLOAD_CLEANUP_INTERVAL_MS) return;
  sessionResourceCleanupTimes.set(projectPath, now);
  void Promise.all([
    currentSessionUploadIds(projectPath).then((ids) => cleanupOrphanedSessionUploads(projectPath, ids)),
    currentSessionUuids(projectPath).then((uuids) => cleanupOrphanedSessionReviewThreads(projectPath, uuids)),
  ]).catch((error) => log.warn({ err: error }, 'Could not clean up orphaned session resources'));
}

async function listSessionFiles(dir: string): Promise<SessionFileInfo[]> {
  if (!existsSync(dir)) return [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'));
    const stats = await Promise.all(files.map(async (entry) => {
      const filePath = path.join(dir, entry.name);
      try {
        const fileStat = await stat(filePath);
        return { path: filePath, modifiedMs: fileStat.mtime.getTime(), size: fileStat.size };
      } catch {
        return undefined;
      }
    }));
    return stats
      .filter((file): file is SessionFileInfo => Boolean(file))
      .sort((a, b) => b.modifiedMs - a.modifiedMs || b.path.localeCompare(a.path));
  } catch {
    return [];
  }
}

async function sessionSummaryFromFile(projectId: string, file: SessionFileInfo): Promise<SessionSummary | null> {
  const cached = sessionSummaryCache.get(file.path);
  if (cached && cached.modifiedMs === file.modifiedMs && cached.size === file.size) {
    return cached.summary ? { ...cached.summary, projectId } : null;
  }

  try {
    const entries = parseSessionFileEntries(await readFile(file.path, 'utf8'));
    const header = entries.find((entry) => entry.type === 'session');
    if (!header) {
      sessionSummaryCache.set(file.path, { modifiedMs: file.modifiedMs, size: file.size, summary: null });
      return null;
    }

    let name: string | undefined;
    let firstMessage = '';
    let messageCount = 0;
    let lastActivityMs: number | undefined;

    for (const entry of entries) {
      if (entry.type === 'session_info') {
        name = typeof entry.name === 'string' ? entry.name.trim() || undefined : undefined;
        continue;
      }
      if (entry.type !== 'message') continue;
      messageCount++;

      const message = isRecord(entry.message) ? entry.message : undefined;
      const role = typeof message?.role === 'string' ? message.role : undefined;
      if (message && (role === 'user' || role === 'assistant')) {
        const timestamp = typeof message.timestamp === 'number' ? message.timestamp : parseTimestamp(entry.timestamp);
        if (timestamp !== undefined) lastActivityMs = Math.max(lastActivityMs ?? 0, timestamp);
      }
      if (message && !firstMessage && role === 'user') firstMessage = textFromContent(message.content).trim();
    }

    const updatedAt = lastActivityMs ?? parseTimestamp(header.timestamp) ?? file.modifiedMs;
    const summary = {
      id: sessionIdFromPath(file.path),
      sessionUuid: typeof header.id === 'string' ? header.id : undefined,
      projectId,
      title: name || firstMessage || (messageCount > 0 ? path.basename(file.path, '.jsonl') : ''),
      path: file.path,
      updatedAt: new Date(updatedAt).toISOString(),
      entryCount: messageCount,
    } satisfies SessionSummary;
    sessionSummaryCache.set(file.path, { modifiedMs: file.modifiedMs, size: file.size, summary });
    return summary;
  } catch {
    sessionSummaryCache.set(file.path, { modifiedMs: file.modifiedMs, size: file.size, summary: null });
    return null;
  }
}

function parseSessionFileEntries(content: string): SessionFileEntry[] {
  const entries: SessionFileEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as unknown;
      if (isRecord(entry) && typeof entry.type === 'string') entries.push(entry as SessionFileEntry);
    } catch {
      // Skip malformed lines.
    }
  }
  return entries;
}

function sessionLimit(limit: string | number | undefined) {
  const parsed = typeof limit === 'number' ? limit : Number.parseInt(limit ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SESSION_LIMIT;
  return Math.min(Math.floor(parsed), MAX_SESSION_LIMIT);
}

function compareSessionSummaries(a: SessionSummary, b: SessionSummary) {
  return sessionUpdatedMs(b) - sessionUpdatedMs(a) || b.path.localeCompare(a.path);
}

function sessionUpdatedMs(session: Pick<SessionSummary, 'updatedAt'>) {
  const parsed = Date.parse(session.updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sessionCursorForSession(session: SessionSummary) {
  return Buffer.from(JSON.stringify({ path: session.path, updatedAt: session.updatedAt })).toString('base64url');
}

function parseSessionCursor(cursor: string | undefined): SessionListCursor | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(value) || typeof value.path !== 'string') return undefined;
    const updatedMs = typeof value.updatedAt === 'string' ? Date.parse(value.updatedAt) : typeof value.modifiedMs === 'number' ? value.modifiedMs : NaN;
    if (Number.isNaN(updatedMs)) return undefined;
    return { path: value.path, updatedMs };
  } catch {
    return undefined;
  }
}

function sessionComesAfterCursor(session: SessionSummary, cursor: SessionListCursor) {
  const updatedMs = sessionUpdatedMs(session);
  return updatedMs < cursor.updatedMs || (updatedMs === cursor.updatedMs && session.path.localeCompare(cursor.path) < 0);
}

function parseTimestamp(timestamp: unknown) {
  if (typeof timestamp !== 'string') return undefined;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(textFromContent).filter(Boolean).join(' ');
  if (!isRecord(content)) return '';
  if (typeof content.text === 'string') return content.text;
  if ('content' in content) return textFromContent(content.content);
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sessionSummaryFromInfo(projectId: string, session: SessionInfo): SessionSummary {
  return {
    id: sessionIdFromPath(session.path),
    sessionUuid: session.id,
    projectId,
    title: session.name || session.firstMessage || (session.messageCount > 0 ? path.basename(session.path, '.jsonl') : ''),
    path: session.path,
    updatedAt: session.modified.toISOString(),
    entryCount: session.messageCount,
  };
}

function sessionSummaryFromDetail(projectId: string, session: SessionDetail): SessionSummary {
  return {
    id: session.sessionId,
    sessionUuid: session.header?.id,
    projectId,
    title: session.name || '',
    path: session.path,
    updatedAt: session.header?.timestamp ?? new Date().toISOString(),
    entryCount: session.entries.filter((entry) => entry.type === 'message').length,
  };
}
