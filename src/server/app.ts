import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAuth } from './auth.js';
import { registerFileRoutes } from './files.js';
import { registerGitRoutes } from './git.js';
import { PiBridge, registerPiRoutes } from './piBridge.js';
import { ProjectRegistry, registerProjectRoutes } from './projects.js';
import { registerSessionRoutes } from './sessions.js';
import { registerSettingsRoutes } from './settings.js';
import { registerTerminalRoutes } from './terminal.js';
import type { ServerOptions } from './types.js';

export async function buildApp(options: ServerOptions) {
  const app = Fastify({ logger: true });
  const registry = new ProjectRegistry(options.workspace);
  const bridge = new PiBridge();

  await app.register(websocket);

  app.get('/healthz', async () => ({ ok: true }));

  await registerAuth(app, options.password);
  await registerProjectRoutes(app, registry);
  await registerSessionRoutes(app, registry, bridge);
  await registerSettingsRoutes(app, registry);
  await registerFileRoutes(app, registry);
  await registerGitRoutes(app, registry);
  await registerTerminalRoutes(app, registry);
  await registerPiRoutes(app, registry, bridge);

  if (!options.dev) {
    const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
    if (existsSync(webRoot)) {
      await app.register(fastifyStatic, {
        root: webRoot,
        wildcard: false,
      });
      app.setNotFoundHandler(async (request, reply) => {
        if (request.url.startsWith('/api/') || request.url.startsWith('/ws/')) {
          return reply.code(404).send({ error: 'Not found' });
        }
        return reply.sendFile('index.html');
      });
    } else {
      app.log.warn(`Web assets not found at ${webRoot}; run npm run build before npm start, or use npm run dev.`);
    }
  }

  return app;
}
