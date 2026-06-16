declare global {
  interface Window {
    __PI_WEB_BASE_PATH__?: string;
  }
}

const bundledBaseUrl = import.meta.env.BASE_URL;

export const APP_BASE_PATH = resolveAppBasePath();

export function appUrl(path: string) {
  if (isAbsoluteUrl(path) || path.startsWith('#')) return path;
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return APP_BASE_PATH === '/' ? suffix : `${APP_BASE_PATH}${suffix}`;
}

export function appWebSocketUrl(path: string) {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${appUrl(path)}`;
}

function resolveAppBasePath() {
  if (bundledBaseUrl && bundledBaseUrl !== '/' && bundledBaseUrl !== './') {
    return normalizeBasePath(bundledBaseUrl);
  }

  return normalizeBasePath(window.__PI_WEB_BASE_PATH__ || bundledBaseUrl || '/');
}

function normalizeBasePath(value: string) {
  let next = value.trim();

  try {
    next = new URL(next, 'http://pi-web.local').pathname;
  } catch {
    // Keep the original value and normalize it below.
  }

  next = next.replace(/\/+$/, '');
  if (!next || next === '.') return '/';
  return next.startsWith('/') ? next : `/${next}`;
}

function isAbsoluteUrl(value: string) {
  return /^[a-z][a-z\d+.-]*:/i.test(value);
}

export {};
