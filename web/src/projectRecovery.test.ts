import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { ProjectRegistry, registerProjectRoutes } from '../../src/server/projects.js';
import { registerSessionRoutes } from '../../src/server/sessions.js';
import { sessionIdFromPath } from '../../src/server/util.js';
import { withRequestTimeout } from './agentRefresh';
import { createProjectRecovery, isUnknownProjectResponse, recoveryProjectsFromWorkspaces, retainKnownRoots, type KnownProject } from './projectRecovery';

const git = promisify(execFile);

function transport(app: ReturnType<typeof Fastify>, calls: string[]) {
  return async <T>(url: string, init?: RequestInit): Promise<T> => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const response = await app.inject({ method: (init?.method ?? 'GET') as 'GET' | 'POST', url, payload: init?.body ? JSON.parse(init.body as string) : undefined });
    const body = response.json();
    if (response.statusCode >= 400) throw Object.assign(new Error(body.error), { status: response.statusCode });
    return body as T;
  };
}

test('fresh registry recovers the same session, with concurrent refreshes sharing one registration', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-web-recovery-'));
  const projectPath = path.join(root, 'project');
  const sessionDir = path.join(root, 'sessions');
  await Promise.all([mkdir(projectPath), mkdir(sessionDir)]);
  const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const file = path.join(sessionDir, 'test-session.jsonl');
  await writeFile(file, `${JSON.stringify({ type: 'session', id: randomUUID(), timestamp: new Date().toISOString(), cwd: projectPath, version: 3 })}\n`);
  const initial = new ProjectRegistry(projectPath);
  const project = initial.list()[0];
  const registry = new ProjectRegistry();
  const app = Fastify();
  await registerProjectRoutes(app, registry, { worktreeRoot: path.join(root, 'managed') });
  await registerSessionRoutes(app, registry);
  await app.ready();
  t.after(() => app.close());
  const calls: string[] = [];
  const request = transport(app, calls);
  const url = `/api/projects/${project.id}/session?sessionId=${encodeURIComponent(sessionIdFromPath(file))}`;
  await assert.rejects(request(url), /Unknown project/);
  const recovery = createProjectRecovery(request);
  recovery.remember({ id: project.id, path: projectPath, rootId: project.id, rootPath: projectPath });
  const [first, second] = await Promise.all([recovery.get<{ sessionId: string }>(url), recovery.get<{ sessionId: string }>(url)]);
  assert.deepEqual(first, second);
  assert.equal(registry.list().length, 1);
  assert.equal(calls.filter((call) => call === 'POST /api/projects').length, 1);
  assert.deepEqual(await recovery.get(url), first, 'the selected session can refresh again without reloading');
  await assert.rejects(recovery.get(`/api/projects/${project.id}/session?sessionId=missing`), /session/i);
  assert.equal(calls.filter((call) => call === 'POST /api/projects').length, 1);
});

