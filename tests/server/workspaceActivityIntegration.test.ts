import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { registerFileRoutes } from '../../src/server/files.js';
import { PiBridge, registerPiRoutes } from '../../src/server/piBridge.js';
import { ProjectRegistry } from '../../src/server/projects.js';
import { registerSessionRoutes } from '../../src/server/sessions.js';
import { registerTerminalRoutes } from '../../src/server/terminal.js';
import { projectId } from '../../src/server/util.js';
import { registerWorkspaceActivityHooks, WorkspaceLifecycleConflictError, WorkspaceLifecycleCoordinator } from '../../src/server/workspaceLifecycle.js';

test('Pi runtime leases block workspace deletion and deletion blocks new runtime leases', async (t) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-web-workspace-pi-activity-'));
  t.after(() => rm(projectPath, { recursive: true, force: true }));
  const lifecycle = new WorkspaceLifecycleCoordinator();
  const bridge = new PiBridge({ workspaceLifecycle: lifecycle });
  t.after(() => bridge.dispose({ timeoutMs: 100 }));

  const releaseMutation = await bridge.lockSessionMutation(projectPath, 'session-1');
  assert.ok(releaseMutation);
  assert.throws(() => lifecycle.acquireDeletion(projectPath), { message: /workspace is in use/i });
  releaseMutation();

  const deletion = lifecycle.acquireDeletion(projectPath);
  await assert.rejects(
    bridge.lockSessionMutation(projectPath, 'session-2'),
    (error) => error instanceof WorkspaceLifecycleConflictError && error.code === 'WORKSPACE_DELETING',
  );
  deletion.release();

  const releaseAfterDeletion = await bridge.lockSessionMutation(projectPath, 'session-2');
  assert.ok(releaseAfterDeletion);
  releaseAfterDeletion();
});

test('deferred Pi runtime disposal keeps workspace deletion blocked until cleanup settles', async () => {
  const lifecycle = new WorkspaceLifecycleCoordinator();
  const bridge = new PiBridge({ workspaceLifecycle: lifecycle });
  let finishDisposal: () => void = () => undefined;
  const disposalGate = new Promise<void>((resolve) => { finishDisposal = resolve; });

  (bridge as any).deferRuntimeSessionDisposal('/workspace/project', 'runtime-key', { dispose: () => disposalGate });
  assert.throws(() => lifecycle.acquireDeletion('/workspace/project'), { message: /workspace is in use/i });
  finishDisposal();
  const deletion = await waitForDeletionLease(lifecycle, '/workspace/project');
  deletion.release();
  await bridge.dispose({ timeoutMs: 100 });
});

test('failed deferred Pi disposal is retried before workspace deletion can continue', async () => {
  const lifecycle = new WorkspaceLifecycleCoordinator();
  const bridge = new PiBridge({ workspaceLifecycle: lifecycle });
  let disposalFails = true;
  (bridge as any).deferRuntimeSessionDisposal('/workspace/project', 'runtime-key', {
    dispose: () => { if (disposalFails) throw new Error('deferred disposal failed'); },
  });

  const firstDeletion = await waitForDeletionLease(lifecycle, '/workspace/project');
  await assert.rejects(bridge.disposeProject('/workspace/project'), /deferred disposal failed/i);
  firstDeletion.release();

  disposalFails = false;
  const finalDeletion = lifecycle.acquireDeletion('/workspace/project');
  await bridge.disposeProject('/workspace/project');
  finalDeletion.release();
  await bridge.dispose({ timeoutMs: 100 });
});

test('session resource cleanup retains request activity until orphan removal settles', async (t) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-web-workspace-session-cleanup-'));
  t.after(() => rm(projectPath, { recursive: true, force: true }));
  const registry = new ProjectRegistry(projectPath);
  const project = registry.list()[0];
  const lifecycle = new WorkspaceLifecycleCoordinator();
  const app = Fastify({ logger: false });
  registerWorkspaceActivityHooks(app, registry, lifecycle);
  let markCleanupStarted: () => void = () => undefined;
  let finishCleanup: () => void = () => undefined;
  const cleanupStarted = new Promise<void>((resolve) => { markCleanupStarted = resolve; });
  const cleanupGate = new Promise<void>((resolve) => { finishCleanup = resolve; });
  await registerSessionRoutes(app, registry, undefined, {
    cleanupOrphanedResources: async () => {
      markCleanupStarted();
      await cleanupGate;
    },
  });
  await app.ready();
  t.after(() => app.close());

  const listing = app.inject({ method: 'GET', url: `/api/projects/${project.id}/sessions` });
  await cleanupStarted;
  assert.throws(() => lifecycle.acquireDeletion(projectPath), { message: /workspace is in use/i });
  finishCleanup();
  const response = await listing;
  assert.equal(response.statusCode, 200, response.body);
  const deletion = await waitForDeletionLease(lifecycle, projectPath);
  deletion.release();
});

