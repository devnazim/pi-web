import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerWorkspaceActivityHooks, WorkspaceLifecycleConflictError, WorkspaceLifecycleCoordinator } from '../../src/server/workspaceLifecycle.js';

test('workspace activity and deletion leases exclude each other without disturbing active work', () => {
  const lifecycle = new WorkspaceLifecycleCoordinator();
  const activity = lifecycle.acquireActivity('/workspace/project');

  assert.throws(
    () => lifecycle.acquireDeletion('/workspace/project'),
    (error) => error instanceof WorkspaceLifecycleConflictError && error.code === 'WORKSPACE_ACTIVE' && error.statusCode === 409,
  );
  assert.throws(() => lifecycle.acquireDeletion('/workspace/project'), { message: /workspace is in use/i });

  activity.release();
  activity.release();
  const deletion = lifecycle.acquireDeletion('/workspace/project');
  assert.throws(
    () => lifecycle.acquireActivity('/workspace/project'),
    (error) => error instanceof WorkspaceLifecycleConflictError && error.code === 'WORKSPACE_DELETING',
  );
  assert.throws(
    () => lifecycle.acquireDeletion('/workspace/project'),
    (error) => error instanceof WorkspaceLifecycleConflictError && error.code === 'WORKSPACE_DELETING',
  );

  deletion.release();
  deletion.release();
  lifecycle.acquireActivity('/workspace/project').release();
});

test('worktree-root deletion excludes activity in descendant projects and quarantine aliases', () => {
  const lifecycle = new WorkspaceLifecycleCoordinator();
  const worktreePath = '/workspace/worktree';
  const descendantActivity = lifecycle.acquireActivity('/workspace/worktree/packages/b');
  assert.throws(() => lifecycle.acquireDeletion(worktreePath), { message: /workspace is in use/i });
  descendantActivity.release();

  const deletion = lifecycle.acquireDeletion(worktreePath);
  const quarantinePath = '/workspace/.worktree.deleting-test';
  lifecycle.bindDeletionAlias(worktreePath, quarantinePath);
  assert.throws(() => lifecycle.acquireActivity('/workspace/worktree/packages/a'), { message: /workspace is being deleted/i });
  assert.throws(() => lifecycle.acquireActivity('/workspace/.worktree.deleting-test/packages/b'), { message: /workspace is being deleted/i });
  deletion.release();
});

test('retargeted symlink activity follows its current workspace identity', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-web-workspace-retarget-'));
  const workspaceA = path.join(root, 'workspace-a');
  const workspaceB = path.join(root, 'workspace-b');
  const aliasPath = path.join(root, 'alias');
  await mkdir(workspaceA);
  await mkdir(workspaceB);
  await symlink(workspaceA, aliasPath, 'dir');
  t.after(() => rm(root, { recursive: true, force: true }));

  const lifecycle = new WorkspaceLifecycleCoordinator();
  lifecycle.acquireActivity(aliasPath).release();
  await rm(aliasPath);
  await symlink(workspaceB, aliasPath, 'dir');

  const deletion = lifecycle.acquireDeletion(workspaceB);
  assert.throws(() => lifecycle.acquireActivity(aliasPath), { message: /workspace is being deleted/i });
  deletion.release();
  lifecycle.acquireActivity(aliasPath).release();
});

test('retargeting a lexical descendant preserves its original activity protection', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-web-workspace-lexical-retarget-'));
  const worktreePath = path.join(root, 'worktree');
  const outsideA = path.join(root, 'outside-a');
  const outsideB = path.join(root, 'outside-b');
  const aliasPath = path.join(worktreePath, 'alias');
  await mkdir(worktreePath);
  await mkdir(outsideA);
  await mkdir(outsideB);
  await symlink(outsideA, aliasPath, 'dir');
  t.after(() => rm(root, { recursive: true, force: true }));

  const lifecycle = new WorkspaceLifecycleCoordinator();
  const activity = lifecycle.acquireActivity(aliasPath);
  await rm(aliasPath);
  await symlink(outsideB, aliasPath, 'dir');
  assert.throws(() => lifecycle.acquireDeletion(worktreePath), { message: /workspace is in use/i });
  activity.release();
  const deletion = lifecycle.acquireDeletion(worktreePath);
  assert.throws(() => lifecycle.acquireActivity(aliasPath), { message: /workspace is being deleted/i });
  deletion.release();
});

test('project request hooks hold activity and reject requests during deletion', async (t) => {
  const lifecycle = new WorkspaceLifecycleCoordinator();
  const app = Fastify({ logger: false });
  let blockedReason: string | undefined;
  registerWorkspaceActivityHooks(app, {
    blockReason: () => blockedReason,
    get: () => ({ id: 'project-1', name: 'project', path: '/workspace/project' }),
  } as never, lifecycle);
  let markStarted: () => void = () => undefined;
  let finishRequest: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const gate = new Promise<void>((resolve) => { finishRequest = resolve; });
  app.post('/api/projects/:projectId/write', async () => {
    markStarted();
    await gate;
    return { ok: true };
  });
  await app.ready();
  t.after(() => app.close());

  const running = app.inject({ method: 'POST', url: '/api/projects/project-1/write' });
  await started;
  assert.throws(() => lifecycle.acquireDeletion('/workspace/project'), { message: /workspace is in use/i });
  finishRequest();
  assert.equal((await running).statusCode, 200);

  const deletion = lifecycle.acquireDeletion('/workspace/project');
  const blocked = await app.inject({ method: 'POST', url: '/api/projects/project-1/write' });
  assert.equal(blocked.statusCode, 409);
  assert.match(JSON.parse(blocked.body).error, /workspace is being deleted/i);
  deletion.release();

  blockedReason = 'Workspace files require manual recovery.';
  const recoveryBlocked = await app.inject({ method: 'POST', url: '/api/projects/project-1/write' });
  assert.equal(recoveryBlocked.statusCode, 409);
  assert.match(JSON.parse(recoveryBlocked.body).error, /manual recovery/i);
});

test('workspace lifecycle normalizes equivalent and symlinked paths', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-web-workspace-lifecycle-'));
  const projectPath = path.join(root, 'project');
  const aliasPath = path.join(root, 'alias');
  await mkdir(projectPath);
  await symlink(projectPath, aliasPath, 'dir');
  t.after(() => rm(root, { recursive: true, force: true }));

  const lifecycle = new WorkspaceLifecycleCoordinator();
  const activity = lifecycle.acquireActivity(path.join(aliasPath, '..', 'alias'));
  assert.throws(() => lifecycle.acquireDeletion(projectPath), { message: /workspace is in use/i });
  activity.release();

  const deletion = lifecycle.acquireDeletion(aliasPath);
  const quarantinePath = path.join(root, '.project.deleting-test');
  lifecycle.bindDeletionAlias(aliasPath, quarantinePath);
  await rename(projectPath, quarantinePath);
  assert.equal(lifecycle.isDeleting(quarantinePath), true);
  assert.throws(() => lifecycle.acquireActivity(aliasPath), { message: /workspace is being deleted/i });
  assert.throws(() => lifecycle.acquireActivity(quarantinePath), { message: /workspace is being deleted/i });
  deletion.release();
});
