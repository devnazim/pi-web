import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, lstat, mkdir, open, readFile, realpath, readdir, rename, rm, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { getGitStatus, getReviewableFile } from './git.js';
import type { ProjectRegistry } from './projects.js';
import { projectSessionDir, resolveSessionIdentity } from './sessions.js';
import { resolveWithin } from './util.js';

const STORE_VERSION = 1;
const STORAGE_DIRECTORY = path.join('.pi-web', 'review-threads');
const CONTEXT_LINE_COUNT = 3;
const MAX_BODY_LENGTH = 64 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SELECTED_LINES = 500;
const MAX_THREADS = 500;
const MAX_MESSAGES_PER_THREAD = 1_000;
const MAX_STORE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_READ_CONCURRENCY = 8;
const STORE_LOCK_RETRY_MS = 50;
const STORE_LOCK_TIMEOUT_MS = 5_000;
const STORE_LOCK_STALE_MS = 60_000;

export type ReviewAuthor = 'user' | 'agent';
export type ReviewThreadStatus = 'open' | 'resolved';

export interface ReviewAnchor {
  path: string;
  staged?: boolean;
  startLine: number;
  endLine: number;
  selectedText: string;
  contextBefore: string[];
  contextAfter: string[];
}

export interface ReviewMessage {
  id: string;
  author: ReviewAuthor;
  body: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
  userRevision?: number;
  handlesUserRevision?: number;
}

export interface ReviewThread {
  id: string;
  anchor: ReviewAnchor;
  status: ReviewThreadStatus;
  outdated: boolean;
  outdatedReason?: string;
  latestUserRevision: number;
  createdAt: string;
  updatedAt: string;
  messages: ReviewMessage[];
}

export interface ReviewThreadCollection {
  revision: number;
  threads: ReviewThread[];
}

export interface PendingReviewThreadOptions {
  includeResolved?: boolean;
  includeHandled?: boolean;
  cursor?: string;
  limit?: number;
  path?: string;
}

interface StoredReviewThread extends Omit<ReviewThread, 'outdated' | 'outdatedReason'> {}
interface ReviewThreadStore {
  version: typeof STORE_VERSION;
  revision: number;
  threads: StoredReviewThread[];
}

export class ReviewThreadConflictError extends Error {
  constructor(message = 'Review threads changed; reload and try again') {
    super(message);
    this.name = 'ReviewThreadConflictError';
  }
}

export class ReviewThreadNotFoundError extends Error {
  constructor(message = 'Unknown review thread') {
    super(message);
    this.name = 'ReviewThreadNotFoundError';
  }
}

export class ReviewThreadPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewThreadPermissionError';
  }
}

export class ReviewThreadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewThreadValidationError';
  }
}

const storeQueues = new Map<string, Promise<void>>();

export async function getReviewThreads(projectPath: string, sessionId: string): Promise<ReviewThreadCollection> {
  const identity = await resolveSessionIdentity(sessionId, projectPath);
  return serializeStore(storePath(projectPath, identity.sessionUuid), async () => collectionFromStore(projectPath, await readStore(projectPath, identity.sessionUuid)));
}

