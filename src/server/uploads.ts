import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { resolveWithin } from './util.js';

const UPLOADS_ROOT = path.join('.pi-web', 'uploads');
const PROJECT_UPLOAD_DIR = 'project';
const SESSION_UPLOAD_DIR = 'sessions';
const SESSION_UPLOAD_DIR_PREFIX = 'session-';
const RESERVED_UPLOAD_DIRS = new Set([PROJECT_UPLOAD_DIR, SESSION_UPLOAD_DIR]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PATH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/;

export function projectUploadRoot(projectPath: string) {
  return resolveWithin(projectPath, path.join(UPLOADS_ROOT, PROJECT_UPLOAD_DIR));
}

export function sessionUploadRoot(projectPath: string, sessionId: string) {
  return resolveWithin(projectPath, path.join(UPLOADS_ROOT, SESSION_UPLOAD_DIR, sessionUploadDirName(sessionId)));
}

export async function deleteSessionUploads(projectPath: string, sessionIds: Iterable<string | undefined>) {
  const roots = new Set<string>();
  for (const sessionId of sessionIds) {
    if (!sessionId) continue;
    roots.add(sessionUploadRoot(projectPath, sessionId));
    for (const previousDir of previousSessionUploadDirNames(sessionId)) roots.add(resolveWithin(projectPath, path.join(UPLOADS_ROOT, SESSION_UPLOAD_DIR, previousDir)));
    const legacyDir = legacySessionUploadDirName(sessionId);
    if (legacyDir) roots.add(resolveWithin(projectPath, path.join(UPLOADS_ROOT, legacyDir)));
  }
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
}

export async function cleanupOrphanedSessionUploads(projectPath: string, validSessionIds: Iterable<string | undefined>) {
  const validSessionDirs = new Set<string>();
  const validLegacyDirs = new Set<string>();
  for (const sessionId of validSessionIds) {
    if (!sessionId) continue;
    validSessionDirs.add(sessionUploadDirName(sessionId));
    for (const previousDir of previousSessionUploadDirNames(sessionId)) validSessionDirs.add(previousDir);
    const legacyDir = legacySessionUploadDirName(sessionId);
    if (legacyDir) validLegacyDirs.add(legacyDir);
  }

  await removeUnknownChildDirs(resolveWithin(projectPath, path.join(UPLOADS_ROOT, SESSION_UPLOAD_DIR)), validSessionDirs);

  const root = resolveWithin(projectPath, UPLOADS_ROOT);
  if (!existsSync(root)) return;
  const entries = await readdir(root, { withFileTypes: true });
  await Promise.all(entries.map((entry) => {
    if (!entry.isDirectory() || RESERVED_UPLOAD_DIRS.has(entry.name) || validLegacyDirs.has(entry.name) || !looksLikeLegacySessionUploadDir(entry.name)) return undefined;
    return rm(path.join(root, entry.name), { recursive: true, force: true });
  }));
}

function sessionUploadDirName(sessionId: string) {
  return `${SESSION_UPLOAD_DIR_PREFIX}${createHash('sha256').update(sessionId).digest('base64url')}`;
}

function previousSessionUploadDirNames(sessionId: string) {
  return [
    safeUploadPathSegment(encodeURIComponent(sessionId)),
    safeUploadPathSegment(`${SESSION_UPLOAD_DIR_PREFIX}${Buffer.from(sessionId).toString('base64url')}`),
  ].filter((name): name is string => Boolean(name));
}

function legacySessionUploadDirName(sessionId: string) {
  const name = safeUploadPathSegment(path.basename(sessionId));
  return name && looksLikeLegacySessionUploadDir(name) ? name : undefined;
}

function safeUploadPathSegment(name: string) {
  if (!name || name.length > 255 || name === '.' || name === '..' || RESERVED_UPLOAD_DIRS.has(name)) return undefined;
  if (name.includes('/') || name.includes('\\') || path.basename(name) !== name) return undefined;
  return name;
}

function looksLikeLegacySessionUploadDir(name: string) {
  return UUID_PATTERN.test(name) || PATH_TOKEN_PATTERN.test(name);
}

async function removeUnknownChildDirs(root: string, validDirNames: Set<string>) {
  if (!existsSync(root)) return;
  const entries = await readdir(root, { withFileTypes: true });
  await Promise.all(entries.map((entry) => {
    if (!entry.isDirectory() || validDirNames.has(entry.name)) return undefined;
    return rm(path.join(root, entry.name), { recursive: true, force: true });
  }));
}
