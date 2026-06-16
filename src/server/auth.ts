import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { constantTimeEqual, randomToken } from './util.js';

const AUTH_COOKIE = 'pi_web_token';

export interface AuthState {
  enabled: boolean;
  password?: string;
  tokens: Set<string>;
}

export async function registerAuth(app: FastifyInstance, password?: string, basePath = '/') {
  const cookiePath = basePath === '/' ? '/' : basePath;
  const state: AuthState = {
    enabled: Boolean(password),
    password,
    tokens: new Set(),
  };

  await app.register(cookie, {
    secret: randomToken(),
  });

  app.decorate('authState', state);

  app.addHook('preHandler', async (request, reply) => {
    if (!state.enabled) return;
    if (isPublicPath(request)) return;

    const token = request.cookies[AUTH_COOKIE];
    if (token && state.tokens.has(token)) return;

    return reply.code(401).send({ error: 'Authentication required' });
  });

  app.get('/api/auth/status', async (request) => {
    const token = request.cookies[AUTH_COOKIE];
    return { authenticated: !state.enabled || Boolean(token && state.tokens.has(token)), required: state.enabled };
  });

  app.post<{ Body: { password?: string } }>('/api/auth/login', async (request, reply) => {
    if (!state.enabled) return { ok: true };

    if (!request.body?.password || !state.password || !constantTimeEqual(request.body.password, state.password)) {
      return reply.code(401).send({ error: 'Invalid password' });
    }

    const token = randomToken();
    state.tokens.add(token);
    reply.setCookie(AUTH_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: cookiePath,
    });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[AUTH_COOKIE];
    if (token) state.tokens.delete(token);
    reply.clearCookie(AUTH_COOKIE, { path: cookiePath });
    return { ok: true };
  });
}

function isPublicPath(request: FastifyRequest) {
  return request.url.startsWith('/api/auth/') || request.url === '/healthz';
}

declare module 'fastify' {
  interface FastifyInstance {
    authState: AuthState;
  }
}