test('worktree restoration stays hidden and forgotten targets cannot re-register', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-web-recovery-worktree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const worktree = path.join(root, 'worktree');
  await mkdir(repo);
  await git('git', ['init', '-q', repo]);
  await git('git', ['-C', repo, 'config', 'user.name', 'Test']);
  await git('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  await writeFile(path.join(repo, 'file.txt'), 'test\n');
  await git('git', ['-C', repo, 'add', 'file.txt']);
  await git('git', ['-C', repo, 'commit', '-qm', 'initial']);
  await git('git', ['-C', repo, 'worktree', 'add', '-qb', 'test-worktree', worktree]);
  const initial = new ProjectRegistry(repo);
  const rootProject = initial.list()[0];
  const initialApp = Fastify();
  await registerProjectRoutes(initialApp, initial, { worktreeRoot: path.join(root, 'managed') });
  const list = await initialApp.inject(`/api/projects/${rootProject.id}/workspaces`);
  const workspace = (list.json().workspaces as { id: string; path: string; local: boolean }[]).find((item) => !item.local)!;
  await initialApp.close();

  await t.test('workspace-list GET recovers its exact 400 unknown-project response after restart', async (t) => {
    const registry = new ProjectRegistry();
    const app = Fastify();
    await registerProjectRoutes(app, registry, { worktreeRoot: path.join(root, 'managed') });
    t.after(() => app.close());
    const calls: string[] = [];
    const request = transport(app, calls);
    const recovery = createProjectRecovery(request);
    recovery.remember({ id: rootProject.id, path: repo, rootId: rootProject.id, rootPath: repo });
    const url = `/api/projects/${rootProject.id}/workspaces`;
    await assert.rejects(request(url), { status: 400, message: `Unknown project: ${rootProject.id}` });
    calls.length = 0;
    const restored = await recovery.get<{ workspaces: { id: string }[] }>(url);
    assert.deepEqual(new Set(restored.workspaces.map(({ id }) => id)), new Set([rootProject.id, workspace.id]));
    assert.deepEqual(calls, [`GET ${url}`, `GET /api/projects/${rootProject.id}`, 'POST /api/projects', `GET ${url}`]);
    assert.deepEqual(registry.list().map(({ id }) => id), [rootProject.id], 'the worktree remains hidden');
    assert.deepEqual(await recovery.get(`${url}?refresh=true`), restored);
    assert.equal(calls.filter((call) => call === 'POST /api/projects').length, 1);
  });

  const registry = new ProjectRegistry();
  const app = Fastify();
  await registerProjectRoutes(app, registry, { worktreeRoot: path.join(root, 'managed') });
  await app.ready();
  t.after(() => app.close());
  const calls: string[] = [];
  const recovery = createProjectRecovery(transport(app, calls));
  const known: KnownProject = { id: workspace.id, path: workspace.path, rootId: rootProject.id, rootPath: repo };
  recovery.remember(known);
  const url = `/api/projects/${workspace.id}`;
  assert.equal((await recovery.get<{ project: { id: string } }>(url)).project.id, workspace.id);
  assert.deepEqual(registry.list().map(({ id }) => id), [rootProject.id]);
  assert.equal(calls.filter((call) => call === 'POST /api/projects').length, 1);
  recovery.forget([workspace.id]);
  registry.remove(workspace.id);
  await assert.rejects(recovery.get(url), /Unknown project/);
  const previousCalls = calls.length;
  await assert.rejects(recovery.beforeConnect(workspace.id), /Unknown recovery target/);
  assert.equal(calls.length, previousCalls, 'forgotten socket target does not probe or restore');
  assert.equal(calls.filter((call) => call === 'POST /api/projects').length, 1);

  // The same worktree can also be an independently open root. Listing A after
  // restart first registers B as hidden; reconnecting B must promote it.
  const visibleRegistry = new ProjectRegistry();
  const visibleApp = Fastify();
  await registerProjectRoutes(visibleApp, visibleRegistry, { worktreeRoot: path.join(root, 'managed') });
  await visibleApp.ready();
  t.after(() => visibleApp.close());
  const visibleCalls: string[] = [];
  const visibleRecovery = createProjectRecovery(transport(visibleApp, visibleCalls));
  for (const project of recoveryProjectsFromWorkspaces(
    [{ id: workspace.id, path: workspace.path }, { id: rootProject.id, path: repo }],
    { [rootProject.id]: [{ ...workspace, rootProjectId: rootProject.id }] },
  )) visibleRecovery.remember(project);
  await visibleRecovery.beforeConnect(rootProject.id);
  await visibleApp.inject(`/api/projects/${rootProject.id}/workspaces`);
  assert.deepEqual(visibleRegistry.list().map(({ id }) => id), [rootProject.id]);
  await visibleRecovery.beforeConnect(workspace.id);
  assert.deepEqual(new Set(visibleRegistry.list().map(({ id }) => id)), new Set([rootProject.id, workspace.id]));
  assert.equal(visibleCalls.filter((call) => call === 'POST /api/projects').length, 2);
  const resume = await visibleRecovery.pause(visibleRecovery.idsForRoot(rootProject.id));
  await visibleApp.inject({ method: 'DELETE', url: `/api/projects/${rootProject.id}` });
  visibleRecovery.closeRoot(rootProject.id);
  resume();
  await visibleRecovery.beforeConnect(workspace.id);
  assert.deepEqual(visibleRegistry.list().map(({ id }) => id), [workspace.id]);
});

test('a restart retains other open roots while staggered socket probes restore them', async () => {
  const cached = new Map([['a', { id: 'a', path: '/tmp/a' }], ['b', { id: 'b', path: '/tmp/b' }]]);
  const registered = new Set<string>();
  const recovery = createProjectRecovery(async <T>(url: string, init?: RequestInit): Promise<T> => {
    if (url === '/api/projects' && init?.method === 'POST') {
      const { path: projectPath } = JSON.parse(init.body as string) as { path: string };
      registered.add(projectPath.slice(-1));
      return { project: { id: projectPath.slice(-1) } } as T;
    }
    const id = url.split('/')[3];
    if (!registered.has(id)) throw Object.assign(new Error(`Unknown project: ${id}`), { status: 404 });
    return { project: { id } } as T;
  });
  for (const { id, path: projectPath } of cached.values()) recovery.remember({ id, path: projectPath, rootId: id, rootPath: projectPath });
  await recovery.beforeConnect('a');
  assert.deepEqual(retainKnownRoots([{ id: 'a', path: '/tmp/a' }], cached, recovery.isForgotten).map(({ id }) => id), ['a', 'b']);
  await recovery.beforeConnect('b');
  assert.deepEqual([...registered], ['a', 'b']);
});