test('non-terminal project WebSockets reject deletion and retain activity while connected', async (t) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-web-workspace-websockets-'));
  t.after(() => rm(projectPath, { recursive: true, force: true }));
  const registry = new ProjectRegistry(projectPath);
  const project = registry.list()[0];
  const lifecycle = new WorkspaceLifecycleCoordinator();
  const bridge = new PiBridge({ workspaceLifecycle: lifecycle });
  const app = Fastify({ logger: false });
  await app.register(websocket);
  await registerFileRoutes(app, registry, undefined, lifecycle);
  await registerPiRoutes(app, registry, bridge, lifecycle);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => bridge.dispose({ timeoutMs: 100 }));
  t.after(() => app.close());

  const deletion = lifecycle.acquireDeletion(projectPath);
  for (const route of [
    `/ws/projects/${project.id}/files`,
    `/ws/projects/${project.id}/agent?sessionId=test-session`,
    `/ws/projects/${project.id}/notifications`,
  ]) {
    const socket = new WebSocket(`${address.replace(/^http/, 'ws')}${route}`);
    const errorMessage = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for WebSocket rejection: ${route}`)), 2_000);
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as { type?: string; message?: string };
        if (message.type !== 'error') return;
        clearTimeout(timer);
        resolve(message.message ?? '');
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`WebSocket failed before reporting deletion: ${route}`));
      }, { once: true });
    });
    assert.match(errorMessage, /workspace is being deleted/i);
    socket.close();
  }
  deletion.release();

  const fileSocket = new WebSocket(`${address.replace(/^http/, 'ws')}/ws/projects/${project.id}/files`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for file WebSocket readiness')), 2_000);
    fileSocket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { type?: string };
      if (message.type !== 'ready') return;
      clearTimeout(timer);
      resolve();
    });
    fileSocket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('File WebSocket failed before readiness'));
    }, { once: true });
  });
  assert.throws(() => lifecycle.acquireDeletion(projectPath), { message: /workspace is in use/i });
  const fileSocketClosed = new Promise<void>((resolve) => fileSocket.addEventListener('close', () => resolve(), { once: true }));
  fileSocket.close();
  await fileSocketClosed;
  const deletionAfterClose = await waitForDeletionLease(lifecycle, projectPath);
  deletionAfterClose.release();
});

test('blocked preserved workspace IDs cannot open terminal WebSockets after path replacement', async (t) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-web-workspace-blocked-terminal-'));
  const registry = new ProjectRegistry(projectPath);
  const project = registry.list()[0];
  registry.blockWithin(projectPath, 'Workspace files require manual recovery.');
  await rm(projectPath, { recursive: true, force: true });
  await mkdir(projectPath);
  t.after(() => rm(projectPath, { recursive: true, force: true }));

  const app = Fastify({ logger: false });
  await app.register(websocket);
  await registerTerminalRoutes(app, registry);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  const socket = new WebSocket(`${address.replace(/^http/, 'ws')}/ws/projects/${project.id}/terminal`);
  t.after(() => socket.close());

  const errorMessage = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for blocked terminal error')), 2_000);
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { type?: string; message?: string };
      if (message.type !== 'error') return;
      clearTimeout(timer);
      resolve(message.message ?? '');
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('Blocked terminal WebSocket failed before reporting its error'));
    }, { once: true });
  });
  assert.match(errorMessage, /manual recovery/i);
});

test('terminal WebSocket registration is rejected during workspace deletion', async (t) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-web-workspace-terminal-registration-'));
  t.after(() => rm(projectPath, { recursive: true, force: true }));
  const registry = new ProjectRegistry();
  const lifecycle = new WorkspaceLifecycleCoordinator();
  const deletion = lifecycle.acquireDeletion(projectPath);
  t.after(() => deletion.release());

  const app = Fastify({ logger: false });
  await app.register(websocket);
  await registerTerminalRoutes(app, registry, { workspaceLifecycle: lifecycle });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  const socket = new WebSocket(`${address.replace(/^http/, 'ws')}/ws/projects/${projectId(projectPath)}/terminal?projectPath=${encodeURIComponent(projectPath)}`);
  t.after(() => socket.close());

  const errorMessage = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for deleting workspace terminal error')), 2_000);
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { type?: string; message?: string };
      if (message.type !== 'error') return;
      clearTimeout(timer);
      resolve(message.message ?? '');
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('Deleting workspace terminal WebSocket failed before reporting its error'));
    }, { once: true });
  });
  assert.match(errorMessage, /workspace is being deleted/i);
  assert.throws(() => registry.get(projectId(projectPath)), /unknown project/i);
});

test('persistent terminal sessions retain workspace activity until the shell exits', async (t) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-web-workspace-pty-activity-'));
  t.after(() => rm(projectPath, { recursive: true, force: true }));
  const lifecycle = new WorkspaceLifecycleCoordinator();
  const app = Fastify({ logger: false });
  await app.register(websocket);
  await registerTerminalRoutes(app, {
    getOrAdd: () => ({ id: 'project-1', name: 'project', path: projectPath }),
  } as never, { workspaceLifecycle: lifecycle });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const socket = new WebSocket(`${address.replace(/^http/, 'ws')}/ws/projects/project-1/terminal`);

  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('Terminal WebSocket failed')), { once: true });
    });
    assert.throws(() => lifecycle.acquireDeletion(projectPath), { message: /workspace is in use/i });
    const closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve(), { once: true }));
    socket.send(JSON.stringify({ type: 'input', data: 'exit\n' }));
    await closed;
    const deletion = await waitForDeletionLease(lifecycle, projectPath);
    deletion.release();
  } finally {
    socket.close();
    await app.close();
  }
});

test('tracked terminal commands retain workspace activity until their process session exits', async (t) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-web-workspace-terminal-activity-'));
  const markerPath = path.join(projectPath, 'started');
  t.after(() => rm(projectPath, { recursive: true, force: true }));
  const lifecycle = new WorkspaceLifecycleCoordinator();
  const app = Fastify({ logger: false });
  await registerTerminalRoutes(app, {
    get: () => ({ id: 'project-1', name: 'project', path: projectPath }),
  } as never, { workspaceLifecycle: lifecycle });
  await app.ready();
  t.after(() => app.close());

  const script = `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ready'); setTimeout(() => {}, 400);`;
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
  const running = app.inject({ method: 'POST', url: '/api/projects/project-1/terminal', payload: { command } });
  await waitForFile(markerPath);

  assert.throws(() => lifecycle.acquireDeletion(projectPath), { message: /workspace is in use/i });
  const response = await running;
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(JSON.parse(response.body).exitCode, 0);

  const deletion = await waitForDeletionLease(lifecycle, projectPath);
  deletion.release();
});

