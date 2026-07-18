import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAuth } from './auth.js';
import { registerFileRoutes } from './files.js';
import { registerGitRoutes } from './git.js';
import { PiBridge, registerPiRoutes } from './piBridge.js';
import { ProjectRegistry, registerProjectRoutes } from './projects.js';
import { registerReviewThreadRoutes } from './reviewThreads.js';
import { registerSessionRoutes } from './sessions.js';
import { registerSettingsRoutes } from './settings.js';
import { registerTerminalRoutes } from './terminal.js';
import type { ServerOptions } from './types.js';
import { basePathWithTrailingSlash } from './util.js';

export async function buildApp(options: ServerOptions) {
  const logMode = options.logMode ?? 'quiet';
  const app = Fastify({
    logger: logMode === 'silent'
      ? false
      : { level: logMode === 'debug' ? 'debug' : logMode === 'verbose' ? 'info' : 'warn' },
    rewriteUrl: options.basePath === '/' ? undefined : (request) => stripBasePathFromUrl(request.url ?? '/', options.basePath),
  });
  const registry = new ProjectRegistry(options.workspace);
  const bridge = new PiBridge();
  let closing = false;
  let bridgeDisposal: Promise<void> | undefined;
  app.addHook('preClose', async () => {
    closing = true;
    const configuredTimeout = Number(process.env.PI_WEB_SHUTDOWN_TIMEOUT_MS);
    bridgeDisposal = bridge.dispose({ timeoutMs: Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 10_000 });
  });

  await app.register(websocket);

  app.get('/healthz', async () => ({ ok: true }));

  await registerAuth(app, options.password, options.basePath);
  await registerProjectRoutes(app, registry);
  await registerSessionRoutes(app, registry, bridge);
  await registerReviewThreadRoutes(app, registry);
  await registerSettingsRoutes(app, registry);
  await registerFileRoutes(app, registry);
  await registerGitRoutes(app, registry);
  await registerTerminalRoutes(app, registry, { isClosing: () => closing });
  await registerPiRoutes(app, registry, bridge);

  if (!options.dev) {
    const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
    const indexPath = path.join(webRoot, 'index.html');
    if (existsSync(webRoot) && existsSync(indexPath)) {
      const indexHtml = renderIndexHtml(await readFile(indexPath, 'utf8'), options.basePath);
      await app.register(fastifyStatic, {
        root: webRoot,
        wildcard: false,
        index: false,
        globIgnore: ['index.html'],
      });
      app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(indexHtml));
      app.get('/index.html', async (_request, reply) => reply.type('text/html; charset=utf-8').send(indexHtml));
      app.setNotFoundHandler(async (request, reply) => {
        if (request.url.startsWith('/api/') || request.url.startsWith('/ws/')) {
          return reply.code(404).send({ error: 'Not found' });
        }
        return reply.type('text/html; charset=utf-8').send(indexHtml);
      });
    } else {
      console.warn(`Warning: web assets not found at ${webRoot}; run npm run build before npm start, or use npm run dev.`);
    }
  }

  app.addHook('preClose', async () => {
    await bridgeDisposal;
  });
  return app;
}

function stripBasePathFromUrl(url: string, basePath: string) {
  if (url === basePath) return '/';
  if (url.startsWith(`${basePath}/`)) return url.slice(basePath.length) || '/';
  if (url.startsWith(`${basePath}?`)) return `/${url.slice(basePath.length)}`;
  return url;
}

function renderIndexHtml(indexHtml: string, basePath: string) {
  const baseHref = basePathWithTrailingSlash(basePath);

  return indexHtml
    .replace('<head>', `<head>\n    <base href="${escapeHtmlAttribute(baseHref)}" data-pi-web-base />`)
    .replace(/href="(?:\.\/|\/|%BASE_URL%)favicon\.svg"/, `href="${escapeHtmlAttribute(`${baseHref}favicon.svg`)}"`)
    .replace("window.__PI_WEB_BASE_PATH__ = '/';", `window.__PI_WEB_BASE_PATH__ = ${JSON.stringify(basePath)};`);
}

function escapeHtmlAttribute(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