test('closing and reopening a root restores its prior child but not a deleted workspace', async () => {
  const root = { id: 'root', path: '/tmp/root' };
  const child = { id: 'child', path: '/tmp/child', rootProjectId: 'root' };
  const late = { id: 'late', path: '/tmp/late', rootProjectId: 'root' };
  const deleted = { id: 'deleted', path: '/tmp/deleted', rootProjectId: 'root' };
  let rootRegistered = false;
  const registeredChildren = new Set<string>();
  let posts = 0;
  const recovery = createProjectRecovery(async <T>(url: string, init?: RequestInit): Promise<T> => {
    if (url === '/api/projects' && init?.method === 'POST') {
      rootRegistered = true;
      posts++;
      return { project: { id: 'root' } } as T;
    }
    if (url === '/api/projects/root/workspaces' && rootRegistered) {
      registeredChildren.add(child.id);
      registeredChildren.add(late.id);
      return { workspaces: [child, late] } as T;
    }
    const id = url.split('/')[3];
    if (rootRegistered && (id === root.id || registeredChildren.has(id))) return { project: { id } } as T;
    throw Object.assign(new Error(`Unknown project: ${id}`), { status: 404 });
  });
  const entries = recoveryProjectsFromWorkspaces([root], { root: [child, deleted] });
  for (const project of entries) recovery.remember(project);
  recovery.forget([deleted.id]); // Explicit workspace deletion stays forgotten.
  const resume = await recovery.pause(recovery.idsForRoot(root.id));
  recovery.closeRoot(root.id);
  resume();
  rootRegistered = false;
  registeredChildren.clear();
  await assert.rejects(recovery.beforeConnect(child.id), /Unknown recovery target/);
  recovery.remember({ id: late.id, path: late.path, rootId: root.id, rootPath: root.path });
  await assert.rejects(recovery.beforeConnect(late.id), /Unknown recovery target/);
  recovery.remember(entries[0], true); // The app reopens only the root explicitly.
  for (const project of recoveryProjectsFromWorkspaces([root], { root: [child, deleted] })) recovery.remember(project);
  await recovery.beforeConnect(child.id);
  recovery.remember({ id: late.id, path: late.path, rootId: root.id, rootPath: root.path });
  await recovery.beforeConnect(late.id);
  assert.equal(posts, 1);
  assert.equal(recovery.isForgotten(child.id), false);
  assert.equal(recovery.isForgotten(deleted.id), true);
  await assert.rejects(recovery.beforeConnect(deleted.id), /Unknown recovery target/);
});

test('visible worktree root stays independent when listed before its parent root', async () => {
  const rootB = { id: 'b', path: '/tmp/worktree-b' };
  const rootA = { id: 'a', path: '/tmp/root-a' };
  const workspaces = { a: [{ id: 'b', path: rootB.path, rootProjectId: 'a' }] };
  const cached = new Map([['b', rootB], ['a', rootA]]);
  const registered = new Set(['b', 'a']);
  const recovery = createProjectRecovery(async <T>(url: string): Promise<T> => {
    const id = url.split('/')[3];
    if (registered.has(id)) return { project: { id } } as T;
    throw Object.assign(new Error(`Unknown project: ${id}`), { status: 404 });
  });
  for (const project of recoveryProjectsFromWorkspaces([rootB, rootA], workspaces)) recovery.remember(project);
  assert.deepEqual(recovery.idsForRoot('a'), ['a']);
  const resume = await recovery.pause(recovery.idsForRoot('a'));
  registered.delete('a');
  recovery.closeRoot('a');
  cached.delete('a');
  resume();
  for (const project of recoveryProjectsFromWorkspaces([rootB], workspaces)) recovery.remember(project);
  assert.deepEqual(retainKnownRoots([rootB], cached, recovery.isForgotten), [rootB]);
  assert.equal(recovery.isForgotten('b'), false);
  await recovery.beforeConnect('b');
  assert.equal((await recovery.get<{ project: { id: string } }>('/api/projects/b')).project.id, 'b');
});