export async function getPendingReviewThreads(
  projectPath: string,
  sessionId: string,
  options: PendingReviewThreadOptions = {},
): Promise<ReviewThreadCollection & { total?: number; nextCursor?: string }> {
  const collection = await getReviewThreads(projectPath, sessionId);
  const filtered = collection.threads.filter((thread) => {
    if (options.path && thread.anchor.path !== options.path) return false;
    if (!options.includeResolved && thread.status === 'resolved') return false;
    return options.includeHandled || latestHandledUserRevision(thread) < latestActionableUserRevision(thread);
  });
  const parsedCursor = Number.parseInt(options.cursor ?? '0', 10);
  const offset = Number.isSafeInteger(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
  const limit = options.limit === undefined ? filtered.length : Math.max(1, Math.min(100, Math.floor(options.limit)));
  const threads = filtered.slice(offset, offset + limit);
  return {
    revision: collection.revision,
    threads,
    ...((options.cursor !== undefined || options.limit !== undefined) ? { total: filtered.length } : {}),
    ...(offset + threads.length < filtered.length ? { nextCursor: String(offset + threads.length) } : {}),
  };
}

export async function addAgentReviewReply(
  projectPath: string,
  sessionId: string,
  input: { threadId: string; body: string; handlesUserRevision: number; resolve?: boolean },
): Promise<ReviewThreadCollection> {
  const body = reviewBody(input.body);
  return mutateForSession(projectPath, sessionId, undefined, async (store) => {
    const thread = storedThread(store, input.threadId);
    assertHandlesCurrentRevision(thread, input.handlesUserRevision);
    thread.messages.push(agentMessage(body, input.handlesUserRevision));
    if (thread.messages.length > MAX_MESSAGES_PER_THREAD) throw new ReviewThreadValidationError('Review thread has too many messages');
    thread.status = input.resolve ? 'resolved' : thread.status;
    thread.updatedAt = new Date().toISOString();
  });
}

export async function createAgentReviewThread(
  projectPath: string,
  sessionId: string,
  input: { path: string; staged?: boolean; startLine: number; endLine: number; selectedText: string; contextBefore: string[]; contextAfter: string[]; body: string },
): Promise<ReviewThreadCollection> {
  const body = reviewBody(input.body);
  return mutateForSession(projectPath, sessionId, undefined, async (store) => {
    if (store.threads.length >= MAX_THREADS) throw new ReviewThreadValidationError('Too many review threads');
    const anchor = await captureAnchor(projectPath, input.path, Boolean(input.staged), input.startLine, input.endLine, {
      selectedText: reviewSelectedText(input.selectedText),
      contextBefore: reviewAnchorContext(input.contextBefore, 'contextBefore'),
      contextAfter: reviewAnchorContext(input.contextAfter, 'contextAfter'),
    });
    const now = new Date().toISOString();
    store.threads.push({
      id: randomUUID(),
      anchor,
      status: 'open',
      latestUserRevision: 0,
      createdAt: now,
      updatedAt: now,
      messages: [agentMessage(body, 0, now)],
    });
  });
}

export async function resolveAgentReviewThread(
  projectPath: string,
  sessionId: string,
  input: { threadId: string; handlesUserRevision: number; body?: string },
): Promise<ReviewThreadCollection> {
  const body = input.body === undefined ? undefined : reviewBody(input.body);
  return mutateForSession(projectPath, sessionId, undefined, async (store) => {
    const thread = storedThread(store, input.threadId);
    assertHandlesCurrentRevision(thread, input.handlesUserRevision);
    if (body !== undefined) {
      thread.messages.push(agentMessage(body, input.handlesUserRevision));
      if (thread.messages.length > MAX_MESSAGES_PER_THREAD) throw new ReviewThreadValidationError('Review thread has too many messages');
    } else if (latestHandledUserRevision(thread) < latestActionableUserRevision(thread)) {
      throw new ReviewThreadValidationError('A reply body is required to handle the latest user revision');
    }
    thread.status = 'resolved';
    thread.updatedAt = new Date().toISOString();
  });
}

export async function deleteSessionReviewThreads(projectPath: string, sessionUuid: string): Promise<void> {
  const filePath = storePath(projectPath, sessionUuid);
  await serializeStore(filePath, async () => {
    const directory = await assertSafeStorageDirectory(projectPath, false);
    if (!directory) return;
    await withStoreFileLock(projectPath, filePath, async (assertOwnership) => {
      await assertOwnership();
      await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    });
    await deleteStoreArtifacts(directory, path.basename(filePath));
  });
}

export async function cleanupOrphanedSessionReviewThreads(projectPath: string, validSessionUuids: Iterable<string>): Promise<void> {
  const directory = await assertSafeStorageDirectory(projectPath, false);
  if (!directory) return;
  const validNames = new Set([...validSessionUuids].map((uuid) => storeFileName(uuid)));
  const cleanupStartedAt = Date.now();
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !/^session-[a-f0-9]{64}\.json$/.test(entry.name) || validNames.has(entry.name)) return;
    const filePath = path.join(directory, entry.name);
    await serializeStore(filePath, () => withStoreFileLock(projectPath, filePath, async (assertOwnership) => {
      if (validNames.has(entry.name)) return;
      const storeInfo = await lstat(filePath).catch(() => undefined);
      if (!storeInfo || storeInfo.mtimeMs >= cleanupStartedAt) return;
      await assertOwnership();
      await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }));
  }));
  await Promise.all(entries.map(async (entry) => {
    const storeName = storeNameFromArtifact(entry.name);
    if ((!entry.isFile() && !entry.isSymbolicLink()) || !storeName || entry.name === storeName || validNames.has(storeName)) return;
    const artifactPath = path.join(directory, entry.name);
    const info = await lstat(artifactPath).catch(() => undefined);
    if (!info || info.mtimeMs >= cleanupStartedAt) return;
    if (entry.name.includes('.lock') && cleanupStartedAt - info.mtimeMs <= STORE_LOCK_STALE_MS) return;
    await unlink(artifactPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }));
}

