import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

const apiPort = Number(process.env.PI_WEB_PORT ?? 43110);
const appBasePath = normalizeBasePath(process.env.PI_WEB_BASE_PATH ?? '/');
const devBase = appBasePath === '/' ? '/' : `${appBasePath}/`;
const apiProxyPath = appBasePath === '/' ? '/api' : `${appBasePath}/api`;
const wsProxyPath = appBasePath === '/' ? '/ws' : `${appBasePath}/ws`;
const allowedHosts = uniqueHosts(['.ts.net', ...parseAllowedHosts(process.env.PI_WEB_ALLOWED_HOSTS)]);

export default defineConfig(({ command }) => ({
  root: 'web',
  base: command === 'build' ? './' : devBase,
  plugins: [solid()],
  server: {
    port: 5173,
    allowedHosts,
    proxy: {
      [apiProxyPath]: `http://127.0.0.1:${apiPort}`,
      [wsProxyPath]: {
        target: `ws://127.0.0.1:${apiPort}`,
        ws: true,
      },
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
}));

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

function parseAllowedHosts(value: string | undefined) {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
}

function uniqueHosts(hosts: string[]) {
  return [...new Set(hosts)];
}