test('closing a visible worktree root still permits its workspace under another open root', async () => {
  const rootA = { id: 'a', path: '/tmp/root-a' };
  const rootB = { id: 'b', path: '/tmp/worktree-b' };
  const workspaces = { a: [{ ...rootB, rootProjectId: 'a' }] };
  let release!: () => void;
  const probe = new Promise<void>((resolve) => { release = resolve; });
  const recovery = createProjectRecovery(async <T>(url: string, init?: RequestInit): Promise<T> => {
    assert.notEqual(init?.method, 'POST', 'the closed root must not be reopened as visible');
    await probe;
    return { project: { id: url.split('/')[3], hidden: url.endsWith('/b') } } as T;
  });
  for (const project of recoveryProjectsFromWorkspaces([rootB, rootA], workspaces)) recovery.remember(project);
  const staleProbe = assert.rejects(recovery.beforeConnect('b'), /Recovery canceled/);
  recovery.closeRoot('b');
  for (const project of recoveryProjectsFromWorkspaces([rootA], workspaces)) recovery.remember(project);
  assert.equal(recovery.isForgotten('b'), true, 'B stays closed as an independent root');
  assert.deepEqual(new Set(recovery.idsForRoot('a')), new Set(['a', 'b']));
  release();
  await staleProbe;
  await recovery.beforeConnect('b');
});

test('a forgotten root blocks a late child until explicit reopen', async () => {
  let posts = 0;
  const recovery = createProjectRecovery(async <T>(url: string, init?: RequestInit): Promise<T> => {
    if (url === '/api/projects' && init?.method === 'POST') { posts++; return { project: { id: 'root' } } as T; }
    throw Object.assign(new Error(`Unknown project: ${url.split('/')[3]}`), { status: 404 });
  });
  const root = { id: 'root', path: '/tmp/root', rootId: 'root', rootPath: '/tmp/root' };
  const child = { id: 'child', path: '/tmp/child', rootId: 'root', rootPath: '/tmp/root' };
  recovery.remember(root);
  recovery.remember(child);
  recovery.forget(['root']);
  await assert.rejects(recovery.get('/api/projects/child/session'), /Unknown project: child/);
  recovery.remember(child);
  await assert.rejects(recovery.get('/api/projects/child/session'), /Unknown project: child/);
  await assert.rejects(recovery.beforeConnect('child'), /Recovery canceled/);
  assert.equal(posts, 0);
  recovery.remember(root, true);
  recovery.remember(child, true);
  assert.equal(recovery.isForgotten('root'), false);
  assert.equal(recovery.isForgotten('child'), false);
});

test('a disposed socket probe cannot register a root after its first GET', async () => {
  let release!: () => void;
  const firstProbe = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let posts = 0;
  const recovery = createProjectRecovery(async <T>(url: string, init?: RequestInit): Promise<T> => {
    if (init?.method === 'POST') { posts++; return { project: { id: 'p' } } as T; }
    if (url === '/api/projects/p') { started(); await firstProbe; }
    throw Object.assign(new Error('Unknown project: p'), { status: 404 });
  });
  recovery.remember({ id: 'p', path: '/tmp/p', rootId: 'p', rootPath: '/tmp/p' });
  const controller = new AbortController();
  const pending = assert.rejects(recovery.beforeConnect('p', controller.signal));
  await entered;
  controller.abort();
  release();
  await pending;
  assert.equal(posts, 0);
});

test('a close waits for pending restoration and prevents a late registration', async () => {
  let finishProbe!: () => void;
  const probe = new Promise<void>((resolve) => { finishProbe = resolve; });
  let posts = 0;
  let probeStarted!: () => void;
  const started = new Promise<void>((resolve) => { probeStarted = resolve; });
  const recovery = createProjectRecovery(async <T>(url: string, init?: RequestInit): Promise<T> => {
    if (init?.method === 'POST') { posts++; return { project: { id: 'p' } } as T; }
    if (url === '/api/projects/p') { probeStarted(); await probe; }
    throw Object.assign(new Error('Unknown project: p'), { status: 404 });
  });
  recovery.remember({ id: 'p', path: '/tmp/test-project', rootId: 'p', rootPath: '/tmp/test-project' });
  const refresh = assert.rejects(recovery.get('/api/projects/p/session'), /Recovery canceled/);
  await started;
  const paused = recovery.pause(['p']);
  finishProbe();
  const resume = await paused;
  recovery.forget(['p']);
  resume();
  await refresh;
  await assert.rejects(recovery.beforeConnect('p'), /Unknown recovery target/);
  assert.equal(posts, 0);
});