export async function registerReviewThreadRoutes(app: FastifyInstance, registry: ProjectRegistry) {
  const route = '/api/projects/:projectId/review-threads';

  app.get<{ Params: { projectId: string }; Querystring: { sessionId?: string } }>(route, async (request, reply) => {
    try {
      const project = registry.get(request.params.projectId);
      return await getReviewThreads(project.path, reviewRouteSessionId(request.query.sessionId));
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post<{ Params: { projectId: string }; Querystring: { sessionId?: string }; Body: { expectedRevision?: unknown; anchor?: { path?: unknown; staged?: unknown; startLine?: unknown; endLine?: unknown; selectedText?: unknown; contextBefore?: unknown; contextAfter?: unknown }; body?: unknown } }>(route, async (request, reply) => {
    try {
      const project = registry.get(request.params.projectId);
      const body = request.body ?? {};
      const expectedRevision = expectedRevisionFrom(body.expectedRevision);
      if (!isRecord(body.anchor) || typeof body.anchor.path !== 'string') throw new ReviewThreadValidationError('Invalid review anchor');
      if (body.anchor.staged !== undefined && typeof body.anchor.staged !== 'boolean') throw new ReviewThreadValidationError('Invalid review anchor baseline');
      const staged = body.anchor.staged === true;
      const startLine = lineNumber(body.anchor.startLine, 'startLine');
      const endLine = lineNumber(body.anchor.endLine, 'endLine');
      const selectedText = reviewSelectedText(body.anchor.selectedText);
      const contextBefore = reviewAnchorContext(body.anchor.contextBefore, 'contextBefore');
      const contextAfter = reviewAnchorContext(body.anchor.contextAfter, 'contextAfter');
      const messageBody = reviewBody(body.body);
      let createdThreadId = '';
      const collection = await mutateForSession(project.path, reviewRouteSessionId(request.query.sessionId), expectedRevision, async (store) => {
        if (store.threads.length >= MAX_THREADS) throw new ReviewThreadValidationError('Too many review threads');
        const anchor = await captureAnchor(project.path, body.anchor!.path as string, staged, startLine, endLine, { selectedText, contextBefore, contextAfter });
        const now = new Date().toISOString();
        createdThreadId = randomUUID();
        store.threads.push({
          id: createdThreadId,
          anchor,
          status: 'open',
          latestUserRevision: 1,
          createdAt: now,
          updatedAt: now,
          messages: [{ id: randomUUID(), author: 'user', body: messageBody, createdAt: now, userRevision: 1 }],
        });
      });
      return { ...collection, thread: collection.threads.find((thread) => thread.id === createdThreadId) };
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post<{ Params: { projectId: string; threadId: string }; Querystring: { sessionId?: string }; Body: { expectedRevision?: unknown; body?: unknown } }>(`${route}/:threadId/messages`, async (request, reply) => {
    try {
      const project = registry.get(request.params.projectId);
      const body = request.body ?? {};
      return await mutateForSession(project.path, reviewRouteSessionId(request.query.sessionId), expectedRevisionFrom(body.expectedRevision), async (store) => {
        const thread = storedThread(store, request.params.threadId);
        if (thread.messages.length >= MAX_MESSAGES_PER_THREAD) throw new ReviewThreadValidationError('Review thread has too many messages');
        const now = new Date().toISOString();
        const userRevision = ++thread.latestUserRevision;
        thread.messages.push({ id: randomUUID(), author: 'user', body: reviewBody(body.body), createdAt: now, userRevision });
        thread.status = 'open';
        thread.updatedAt = now;
      });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch<{ Params: { projectId: string; threadId: string; messageId: string }; Querystring: { sessionId?: string }; Body: { expectedRevision?: unknown; body?: unknown } }>(`${route}/:threadId/messages/:messageId`, async (request, reply) => {
    try {
      const project = registry.get(request.params.projectId);
      const body = request.body ?? {};
      return await mutateForSession(project.path, reviewRouteSessionId(request.query.sessionId), expectedRevisionFrom(body.expectedRevision), async (store) => {
        const thread = storedThread(store, request.params.threadId);
        const message = editableUserMessage(thread, request.params.messageId);
        const now = new Date().toISOString();
        message.body = reviewBody(body.body);
        message.updatedAt = now;
        message.userRevision = ++thread.latestUserRevision;
        thread.status = 'open';
        thread.updatedAt = now;
      });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.delete<{ Params: { projectId: string; threadId: string; messageId: string }; Querystring: { sessionId?: string }; Body: { expectedRevision?: unknown } }>(`${route}/:threadId/messages/:messageId`, async (request, reply) => {
    try {
      const project = registry.get(request.params.projectId);
      const body = request.body ?? {};
      let deletedThreadId: string | undefined;
      const collection = await mutateForSession(project.path, reviewRouteSessionId(request.query.sessionId), expectedRevisionFrom(body.expectedRevision), async (store) => {
        const thread = storedThread(store, request.params.threadId);
        const message = editableUserMessage(thread, request.params.messageId);
        const index = thread.messages.indexOf(message);
        const now = new Date().toISOString();
        if (index === 0 && thread.messages.length === 1) {
          store.threads.splice(store.threads.indexOf(thread), 1);
          deletedThreadId = thread.id;
          return;
        }
        if (index === 0) {
          message.body = '';
          message.deletedAt = now;
          message.updatedAt = now;
        } else {
          thread.messages.splice(index, 1);
        }
        thread.updatedAt = now;
      });
      return { ...collection, ...(deletedThreadId ? { deletedThread: { id: deletedThreadId } } : {}) };
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.patch<{ Params: { projectId: string; threadId: string }; Querystring: { sessionId?: string }; Body: { expectedRevision?: unknown; status?: unknown } }>(`${route}/:threadId`, async (request, reply) => {
    try {
      const project = registry.get(request.params.projectId);
      const body = request.body ?? {};
      if (body.status !== 'open' && body.status !== 'resolved') throw new ReviewThreadValidationError('Invalid review thread status');
      return await mutateForSession(project.path, reviewRouteSessionId(request.query.sessionId), expectedRevisionFrom(body.expectedRevision), async (store) => {
        const thread = storedThread(store, request.params.threadId);
        thread.status = body.status as ReviewThreadStatus;
        thread.updatedAt = new Date().toISOString();
      });
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}

function reviewRouteSessionId(sessionId: string | undefined) {
  if (!sessionId) throw new ReviewThreadValidationError('Missing sessionId');
  return sessionId;
}

async function mutateForSession(
  projectPath: string,
  sessionId: string,
  expectedRevision: number | undefined,
  mutation: (store: ReviewThreadStore) => Promise<void> | void,
): Promise<ReviewThreadCollection> {
  const identity = await resolveSessionIdentity(sessionId, projectPath);
  const filePath = storePath(projectPath, identity.sessionUuid);
  return serializeStore(filePath, () => withStoreFileLock(projectPath, filePath, async (assertOwnership) => {
    const currentIdentity = await resolveSessionIdentity(sessionId, projectPath);
    if (currentIdentity.sessionUuid !== identity.sessionUuid) throw new ReviewThreadConflictError();
    const store = await readStore(projectPath, identity.sessionUuid);
    if (expectedRevision !== undefined && store.revision !== expectedRevision) throw new ReviewThreadConflictError();
    await mutation(store);
    store.revision++;
    validateStore(store);
    await writeStore(projectPath, identity.sessionUuid, store, assertOwnership);
    return collectionFromStore(projectPath, store);
  }));
}

type ReviewBaselineContent = { staged: boolean; content: string };

async function collectionFromStore(projectPath: string, store: ReviewThreadStore): Promise<ReviewThreadCollection> {
  if (!store.threads.length) return { revision: store.revision, threads: [] };
  const contents = new Map<string, ReviewBaselineContent[] | Error>();
  const status = await getGitStatus(projectPath);
  const filePaths = [...new Set(store.threads.map((thread) => thread.anchor.path))];
  for (let offset = 0; offset < filePaths.length; offset += MAX_FILE_READ_CONCURRENCY) {
    await Promise.all(filePaths.slice(offset, offset + MAX_FILE_READ_CONCURRENCY).map(async (filePath) => {
      const file = status.files.find((item) => item.path === filePath);
      const baselines = [
        ...(file?.unstaged ? [{ staged: false }] : []),
        ...(file?.staged ? [{ staged: true }] : []),
      ];
      if (!baselines.length) {
        contents.set(filePath, new Error('File is no longer staged, unstaged, or untracked'));
        return;
      }
      const results = await Promise.all(baselines.map(async ({ staged }) => {
        try {
          return { staged, content: await getReviewableFile(projectPath, filePath, staged, status) };
        } catch (error) {
          return error instanceof Error ? error : new Error('File is unavailable');
        }
      }));
      const available = results.filter((result): result is ReviewBaselineContent => !(result instanceof Error));
      contents.set(filePath, available.length ? available : results.find((result): result is Error => result instanceof Error) ?? new Error('File is unavailable'));
    }));
  }
  return {
    revision: store.revision,
    threads: store.threads.map((thread) => currentThread(thread, contents.get(thread.anchor.path))),
  };
}

function currentThread(thread: StoredReviewThread, contents: ReviewBaselineContent[] | Error | undefined): ReviewThread {
  if (contents instanceof Error || contents === undefined) {
    return { ...cloneThread(thread), outdated: true, outdatedReason: contents?.message || 'File is unavailable' };
  }
  const preferredBaseline = thread.anchor.staged === true;
  const orderedContents = [...contents].sort((left, right) => Number(right.staged === preferredBaseline) - Number(left.staged === preferredBaseline));
  for (const { staged, content } of orderedContents) {
    const anchor = projectReviewAnchor(thread.anchor, content, staged !== preferredBaseline);
    if (anchor) return { ...cloneThread(thread), anchor: { ...anchor, staged }, outdated: false };
  }
  return { ...cloneThread(thread), outdated: true, outdatedReason: 'Anchored text or its surrounding context changed' };
}

function projectReviewAnchor(anchor: ReviewAnchor, content: string, crossingBaseline: boolean): ReviewAnchor | undefined {
  const lines = fileLines(content);
  const selectedLines = anchor.selectedText.split('\n');
  const atOriginal = lines.slice(anchor.startLine - 1, anchor.endLine).join('\n') === anchor.selectedText;
  if (atOriginal && (!crossingBaseline || anchorContextMatches(anchor, lines, anchor.startLine - 1, selectedLines.length))) return { ...anchor };

  const matches: number[] = [];
  for (let index = 0; index + selectedLines.length <= lines.length; index++) {
    if (lines.slice(index, index + selectedLines.length).join('\n') === anchor.selectedText && anchorContextMatches(anchor, lines, index, selectedLines.length)) matches.push(index);
    if (matches.length > 1) break;
  }
  if (matches.length !== 1) return undefined;
  const startLine = matches[0] + 1;
  return { ...anchor, startLine, endLine: startLine + selectedLines.length - 1 };
}

function anchorContextMatches(anchor: ReviewAnchor, lines: string[], startIndex: number, selectedLineCount: number) {
  if (!anchor.contextBefore.length && !anchor.contextAfter.length) return startIndex === 0 && selectedLineCount === lines.length;
  const before = lines.slice(Math.max(0, startIndex - anchor.contextBefore.length), startIndex);
  const afterStart = startIndex + selectedLineCount;
  const after = lines.slice(afterStart, afterStart + anchor.contextAfter.length);
  return before.join('\n') === anchor.contextBefore.join('\n') && after.join('\n') === anchor.contextAfter.join('\n');
}

async function captureAnchor(
  projectPath: string,
  requestedPath: string,
  staged: boolean,
  startLine: number,
  endLine: number,
  expected?: Pick<ReviewAnchor, 'selectedText' | 'contextBefore' | 'contextAfter'>,
): Promise<ReviewAnchor> {
  const filePath = normalizeReviewPath(projectPath, requestedPath);
  if (endLine < startLine || endLine - startLine + 1 > MAX_SELECTED_LINES) throw new ReviewThreadValidationError('Invalid review line range');
  let content: string;
  try {
    content = await getReviewableFile(projectPath, filePath, staged);
  } catch (error) {
    throw new ReviewThreadValidationError(error instanceof Error ? error.message : 'Review file is unavailable');
  }
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new ReviewThreadValidationError('Review file is too large');
  const lines = fileLines(content);
  if (startLine > lines.length || endLine > lines.length) throw new ReviewThreadValidationError('Review line range is outside the file');
  const selectedText = lines.slice(startLine - 1, endLine).join('\n');
  if (!selectedText.length) throw new ReviewThreadValidationError('Review selection cannot be empty');
  const contextBefore = lines.slice(Math.max(0, startLine - 1 - CONTEXT_LINE_COUNT), startLine - 1);
  const contextAfter = lines.slice(endLine, endLine + CONTEXT_LINE_COUNT);
  if (expected && (selectedText !== expected.selectedText
    || contextBefore.join('\n') !== expected.contextBefore.join('\n')
    || contextAfter.join('\n') !== expected.contextAfter.join('\n'))) {
    throw new ReviewThreadConflictError('The selected lines or their surrounding context changed; select them again');
  }
  return { path: filePath, staged, startLine, endLine, selectedText, contextBefore, contextAfter };
}

function normalizeReviewPath(projectPath: string, requestedPath: string) {
  if (!requestedPath.trim() || path.isAbsolute(requestedPath)) throw new ReviewThreadValidationError('Invalid review file path');
  const resolved = resolveWithin(projectPath, requestedPath);
  const relative = path.relative(path.resolve(projectPath), resolved).split(path.sep).join('/');
  if (!relative || relative === '.') throw new ReviewThreadValidationError('Invalid review file path');
  return relative;
}

function fileLines(content: string) {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function latestHandledUserRevision(thread: Pick<ReviewThread, 'messages'>) {
  return thread.messages.reduce((latest, message) => Math.max(latest, message.author === 'agent' ? message.handlesUserRevision ?? 0 : 0), 0);
}

function latestActionableUserRevision(thread: Pick<ReviewThread, 'messages'>) {
  return thread.messages.reduce((latest, message) => Math.max(
    latest,
    message.author === 'user' && !message.deletedAt ? message.userRevision ?? 0 : 0,
  ), 0);
}

function storedThread(store: ReviewThreadStore, threadId: string) {
  const thread = store.threads.find((item) => item.id === threadId);
  if (!thread) throw new ReviewThreadNotFoundError();
  return thread;
}

function editableUserMessage(thread: StoredReviewThread, messageId: string) {
  const message = thread.messages.find((item) => item.id === messageId);
  if (!message) throw new ReviewThreadNotFoundError('Unknown review message');
  if (message.author !== 'user') throw new ReviewThreadPermissionError('Only user messages can be changed');
  if (message.deletedAt) throw new ReviewThreadValidationError('Deleted messages cannot be changed');
  return message;
}

function assertHandlesCurrentRevision(thread: StoredReviewThread, handlesUserRevision: number) {
  if (!Number.isSafeInteger(handlesUserRevision) || handlesUserRevision < 0 || handlesUserRevision !== thread.latestUserRevision) {
    throw new ReviewThreadConflictError();
  }
}

function agentMessage(body: string, handlesUserRevision: number, now = new Date().toISOString()): ReviewMessage {
  return { id: randomUUID(), author: 'agent', body, createdAt: now, handlesUserRevision };
}

function reviewAnchorContext(value: unknown, name: string) {
  if (!Array.isArray(value) || value.length > CONTEXT_LINE_COUNT || !value.every((line) => (
    typeof line === 'string' && !/[\r\n]/.test(line) && Buffer.byteLength(line) <= MAX_FILE_BYTES
  ))) throw new ReviewThreadValidationError(`Review anchor ${name} must be an array of lines`);
  return value as string[];
}

function reviewSelectedText(value: unknown) {
  if (typeof value !== 'string') throw new ReviewThreadValidationError('Review anchor selectedText must be a string');
  const selectedText = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!selectedText.length) throw new ReviewThreadValidationError('Review selection cannot be empty');
  if (Buffer.byteLength(selectedText) > MAX_FILE_BYTES) throw new ReviewThreadValidationError('Review selection is too large');
  return selectedText;
}

function reviewBody(value: unknown) {
  if (typeof value !== 'string') throw new ReviewThreadValidationError('Review message body must be a string');
  const body = value.trim();
  if (!body) throw new ReviewThreadValidationError('Review message body is required');
  if (body.length > MAX_BODY_LENGTH) throw new ReviewThreadValidationError('Review message body is too long');
  return body;
}

function expectedRevisionFrom(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ReviewThreadValidationError('Invalid expectedRevision');
  return value as number;
}

function lineNumber(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new ReviewThreadValidationError(`Invalid ${name}`);
  return value as number;
}

function storePath(projectPath: string, sessionUuid: string) {
  return resolveWithin(path.resolve(projectSessionDir(projectPath)), path.join(STORAGE_DIRECTORY, projectStoreDirectoryName(projectPath), storeFileName(sessionUuid)));
}

function projectStoreDirectoryName(projectPath: string) {
  return `project-${createHash('sha256').update(path.resolve(projectPath)).digest('hex')}`;
}

function storeFileName(sessionUuid: string) {
  if (typeof sessionUuid !== 'string' || !sessionUuid.length || sessionUuid.length > 256) throw new ReviewThreadValidationError('Invalid session UUID');
  return `session-${createHash('sha256').update(sessionUuid).digest('hex')}.json`;
}

function storeNameFromArtifact(fileName: string) {
  return fileName.match(/^\.?(session-[a-f0-9]{64}\.json)(?:\.lock(?:\.stale-[^.]+)?|\.\d+\.[^.]+\.tmp)?$/)?.[1];
}

async function deleteStoreArtifacts(directory: string, storeName: string) {
  const entries = await readdir(directory);
  await Promise.all(entries
    .filter((entry) => entry !== storeName && storeNameFromArtifact(entry) === storeName)
    .map((entry) => unlink(path.join(directory, entry)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    })));
}

async function readStore(projectPath: string, sessionUuid: string): Promise<ReviewThreadStore> {
  const filePath = storePath(projectPath, sessionUuid);
  await assertSafeStorageDirectory(projectPath, false);
  let content: string;
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STORE_BYTES) throw new ReviewThreadValidationError('Invalid review thread store');
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: STORE_VERSION, revision: 0, threads: [] };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new ReviewThreadValidationError('Invalid review thread store');
  }
  validateStore(value);
  return value;
}

async function writeStore(projectPath: string, sessionUuid: string, store: ReviewThreadStore, assertOwnership: () => Promise<void>) {
  const directory = await assertSafeStorageDirectory(projectPath, true);
  if (!directory) throw new Error('Could not create review thread storage');
  const filePath = storePath(projectPath, sessionUuid);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const content = `${JSON.stringify(store, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_STORE_BYTES) throw new ReviewThreadValidationError('Review thread store is too large');
  try {
    await writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await assertOwnership();
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function assertSafeStorageDirectory(projectPath: string, create: boolean): Promise<string | undefined> {
  const root = path.resolve(projectSessionDir(projectPath));
  const piWeb = resolveWithin(root, '.pi-web');
  const reviewThreads = resolveWithin(root, STORAGE_DIRECTORY);
  const directory = resolveWithin(root, path.join(STORAGE_DIRECTORY, projectStoreDirectoryName(projectPath)));
  if (!existsSync(root)) {
    if (!create) return undefined;
    await mkdir(root, { recursive: true });
  }
  for (const candidate of [piWeb, reviewThreads, directory]) {
    if (!existsSync(candidate)) {
      if (!create) return undefined;
      await mkdir(candidate).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    }
    const info = await lstat(candidate);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ReviewThreadValidationError('Unsafe review thread storage path');
  }
  const [realRoot, realDirectory] = await Promise.all([realpath(root), realpath(directory)]);
  if (realDirectory !== realRoot && !realDirectory.startsWith(`${realRoot}${path.sep}`)) throw new ReviewThreadValidationError('Unsafe review thread storage path');
  return directory;
}

async function withStoreFileLock<T>(projectPath: string, filePath: string, action: (assertOwnership: () => Promise<void>) => Promise<T>): Promise<T> {
  await assertSafeStorageDirectory(projectPath, true);
  const lockPath = `${filePath}.lock`;
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + STORE_LOCK_TIMEOUT_MS;
  let lockHandle: FileHandle | undefined;

  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ token, createdAt: new Date().toISOString() })}\n`, 'utf8');
        lockHandle = handle;
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lockInfo = await lstat(lockPath).catch(() => undefined);
      if (lockInfo && Date.now() - lockInfo.mtimeMs > STORE_LOCK_STALE_MS) {
        const staleClaimPath = `${lockPath}.stale-${token}`;
        try {
          await link(lockPath, staleClaimPath);
          const [claimedInfo, currentInfo] = await Promise.all([lstat(staleClaimPath), lstat(lockPath).catch(() => undefined)]);
          if (currentInfo && claimedInfo.dev === lockInfo.dev && claimedInfo.ino === lockInfo.ino
            && currentInfo.dev === lockInfo.dev && currentInfo.ino === lockInfo.ino
            && Date.now() - currentInfo.mtimeMs > STORE_LOCK_STALE_MS) {
            await unlink(lockPath).catch((unlinkError: NodeJS.ErrnoException) => {
              if (unlinkError.code !== 'ENOENT') throw unlinkError;
            });
          }
        } catch (claimError) {
          if (!['ENOENT', 'EEXIST'].includes((claimError as NodeJS.ErrnoException).code ?? '')) throw claimError;
        } finally {
          await unlink(staleClaimPath).catch(() => undefined);
        }
        continue;
      }
      if (Date.now() >= deadline) throw new ReviewThreadConflictError();
      await new Promise((resolve) => setTimeout(resolve, STORE_LOCK_RETRY_MS));
    }
  }

  if (!lockHandle) throw new ReviewThreadConflictError();
  const ownedHandle = lockHandle;
  let ownershipLost = false;
  const assertOwnership = async () => {
    if (ownershipLost) throw new ReviewThreadConflictError();
    try {
      const now = new Date();
      await ownedHandle.utimes(now, now);
      const [ownedInfo, currentInfo] = await Promise.all([ownedHandle.stat(), lstat(lockPath).catch(() => undefined)]);
      if (!currentInfo || ownedInfo.dev !== currentInfo.dev || ownedInfo.ino !== currentInfo.ino || ownedInfo.nlink !== 1) throw new ReviewThreadConflictError();
    } catch (error) {
      ownershipLost = true;
      if (error instanceof ReviewThreadConflictError) throw error;
      throw new ReviewThreadConflictError();
    }
  };
  const heartbeat = setInterval(() => {
    void assertOwnership().catch(() => undefined);
  }, Math.floor(STORE_LOCK_STALE_MS / 3));
  heartbeat.unref();

  try {
    return await action(assertOwnership);
  } finally {
    clearInterval(heartbeat);
    try {
      const [ownedInfo, currentInfo] = await Promise.all([ownedHandle.stat(), lstat(lockPath).catch(() => undefined)]);
      if (currentInfo && ownedInfo.dev === currentInfo.dev && ownedInfo.ino === currentInfo.ino && ownedInfo.nlink === 1) {
        await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    } finally {
      await ownedHandle.close().catch(() => undefined);
    }
  }
}

function validateStore(value: unknown): asserts value is ReviewThreadStore {
  if (!isRecord(value) || !hasOnlyKeys(value, ['version', 'revision', 'threads']) || value.version !== STORE_VERSION || !isNonNegativeInteger(value.revision) || !Array.isArray(value.threads) || value.threads.length > MAX_THREADS) {
    throw new ReviewThreadValidationError('Invalid review thread store');
  }
  const threadIds = new Set<string>();
  const messageIds = new Set<string>();
  for (const valueThread of value.threads) {
    if (!isRecord(valueThread) || !hasOnlyKeys(valueThread, ['id', 'anchor', 'status', 'latestUserRevision', 'createdAt', 'updatedAt', 'messages'])
      || !validId(valueThread.id) || threadIds.has(valueThread.id) || (valueThread.status !== 'open' && valueThread.status !== 'resolved')
      || !isNonNegativeInteger(valueThread.latestUserRevision) || !validDate(valueThread.createdAt) || !validDate(valueThread.updatedAt)
      || !Array.isArray(valueThread.messages) || valueThread.messages.length < 1 || valueThread.messages.length > MAX_MESSAGES_PER_THREAD) {
      throw new ReviewThreadValidationError('Invalid review thread store');
    }
    threadIds.add(valueThread.id);
    validateAnchor(valueThread.anchor);
    let maximumUserRevision = 0;
    for (const valueMessage of valueThread.messages) {
      if (!isRecord(valueMessage) || !hasOnlyKeys(valueMessage, ['id', 'author', 'body', 'createdAt', 'updatedAt', 'deletedAt', 'userRevision', 'handlesUserRevision'])
        || !validId(valueMessage.id) || messageIds.has(valueMessage.id) || (valueMessage.author !== 'user' && valueMessage.author !== 'agent')
        || typeof valueMessage.body !== 'string' || valueMessage.body.length > MAX_BODY_LENGTH || (!valueMessage.body && valueMessage.deletedAt === undefined)
        || !validDate(valueMessage.createdAt) || !optionalDate(valueMessage.updatedAt) || !optionalDate(valueMessage.deletedAt)) {
        throw new ReviewThreadValidationError('Invalid review thread store');
      }
      messageIds.add(valueMessage.id);
      if (valueMessage.author === 'user') {
        if (!isPositiveInteger(valueMessage.userRevision) || valueMessage.handlesUserRevision !== undefined) throw new ReviewThreadValidationError('Invalid review thread store');
        maximumUserRevision = Math.max(maximumUserRevision, valueMessage.userRevision);
      } else if (valueMessage.userRevision !== undefined || !isNonNegativeInteger(valueMessage.handlesUserRevision) || valueMessage.handlesUserRevision > valueThread.latestUserRevision) {
        throw new ReviewThreadValidationError('Invalid review thread store');
      }
    }
    if (maximumUserRevision > valueThread.latestUserRevision) throw new ReviewThreadValidationError('Invalid review thread store');
  }
}

function validateAnchor(value: unknown): asserts value is ReviewAnchor {
  if (!isRecord(value) || !hasOnlyKeys(value, ['path', 'staged', 'startLine', 'endLine', 'selectedText', 'contextBefore', 'contextAfter'])
    || typeof value.path !== 'string' || !value.path || path.isAbsolute(value.path) || value.path.includes('\\')
    || (value.staged !== undefined && typeof value.staged !== 'boolean')
    || !isPositiveInteger(value.startLine) || !isPositiveInteger(value.endLine) || value.endLine < value.startLine || value.endLine - value.startLine + 1 > MAX_SELECTED_LINES
    || typeof value.selectedText !== 'string' || !value.selectedText.length || Buffer.byteLength(value.selectedText) > MAX_FILE_BYTES
    || !validContext(value.contextBefore) || !validContext(value.contextAfter)) {
    throw new ReviewThreadValidationError('Invalid review thread store');
  }
}

function validContext(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= CONTEXT_LINE_COUNT && value.every((line) => typeof line === 'string' && line.length <= MAX_FILE_BYTES);
}

function cloneThread(thread: StoredReviewThread): StoredReviewThread {
  return {
    ...thread,
    anchor: { ...thread.anchor, contextBefore: [...thread.anchor.contextBefore], contextAfter: [...thread.anchor.contextAfter] },
    messages: thread.messages.map((message) => ({ ...message })),
  };
}

function serializeStore<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = storeQueues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(action);
  const tail = result.then(() => undefined, () => undefined);
  storeQueues.set(key, tail);
  void tail.finally(() => {
    if (storeQueues.get(key) === tail) storeQueues.delete(key);
  });
  return result;
}

function sendRouteError(reply: { code(statusCode: number): { send(payload: unknown): unknown } }, error: unknown) {
  const message = error instanceof Error ? error.message : 'Review thread request failed';
  if (error instanceof ReviewThreadConflictError) return reply.code(409).send({ error: message });
  if (error instanceof ReviewThreadPermissionError) return reply.code(403).send({ error: message });
  if (error instanceof ReviewThreadNotFoundError || message === 'Unknown session' || message === 'Session does not belong to this project' || message.startsWith('Unknown project:')) {
    return reply.code(404).send({ error: message });
  }
  if (message === 'Could not determine pi session UUID') return reply.code(404).send({ error: message });
  if (error instanceof ReviewThreadValidationError && !/^(Invalid review thread store|Unsafe review thread storage)/.test(message)) return reply.code(400).send({ error: message });
  return reply.code(500).send({ error: message });
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]) {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && allowed.filter((key) => !['staged', 'updatedAt', 'deletedAt', 'userRevision', 'handlesUserRevision'].includes(key)).every((key) => key in value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

function optionalDate(value: unknown): value is string | undefined {
  return value === undefined || validDate(value);
}
