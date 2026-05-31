import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

export function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const keyValue = arg.slice(2);
    const equalsIndex = keyValue.indexOf('=');
    if (equalsIndex !== -1) {
      out[keyValue.slice(0, equalsIndex)] = keyValue.slice(equalsIndex + 1);
      continue;
    }
    const key = keyValue;
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

export function projectId(projectPath: string) {
  return createHash('sha256').update(path.resolve(projectPath)).digest('base64url').slice(0, 16);
}

export function safeProjectName(projectPath: string) {
  return path.basename(projectPath) || projectPath;
}

export function assertDirectory(projectPath: string) {
  const resolved = path.resolve(projectPath);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`Workspace is not a directory: ${resolved}`);
  }
  return resolved;
}

export function resolveWithin(root: string, requested = '.') {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, requested);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Path escapes workspace');
  }
  return resolved;
}

export function sessionDirForCwd(cwd: string) {
  const normalized = path.resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-');
  return path.join(getAgentDir(), 'sessions', `--${normalized}--`);
}

export function sessionIdFromPath(filePath: string) {
  return Buffer.from(filePath).toString('base64url');
}

export function pathFromSessionId(id: string) {
  return Buffer.from(id, 'base64url').toString('utf8');
}

export function constantTimeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function isLocalHost(host: string) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
