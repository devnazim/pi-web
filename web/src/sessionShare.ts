export const PROJECT_QUERY_KEY = 'project';
export const WORKSPACE_QUERY_KEY = 'workspace';
export const SESSION_QUERY_KEY = 'session';

type SessionShareTarget = {
  projectPath?: string;
  workspacePath?: string;
  sessionId?: string;
};

export function buildSessionShareUrl(currentHref: string, target: SessionShareTarget) {
  const url = new URL(currentHref);
  if (target.projectPath) url.searchParams.set(PROJECT_QUERY_KEY, encodeProjectPath(target.projectPath));
  setSearchParam(url, WORKSPACE_QUERY_KEY, target.projectPath && target.workspacePath && target.workspacePath !== target.projectPath ? encodeProjectPath(target.workspacePath) : undefined);
  setSearchParam(url, SESSION_QUERY_KEY, target.sessionId);
  return `${url.origin}${url.pathname}${url.search}${url.hash}`;
}

export function encodeProjectPath(projectPath: string) {
  const bytes = new TextEncoder().encode(projectPath);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeProjectPath(value: string) {
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    const projectPath = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
    return looksLikeProjectPath(projectPath) ? projectPath : undefined;
  } catch {
    return undefined;
  }
}

function setSearchParam(url: URL, key: string, value: string | undefined) {
  if (value) url.searchParams.set(key, value);
  else url.searchParams.delete(key);
}

function looksLikeProjectPath(projectPath: string) {
  return projectPath.startsWith('/') || projectPath.startsWith('~') || /^[A-Za-z]:[\\/]/.test(projectPath);
}