test('tracked terminal activity survives the command leader while a process-session descendant runs', { skip: process.platform === 'win32' }, async (t) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-web-workspace-terminal-descendant-'));
  const markerPath = path.join(projectPath, 'descendant-pid');
  t.after(() => rm(projectPath, { recursive: true, force: true }));
  const lifecycle = new WorkspaceLifecycleCoordinator();
  const app = Fastify({ logger: false });
  await registerTerminalRoutes(app, {
    get: () => ({ id: 'project-1', name: 'project', path: projectPath }),
  } as never, { workspaceLifecycle: lifecycle });
  await app.ready();
  t.after(() => app.close());

  const descendantScript = `process.on('SIGHUP', () => {}); require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(descendantScript)} </dev/null >/dev/null 2>&1 &`;
  const response = await app.inject({ method: 'POST', url: '/api/projects/project-1/terminal', payload: { command } });
  assert.equal(response.statusCode, 200, response.body);
  await waitForFile(markerPath);
  const descendantPid = Number(await readFile(markerPath, 'utf8'));
  assert.ok(descendantPid > 0);

  try {
    assert.throws(() => lifecycle.acquireDeletion(projectPath), { message: /workspace is in use/i });
  } finally {
    try { process.kill(descendantPid, 'SIGKILL'); } catch { /* Process already exited. */ }
  }
  const deletion = await waitForDeletionLease(lifecycle, projectPath);
  deletion.release();
});

async function waitForFile(filePath: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error('Timed out waiting for terminal command');
}

async function waitForDeletionLease(lifecycle: WorkspaceLifecycleCoordinator, projectPath: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      return lifecycle.acquireDeletion(projectPath);
    } catch (error) {
      if (!(error instanceof WorkspaceLifecycleConflictError) || error.code !== 'WORKSPACE_ACTIVE') throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error('Timed out waiting for terminal workspace activity to release');
}