test('session-not-found guards retain selection for any unknown-project ID', () => {
  assert.equal(isUnknownProjectResponse(Object.assign(new Error('Unknown project: root'), { status: 404 })), true);
  assert.equal(isUnknownProjectResponse(Object.assign(new Error('Unknown project: workspace'), { status: 404 })), true);
  assert.equal(isUnknownProjectResponse(Object.assign(new Error('Unknown session'), { status: 404 })), false);
});

test('workspace-list 400 recovery does not accept unrelated errors, routes, or mutations', async (t) => {
  const cases: { url: string; message?: string; status?: number; method?: string }[] = [
    { url: '/api/projects/p/workspaces', message: 'Invalid workspace request' },
    { url: '/api/projects/p/workspaces', message: 'Unknown project: other' },
    { url: '/api/projects/p/session' },
    { url: '/api/projects/p/workspace-options' },
    { url: '/api/projects/p/workspaces/child/deletion-scope' },
    { url: '/api/projects/p/workspaces-extra' },
    { url: '/api/projects/other/workspaces', message: 'Unknown project: other' },
    ...[401, 403, 409, 500].map((status) => ({ url: '/api/projects/p/workspaces', status })),
    ...['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((method) => ({ url: '/api/projects/p/workspaces', method })),
  ];
  for (const { url, message = 'Unknown project: p', status = 400, method = 'GET' } of cases) {
    await t.test(`${method} ${url}: ${status} ${message}`, async () => {
      const error = Object.assign(new Error(message), { status });
      let calls = 0;
      const recovery = createProjectRecovery(async () => { calls++; throw error; });
      recovery.remember({ id: 'p', path: '/tmp/p', rootId: 'p', rootPath: '/tmp/p' });
      await assert.rejects(recovery.get(url, { method }), (actual) => actual === error);
      assert.equal(calls, 1, 'no probe, registration, or replay occurs');
    });
  }
});

test('workspace-list recovery with a query string retries only once', async () => {
  const url = '/api/projects/p/workspaces?refresh=true';
  const error = Object.assign(new Error('Unknown project: p'), { status: 400 });
  const calls: string[] = [];
  const recovery = createProjectRecovery(async <T>(target: string): Promise<T> => {
    calls.push(target);
    if (target === '/api/projects/p') return { project: { id: 'p' } } as T;
    throw error;
  });
  recovery.remember({ id: 'p', path: '/tmp/p', rootId: 'p', rootPath: '/tmp/p' });
  await assert.rejects(recovery.get(url), (actual) => actual === error);
  assert.deepEqual(calls, [url, '/api/projects/p', url]);
});

test('only an exact unknown-project GET recovers; a stalled socket probe can time out and retry', async () => {
  const known = { id: 'p', path: '/tmp/no-user-data', rootId: 'p', rootPath: '/tmp/no-user-data' };
  let calls = 0;
  const auth = createProjectRecovery(async () => { calls++; throw Object.assign(new Error('Forbidden'), { status: 403 }); });
  auth.remember(known);
  await assert.rejects(auth.get('/api/projects/p/session'), /Forbidden/);
  assert.equal(calls, 1);
  const missing = createProjectRecovery(async () => { calls++; throw Object.assign(new Error('Unknown session'), { status: 404 }); });
  missing.remember(known);
  await assert.rejects(missing.get('/api/projects/p/session'), /Unknown session/);
  assert.equal(calls, 2);
  await assert.rejects(missing.get('/api/projects/p/session', { method: 'DELETE' }), /Unknown session/);
  assert.equal(calls, 3);
  const conflict = createProjectRecovery(async () => { calls++; throw Object.assign(new Error('Session is being deleted'), { status: 409 }); });
  conflict.remember(known);
  await assert.rejects(conflict.get('/api/projects/p/session'), /Session is being deleted/);
  assert.equal(calls, 4);
  let probes = 0;
  const stalled = createProjectRecovery(<T>(_url: string, init?: RequestInit) => withRequestTimeout<T>(() => {
    probes++;
    return probes === 1 ? new Promise<T>(() => {}) : Promise.resolve({ project: known } as T);
  }, init?.signal, 5));
  stalled.remember(known);
  await assert.rejects(stalled.beforeConnect('p'));
  await stalled.beforeConnect('p');
  assert.equal(probes, 2);
});
