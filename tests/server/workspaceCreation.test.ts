import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { ProjectRegistry, registerProjectRoutes } from '../../src/server/projects.js';
import { WorkspaceLifecycleCoordinator } from '../../src/server/workspaceLifecycle.js';

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync('git', args, { cwd });

async function fixture(t: TestContext, initialCommit = true) {
  const root = await mkdtemp('/tmp/pi-web-workspace-creation-');
  const repo = path.join(root, 'repo');
  const worktreeRoot = path.join(root, 'managed');
  await mkdir(repo);
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(repo, ['init', '-q', '--initial-branch=main']);
  await git(repo, ['config', 'user.name', 'Workspace Test']);
  await git(repo, ['config', 'user.email', 'workspace@example.invalid']);
  if (initialCommit) {
    await writeFile(path.join(repo, 'tracked.txt'), 'main\n');
    await writeFile(path.join(repo, '.gitignore'), '.env\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-qm', 'initial']);
  }
  const registry = new ProjectRegistry(repo);
  const project = registry.list()[0];
  const lifecycle = new WorkspaceLifecycleCoordinator();
  const app = Fastify({ logger: false });
  await registerProjectRoutes(app, registry, { worktreeRoot, workspaceLifecycle: lifecycle });
  await app.ready();
  t.after(() => app.close());
  const create = (payload: unknown, projectId = project.id) => app.inject({ method: 'POST', url: `/api/projects/${projectId}/workspaces`, payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
  return { root, repo, worktreeRoot, registry, project, lifecycle, app, create };
}

test('workspace options expose committed local and remote branches and prefer the default branch', async (t) => {
  const { repo, project, app } = await fixture(t);
  await git(repo, ['branch', 'develop']);
  await git(repo, ['update-ref', 'refs/remotes/origin/develop', 'HEAD']);
  await git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop']);
  const response = await app.inject({ url: `/api/projects/${project.id}/workspace-options` });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { localBranches: ['develop', 'main'], startPoints: ['develop', 'main', 'origin/develop', 'HEAD'], defaultStartPoint: 'develop' });
});

test('an unborn HEAD does not hide committed local or remote starting branches', async (t) => {
  const { repo, project, app, create } = await fixture(t);
  await git(repo, ['checkout', '--orphan', 'unborn']);
  const local = await app.inject({ url: `/api/projects/${project.id}/workspace-options` });
  assert.equal(local.statusCode, 200, local.body);
  assert.deepEqual(local.json(), { localBranches: ['main'], startPoints: ['main'], defaultStartPoint: 'main' });
  const created = await create({ branch: 'feat/from-main', startPoint: 'main' });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(await readFile(path.join(created.json().workspace.path, 'tracked.txt'), 'utf8'), 'main\n');
  await git(repo, ['worktree', 'remove', created.json().workspace.path]);
  await git(repo, ['branch', '-D', 'feat/from-main']);
  await git(repo, ['update-ref', 'refs/remotes/origin/release', 'main']);
  await git(repo, ['branch', '-D', 'main']);
  const remote = await app.inject({ url: `/api/projects/${project.id}/workspace-options` });
  assert.equal(remote.statusCode, 200, remote.body);
  assert.deepEqual(remote.json(), { localBranches: [], startPoints: ['origin/release'], defaultStartPoint: 'origin/release' });
});

test('named workspaces start at the selected commit and do not copy dirty files', async (t) => {
  const { repo, project, app, create } = await fixture(t);
  await git(repo, ['checkout', '-qb', 'develop']);
  await writeFile(path.join(repo, 'tracked.txt'), 'develop\n');
  await git(repo, ['commit', '-qam', 'develop']);
  await writeFile(path.join(repo, 'tracked.txt'), 'dirty\n');
  await writeFile(path.join(repo, 'untracked.txt'), 'untracked\n');
  await writeFile(path.join(repo, '.env'), 'SECRET=private\n');
  const response = await create({ name: 'Authentication flow', branch: 'feat/auth', startPoint: 'main' });
  assert.equal(response.statusCode, 200, response.body);
  const { workspace } = response.json();
  assert.equal(workspace.name, 'Authentication flow');
  assert.equal(workspace.branch, 'feat/auth');
  assert.equal((await git(workspace.path, ['branch', '--show-current'])).stdout.trim(), 'feat/auth');
  assert.equal(await readFile(path.join(workspace.path, 'tracked.txt'), 'utf8'), 'main\n');
  assert.equal(await readFile(path.join(repo, 'tracked.txt'), 'utf8'), 'dirty\n');
  assert.equal((await git(workspace.path, ['status', '--porcelain'])).stdout, '');
  const files = await readdir(workspace.path);
  assert.ok(!files.includes('untracked.txt'));
  assert.ok(!files.includes('.env'));
  const listing = await app.inject({ url: `/api/projects/${project.id}/workspaces` });
  assert.equal(listing.json().workspaces.find((item: { id: string }) => item.id === workspace.id).name, 'Authentication flow');
  await writeFile(path.join(workspace.path, 'tracked.txt'), 'feature edit\n');
  await git(workspace.path, ['add', 'tracked.txt']);
  assert.equal((await git(repo, ['diff', '--cached', '--name-only'])).stdout, '');
});

test('existing local branches get attached worktrees and reuse already open workspaces', async (t) => {
  const { repo, project, app, create } = await fixture(t);
  await git(repo, ['branch', 'feat/existing']);
  const response = await create({ mode: 'existing', name: 'Existing feature', branch: 'feat/existing' });
  assert.equal(response.statusCode, 200, response.body);
  const { workspace } = response.json();
  assert.equal((await git(workspace.path, ['branch', '--show-current'])).stdout.trim(), 'feat/existing');
  const reused = await create({ mode: 'existing', branch: 'feat/existing', name: 'Do not rename' });
  assert.equal(reused.statusCode, 200, reused.body);
  assert.equal(reused.json().workspace.id, workspace.id);
  assert.equal(reused.json().workspace.name, 'Existing feature');
  const local = await create({ mode: 'existing', branch: 'main' });
  assert.equal(local.statusCode, 200, local.body);
  assert.equal(local.json().workspace.id, project.id);
  assert.equal(local.json().workspace.local, true);
  assert.equal((await app.inject({ url: `/api/projects/${project.id}/workspaces` })).json().workspaces.length, 2);
});

test('workspace deletion keeps existing, explicit, and generated branches', async (t) => {
  const { repo, project, app, create } = await fixture(t);
  await git(repo, ['branch', 'pi-web/existing']);
  for (const input of [
    { mode: 'existing', branch: 'pi-web/existing' },
    { branch: 'pi-web/explicit', startPoint: 'main' },
    { name: 'Generated' },
  ]) {
    const created = await create(input);
    assert.equal(created.statusCode, 200, created.body);
    const { workspace } = created.json();
    const tip = (await git(repo, ['rev-parse', `refs/heads/${workspace.branch}`])).stdout;
    const removed = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${workspace.id}` });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal((await git(repo, ['rev-parse', `refs/heads/${workspace.branch}`])).stdout, tip);
    await assert.rejects(readFile(path.join(workspace.path, 'tracked.txt')));
  }
  assert.equal((await git(repo, ['worktree', 'list', '--porcelain'])).stdout.match(/^worktree /gm)?.length, 1);
});

test('existing branches in external worktrees are opened without changing their files', async (t) => {
  const { root, repo, create } = await fixture(t);
  const external = path.join(root, 'external');
  await git(repo, ['worktree', 'add', '-b', 'external', external]);
  await writeFile(path.join(external, 'tracked.txt'), 'keep local edit\n');
  const response = await create({ mode: 'existing', branch: 'external' });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().workspace.path, external);
  assert.equal(response.json().workspace.removable, false);
  assert.equal(await readFile(path.join(external, 'tracked.txt'), 'utf8'), 'keep local edit\n');
});

test('workspace creation rejects malformed options and never overwrites a branch', async (t) => {
  const { repo, create } = await fixture(t);
  const before = (await git(repo, ['rev-parse', 'main'])).stdout;
  for (const input of [
    null, [], { name: 1 }, { name: '\n' }, { name: 'a'.repeat(121) }, { branch: {} },
    { branch: 'bad..branch' }, { branch: '--detach' }, { branch: 'refs/heads/nested' }, { branch: '@{-1}' },
    { mode: 'bad' }, { mode: 'existing' }, { mode: 'existing', branch: 'missing' },
    { mode: 'existing', branch: 'main', startPoint: 'main' },
    { branch: 'main' }, { branch: 'feat/bad-base', startPoint: 'missing' }, { startPoint: '--help' },
  ]) {
    const response = await create(input);
    assert.equal(response.statusCode, 400, `${JSON.stringify(input)}: ${response.body}`);
  }
  assert.equal((await git(repo, ['rev-parse', 'main'])).stdout, before);
  assert.equal((await git(repo, ['worktree', 'list', '--porcelain'])).stdout.match(/^worktree /gm)?.length, 1);
});

test('starting branches take precedence over same-named tags and support remote branches', async (t) => {
  const { repo, create } = await fixture(t);
  await git(repo, ['tag', 'main']);
  await writeFile(path.join(repo, 'tracked.txt'), 'new main\n');
  await git(repo, ['commit', '-qam', 'advance main']);
  await git(repo, ['update-ref', 'refs/remotes/origin/release', 'refs/tags/main']);
  const local = await create({ branch: 'feat/from-local', startPoint: 'main' });
  assert.equal(local.statusCode, 200, local.body);
  assert.equal(await readFile(path.join(local.json().workspace.path, 'tracked.txt'), 'utf8'), 'new main\n');
  const remote = await create({ branch: 'feat/from-remote', startPoint: 'origin/release' });
  assert.equal(remote.statusCode, 200, remote.body);
  assert.equal(await readFile(path.join(remote.json().workspace.path, 'tracked.txt'), 'utf8'), 'main\n');
});

test('an unnamed existing branch workspace uses the branch as its display name', async (t) => {
  const { repo, project, app, create } = await fixture(t);
  await git(repo, ['branch', 'fix/regression']);
  const response = await create({ mode: 'existing', branch: 'fix/regression' });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().workspace.name, 'fix/regression');
  const listing = await app.inject({ url: `/api/projects/${project.id}/workspaces` });
  assert.equal(listing.json().workspaces.find((workspace: { branch: string }) => workspace.branch === 'fix/regression').name, 'fix/regression');
});

test('missing existing worktrees are not replaced or force checked out', async (t) => {
  const { root, repo, create } = await fixture(t);
  const external = path.join(root, 'missing');
  await git(repo, ['worktree', 'add', '-b', 'missing', external]);
  await rm(external, { recursive: true, force: true });
  const response = await create({ mode: 'existing', branch: 'missing' });
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.json().error, /already has a worktree/i);
  assert.equal((await git(repo, ['worktree', 'list', '--porcelain'])).stdout.match(/^worktree /gm)?.length, 2);
});

test('legacy name-only creation still generates a branch and starts at HEAD', async (t) => {
  const { repo, create } = await fixture(t);
  const response = await create({ name: 'Legacy feature' });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().workspace.branch, 'pi-web/legacy-feature');
  assert.equal((await git(response.json().workspace.path, ['rev-parse', 'HEAD'])).stdout, (await git(repo, ['rev-parse', 'HEAD'])).stdout);
  assert.equal((await create({})).statusCode, 200);
});

test('repositories without a commit report an actionable error', async (t) => {
  const { project, app, create } = await fixture(t, false);
  for (const response of [await app.inject({ url: `/api/projects/${project.id}/workspace-options` }), await create({ name: 'First feature' })]) {
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /initial commit/i);
  }
});

test('rollback removes only a new branch and preserves an existing branch when the project folder is absent', async (t) => {
  const { repo, registry, create, worktreeRoot } = await fixture(t);
  const subdir = path.join(repo, 'uncommitted-folder');
  await mkdir(subdir);
  const project = registry.add(subdir);
  await git(repo, ['branch', 'existing']);
  const before = (await git(repo, ['rev-parse', 'existing'])).stdout;
  const existing = await create({ mode: 'existing', branch: 'existing' }, project.id);
  assert.equal(existing.statusCode, 400, existing.body);
  assert.equal((await git(repo, ['rev-parse', 'existing'])).stdout, before);
  const fresh = await create({ name: 'Fails', branch: 'feat/fails', startPoint: 'main' }, project.id);
  assert.equal(fresh.statusCode, 400, fresh.body);
  await assert.rejects(git(repo, ['show-ref', '--verify', 'refs/heads/feat/fails']));
  assert.deepEqual(await readdir(path.join(worktreeRoot, project.id)), []);
  assert.equal((await git(repo, ['worktree', 'list', '--porcelain'])).stdout.match(/^worktree /gm)?.length, 1);
});

test('existing worktrees being deleted cannot be reopened', async (t) => {
  const { create, lifecycle } = await fixture(t);
  const created = await create({ name: 'Feature', branch: 'feat/busy' });
  assert.equal(created.statusCode, 200, created.body);
  const lease = lifecycle.acquireDeletion(created.json().workspace.path);
  try {
    const response = await create({ mode: 'existing', branch: 'feat/busy' });
    assert.equal(response.statusCode, 409, response.body);
  } finally {
    lease.release();
  }
});

test('concurrent requests for the same new branch leave the successful workspace intact', async (t) => {
  const { create } = await fixture(t);
  const responses = await Promise.all([create({ name: 'Concurrent', branch: 'feat/concurrent' }), create({ name: 'Concurrent', branch: 'feat/concurrent' })]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 400]);
  const workspace = responses.find((response) => response.statusCode === 200)!.json().workspace;
  assert.equal(await readFile(path.join(workspace.path, 'tracked.txt'), 'utf8'), 'main\n');
  assert.equal((await git(workspace.path, ['branch', '--show-current'])).stdout.trim(), 'feat/concurrent');
});
