import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { ProjectRegistry, registerProjectRoutes } from '../../src/server/projects.js';
import { registerWorkspaceActivityHooks, WorkspaceLifecycleCoordinator } from '../../src/server/workspaceLifecycle.js';

const execFileAsync = promisify(execFile);

test('workspace routes protect active, ignored, untracked, committed, and stale worktrees', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-web-workspaces-'));
  const repo = path.join(root, 'repo');
  const worktreeRoot = path.join(root, 'managed');
  await mkdir(repo);
  t.after(() => rm(root, { recursive: true, force: true }));

  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.name', 'Workspace Test']);
  await git(repo, ['config', 'user.email', 'workspace@example.invalid']);
  await writeFile(path.join(repo, '.gitignore'), '.env\nignored-data/\n');
  await writeFile(path.join(repo, 'tracked.txt'), 'base\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-qm', 'initial']);

  const registry = new ProjectRegistry(repo);
  const lifecycle = new WorkspaceLifecycleCoordinator();
  let deletionPreparations = 0;
  const app = Fastify({ logger: false });
  await registerProjectRoutes(app, registry, {
    worktreeRoot,
    workspaceLifecycle: lifecycle,
    beforeWorkspaceDelete: async () => { deletionPreparations += 1; },
  });
  await app.ready();
  t.after(() => app.close());

  const project = registry.list()[0];
  const ordinaryDeletingName = path.join(root, '.cache.deleting-backup', 'ordinary-project');
  await mkdir(ordinaryDeletingName, { recursive: true });
  const ordinaryProject = registry.add(ordinaryDeletingName);
  assert.equal(ordinaryProject.path, ordinaryDeletingName);
  registry.remove(ordinaryProject.id);

  const active = await createWorkspace(app, project.id, 'active');
  const activity = lifecycle.acquireActivity(active.path);
  const activeDelete = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${active.id}?force=true` });
  assert.equal(activeDelete.statusCode, 409);
  assert.match(responseJson(activeDelete).error, /workspace is in use/i);
  assert.equal(deletionPreparations, 0);
  assert.equal(await exists(active.path), true);
  activity.release();

  const windowsWorkspace = await createWorkspace(app, project.id, 'windows-fail-closed');
  await writeFile(path.join(windowsWorkspace.path, 'sentinel.txt'), 'must survive\n');
  const windowsRegistry = new ProjectRegistry(repo);
  windowsRegistry.add(windowsWorkspace.path, { hidden: true });
  let windowsDeletionPreparations = 0;
  const windowsApp = Fastify({ logger: false });
  await registerProjectRoutes(windowsApp, windowsRegistry, {
    worktreeRoot,
    platform: 'win32',
    beforeWorkspaceDelete: async () => { windowsDeletionPreparations += 1; },
  });
  await windowsApp.ready();
  const windowsDelete = await windowsApp.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${windowsWorkspace.id}` });
  assert.equal(windowsDelete.statusCode, 409);
  assert.match(responseJson(windowsDelete).error, /disabled on windows/i);
  const windowsForceDelete = await windowsApp.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${windowsWorkspace.id}?force=true` });
  assert.equal(windowsForceDelete.statusCode, 409);
  assert.equal(windowsDeletionPreparations, 0);
  assert.equal(await readFile(path.join(windowsWorkspace.path, 'sentinel.txt'), 'utf8'), 'must survive\n');
  assert.ok(windowsRegistry.get(windowsWorkspace.id));
  assert.match((await git(repo, ['worktree', 'list', '--porcelain'])).stdout, new RegExp(`worktree ${windowsWorkspace.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  await windowsApp.close();
  await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${windowsWorkspace.id}?force=true` });

  const quarantined = await createWorkspace(app, project.id, 'quarantine-alias');
  const quarantinePath = path.join(path.dirname(quarantined.path), `.${path.basename(quarantined.path)}.deleting-test`);
  const registeredProjects = registry.list({ includeHidden: true }).length;
  const quarantineDeletion = lifecycle.acquireDeletion(quarantined.path);
  lifecycle.bindDeletionAlias(quarantined.path, quarantinePath);
  await git(repo, ['worktree', 'move', quarantined.path, quarantinePath]);
  const duringQuarantine = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/workspaces` });
  assert.equal(duringQuarantine.statusCode, 200, duringQuarantine.body);
  assert.equal(responseJson(duringQuarantine).workspaces.some((workspace: { path: string }) => workspace.path === quarantinePath), false);
  assert.equal(registry.list({ includeHidden: true }).length, registeredProjects);
  assert.throws(() => lifecycle.acquireActivity(quarantinePath), { message: /workspace is being deleted/i });
  await git(repo, ['worktree', 'move', quarantinePath, quarantined.path]);
  quarantineDeletion.release();
  await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${quarantined.id}?force=true` });

  await writeFile(path.join(active.path, '.env'), 'SECRET=keep-me\n');
  await mkdir(path.join(active.path, 'ignored-data'));
  await writeFile(path.join(active.path, 'ignored-data', 'local.db'), 'important\n');
  const ignoredDelete = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${active.id}` });
  assert.equal(ignoredDelete.statusCode, 409);
  assert.match(responseJson(ignoredDelete).error, /ignored local files/i);
  assert.equal(await readFile(path.join(active.path, '.env'), 'utf8'), 'SECRET=keep-me\n');
  assert.equal(await readFile(path.join(active.path, 'ignored-data', 'local.db'), 'utf8'), 'important\n');

  const forcedDelete = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${active.id}?force=true` });
  assert.equal(forcedDelete.statusCode, 200);
  assert.equal(await exists(active.path), false);

  const untracked = await createWorkspace(app, project.id, 'untracked');
  await git(repo, ['config', 'status.showUntrackedFiles', 'no']);
  await writeFile(path.join(untracked.path, 'untracked.txt'), 'keep me\n');
  const untrackedDelete = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${untracked.id}` });
  assert.equal(untrackedDelete.statusCode, 409);
  assert.equal(await readFile(path.join(untracked.path, 'untracked.txt'), 'utf8'), 'keep me\n');
  await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${untracked.id}?force=true` });
  await git(repo, ['config', '--unset', 'status.showUntrackedFiles']);

  const hiddenChange = await createWorkspace(app, project.id, 'assume-unchanged');
  await git(hiddenChange.path, ['update-index', '--assume-unchanged', 'tracked.txt']);
  await writeFile(path.join(hiddenChange.path, 'tracked.txt'), 'hidden local change\n');
  const hiddenChangeDelete = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${hiddenChange.id}` });
  assert.equal(hiddenChangeDelete.statusCode, 409);
  assert.match(responseJson(hiddenChangeDelete).error, /hidden by git index flags/i);
  assert.equal(await readFile(path.join(hiddenChange.path, 'tracked.txt'), 'utf8'), 'hidden local change\n');
  await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${hiddenChange.id}?force=true` });

  const committed = await createWorkspace(app, project.id, 'committed');
  await writeFile(path.join(committed.path, 'tracked.txt'), 'committed workspace work\n');
  await git(committed.path, ['add', 'tracked.txt']);
  await git(committed.path, ['commit', '-qm', 'workspace commit']);
  const committedTip = (await git(committed.path, ['rev-parse', 'HEAD'])).stdout.trim();
  const committedDelete = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${committed.id}` });
  assert.equal(committedDelete.statusCode, 200);
  assert.equal((await git(repo, ['rev-parse', committed.branch])).stdout.trim(), committedTip);

  const locked = await createWorkspace(app, project.id, 'locked');
  await git(repo, ['worktree', 'lock', '--reason', 'workspace test', locked.path]);
  const lockedDelete = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${locked.id}` });
  assert.equal(lockedDelete.statusCode, 409);
  assert.match(responseJson(lockedDelete).error, /locked by git/i);
  const lockedForceDelete = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${locked.id}?force=true` });
  assert.equal(lockedForceDelete.statusCode, 409);
  assert.equal(await exists(locked.path), true);
  await git(repo, ['worktree', 'unlock', locked.path]);
  await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${locked.id}?force=true` });

  const matchingSymlink = await createWorkspace(app, project.id, 'matching-symlink');
  const matchingSymlinkRecovery = path.join(path.dirname(matchingSymlink.path), `.${path.basename(matchingSymlink.path)}.deleting-symlink`);
  await symlink(root, matchingSymlinkRecovery, 'dir');
  const matchingSymlinkDelete = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${matchingSymlink.id}?force=true` });
  assert.equal(matchingSymlinkDelete.statusCode, 409);
  assert.match(responseJson(matchingSymlinkDelete).error, /previous deletion could not restore/i);
  assert.equal(await readFile(path.join(matchingSymlink.path, 'tracked.txt'), 'utf8'), 'base\n');
  await unlink(matchingSymlinkRecovery);
  await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${matchingSymlink.id}?force=true` });

  const uninspectable = await createWorkspace(app, project.id, 'uninspectable-parent');
  await rm(path.dirname(uninspectable.path), { recursive: true, force: true });
  const uninspectableDelete = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${uninspectable.id}?force=true` });
  assert.equal(uninspectableDelete.statusCode, 409);
  assert.match(responseJson(uninspectableDelete).error, /could not inspect the managed workspace directory/i);
  await git(repo, ['worktree', 'prune']);

  const prunable = await createWorkspace(app, project.id, 'prunable');
  await rm(prunable.path, { recursive: true, force: true });
  await mkdir(prunable.path, { recursive: true });
  await writeFile(path.join(prunable.path, 'replacement.txt'), 'replacement must survive\n');
  assert.match((await git(repo, ['worktree', 'list', '--porcelain'])).stdout, /prunable/);
  const prunableDelete = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${prunable.id}?force=true` });
  assert.equal(prunableDelete.statusCode, 409);
  assert.match(responseJson(prunableDelete).error, /prunable or missing/i);
  assert.equal(await readFile(path.join(prunable.path, 'replacement.txt'), 'utf8'), 'replacement must survive\n');
  await rm(prunable.path, { recursive: true, force: true });
  await git(repo, ['worktree', 'prune']);
  await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${prunable.id}?force=true` });

  const verifiedStale = await createWorkspace(app, project.id, 'verified-stale');
  const verifiedMarker = /^gitdir:\s*(.+)\s*$/i.exec((await readFile(path.join(verifiedStale.path, '.git'), 'utf8')).trim());
  assert.ok(verifiedMarker);
  await rm(path.resolve(verifiedStale.path, verifiedMarker[1]), { recursive: true, force: true });
  const verifiedStaleDelete = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${verifiedStale.id}` });
  assert.equal(verifiedStaleDelete.statusCode, 409);
  const verifiedStaleForceDelete = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${verifiedStale.id}?force=true` });
  assert.equal(verifiedStaleForceDelete.statusCode, 200, verifiedStaleForceDelete.body);
  assert.equal(await exists(verifiedStale.path), false);

  const preserved = await createWorkspace(app, project.id, 'preserved-quarantine');
  const preservedPath = path.join(path.dirname(preserved.path), `.${path.basename(preserved.path)}.deleting-test`);
  await git(repo, ['worktree', 'move', preserved.path, preservedPath]);
  const preservedDelete = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${preserved.id}` });
  assert.equal(preservedDelete.statusCode, 409);
  assert.match(responseJson(preservedDelete).error, /previous deletion could not restore/i);
  const preservedRetry = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${preserved.id}?force=true` });
  assert.equal(preservedRetry.statusCode, 409);
  assert.match(responseJson(preservedRetry).error, new RegExp(preservedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(await readFile(path.join(preservedPath, 'tracked.txt'), 'utf8'), 'base\n');
  const afterPreservedFailure = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/workspaces` });
  assert.equal(responseJson(afterPreservedFailure).workspaces.some((workspace: { path: string }) => workspace.path === preservedPath), false);
  assert.match(registry.blockReason(preserved.id) ?? '', /manual recovery/i);
  assert.throws(() => registry.add(preservedPath, { hidden: true }), /preserved workspace deletion quarantine/i);
  const quarantineAlias = path.join(root, 'quarantine-alias');
  const quarantineDescendantAlias = path.join(root, 'quarantine-descendant-alias');
  await mkdir(path.join(preservedPath, 'recovery-child'));
  await symlink(preservedPath, quarantineAlias, 'dir');
  await symlink(path.join(preservedPath, 'recovery-child'), quarantineDescendantAlias, 'dir');
  assert.throws(() => registry.add(quarantineAlias), /resolves into a preserved workspace deletion quarantine/i);
  assert.throws(() => registry.add(quarantineDescendantAlias), /resolves into a preserved workspace deletion quarantine/i);
  await unlink(quarantineAlias);
  await unlink(quarantineDescendantAlias);

  await mkdir(preserved.path, { recursive: true });
  await writeFile(path.join(preserved.path, 'replacement.txt'), 'ordinary replacement\n');
  const ordinaryReplacementDelete = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${preserved.id}?force=true` });
  assert.equal(ordinaryReplacementDelete.statusCode, 409);
  assert.match(responseJson(ordinaryReplacementDelete).error, /previous deletion could not restore/i);
  assert.equal(await readFile(path.join(preserved.path, 'replacement.txt'), 'utf8'), 'ordinary replacement\n');
  await rm(preserved.path, { recursive: true, force: true });

  await git(repo, ['worktree', 'add', '-b', 'replacement-worktree', preserved.path]);
  const gitReplacementDelete = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${preserved.id}?force=true` });
  assert.equal(gitReplacementDelete.statusCode, 409);
  assert.match(responseJson(gitReplacementDelete).error, /previous deletion could not restore/i);
  assert.equal(await readFile(path.join(preserved.path, 'tracked.txt'), 'utf8'), 'base\n');
  assert.equal(await readFile(path.join(preservedPath, 'tracked.txt'), 'utf8'), 'base\n');
  await git(repo, ['worktree', 'remove', '--force', preserved.path]);
  await git(repo, ['worktree', 'remove', '--force', preservedPath]);

  const stale = await createWorkspace(app, project.id, 'stale');
  const movedPath = path.join(root, 'moved-stale');
  await git(repo, ['worktree', 'move', stale.path, movedPath]);
  await mkdir(stale.path, { recursive: true });
  await writeFile(path.join(stale.path, 'replacement.txt'), 'must survive\n');
  const staleDelete = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${stale.id}` });
  assert.equal(staleDelete.statusCode, 409);
  assert.match(responseJson(staleDelete).error, /git no longer recognizes/i);
  const staleForceDelete = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${stale.id}?force=true` });
  assert.equal(staleForceDelete.statusCode, 409);
  assert.match(responseJson(staleForceDelete).error, /could not verify/i);
  assert.equal(await readFile(path.join(stale.path, 'replacement.txt'), 'utf8'), 'must survive\n');
  await git(repo, ['worktree', 'remove', '--force', movedPath]);

  const raceRegistry = new ProjectRegistry(repo);
  const raceLifecycle = new WorkspaceLifecycleCoordinator();
  const raceApp = Fastify({ logger: false });
  let markRaceDeletionStarted: () => void = () => undefined;
  let raceDeletionGate = Promise.resolve();
  await registerProjectRoutes(raceApp, raceRegistry, {
    worktreeRoot,
    workspaceLifecycle: raceLifecycle,
    beforeWorkspaceDelete: async () => {
      markRaceDeletionStarted();
      await raceDeletionGate;
    },
  });
  await raceApp.ready();
  const raceProject = raceRegistry.list()[0];

  const swapTarget = await createWorkspace(raceApp, raceProject.id, 'swap-target');
  const swapReplacement = await createWorkspace(raceApp, raceProject.id, 'swap-replacement');
  let finishSwapDeletion: () => void = () => undefined;
  const swapDeletionStarted = new Promise<void>((resolve) => { markRaceDeletionStarted = resolve; });
  raceDeletionGate = new Promise<void>((resolve) => { finishSwapDeletion = resolve; });
  const swapTargetMoved = path.join(root, 'swap-target-moved');
  const swapDelete = raceApp.inject({ method: 'DELETE', url: `/api/projects/${raceProject.id}/workspaces/${swapTarget.id}?force=true` });
  await swapDeletionStarted;
  await git(repo, ['worktree', 'move', swapTarget.path, swapTargetMoved]);
  await git(repo, ['worktree', 'move', swapReplacement.path, swapTarget.path]);
  finishSwapDeletion();
  const swapDeleteResult = await swapDelete;
  assert.equal(swapDeleteResult.statusCode, 409);
  assert.match(responseJson(swapDeleteResult).error, /worktree identity changed/i);
  assert.equal(await readFile(path.join(swapTarget.path, 'tracked.txt'), 'utf8'), 'base\n');
  await git(repo, ['worktree', 'remove', '--force', swapTarget.path]);
  await git(repo, ['worktree', 'remove', '--force', swapTargetMoved]);

  const staleRace = await createWorkspace(raceApp, raceProject.id, 'stale-race');
  const staleRaceMarker = /^gitdir:\s*(.+)\s*$/i.exec((await readFile(path.join(staleRace.path, '.git'), 'utf8')).trim());
  assert.ok(staleRaceMarker);
  await rm(path.resolve(staleRace.path, staleRaceMarker[1]), { recursive: true, force: true });
  let finishStaleRaceDeletion: () => void = () => undefined;
  const staleRaceDeletionStarted = new Promise<void>((resolve) => { markRaceDeletionStarted = resolve; });
  raceDeletionGate = new Promise<void>((resolve) => { finishStaleRaceDeletion = resolve; });
  const staleRaceDelete = raceApp.inject({ method: 'DELETE', url: `/api/projects/${raceProject.id}/workspaces/${staleRace.id}?force=true` });
  await staleRaceDeletionStarted;
  await rm(staleRace.path, { recursive: true, force: true });
  await git(repo, ['worktree', 'add', '-b', 'stale-race-replacement', staleRace.path]);
  finishStaleRaceDeletion();
  const staleRaceDeleteResult = await staleRaceDelete;
  assert.equal(staleRaceDeleteResult.statusCode, 409);
  assert.match(responseJson(staleRaceDeleteResult).error, /worktree identity changed/i);
  assert.equal(await readFile(path.join(staleRace.path, 'tracked.txt'), 'utf8'), 'base\n');
  await git(repo, ['worktree', 'remove', '--force', staleRace.path]);

  const reusedIdentity = await createWorkspace(raceApp, raceProject.id, 'reused-identity');
  let finishReusedIdentityDeletion: () => void = () => undefined;
  const reusedIdentityDeletionStarted = new Promise<void>((resolve) => { markRaceDeletionStarted = resolve; });
  raceDeletionGate = new Promise<void>((resolve) => { finishReusedIdentityDeletion = resolve; });
  const reusedIdentityDelete = raceApp.inject({ method: 'DELETE', url: `/api/projects/${raceProject.id}/workspaces/${reusedIdentity.id}?force=true` });
  await reusedIdentityDeletionStarted;
  await git(repo, ['worktree', 'remove', '--force', reusedIdentity.path]);
  await git(repo, ['worktree', 'add', '-b', 'reused-identity-replacement', reusedIdentity.path]);
  finishReusedIdentityDeletion();
  const reusedIdentityDeleteResult = await reusedIdentityDelete;
  assert.equal(reusedIdentityDeleteResult.statusCode, 409);
  assert.match(responseJson(reusedIdentityDeleteResult).error, /worktree identity changed/i);
  assert.equal(await readFile(path.join(reusedIdentity.path, 'tracked.txt'), 'utf8'), 'base\n');
  await git(repo, ['worktree', 'remove', '--force', reusedIdentity.path]);

  const staleSameMarker = await createWorkspace(raceApp, raceProject.id, 'stale-same-marker');
  const staleSameMarkerText = await readFile(path.join(staleSameMarker.path, '.git'), 'utf8');
  const staleSameMarkerMatch = /^gitdir:\s*(.+)\s*$/i.exec(staleSameMarkerText.trim());
  assert.ok(staleSameMarkerMatch);
  await rm(path.resolve(staleSameMarker.path, staleSameMarkerMatch[1]), { recursive: true, force: true });
  let finishStaleSameMarkerDeletion: () => void = () => undefined;
  const staleSameMarkerDeletionStarted = new Promise<void>((resolve) => { markRaceDeletionStarted = resolve; });
  raceDeletionGate = new Promise<void>((resolve) => { finishStaleSameMarkerDeletion = resolve; });
  const staleSameMarkerDelete = raceApp.inject({ method: 'DELETE', url: `/api/projects/${raceProject.id}/workspaces/${staleSameMarker.id}?force=true` });
  await staleSameMarkerDeletionStarted;
  await rm(staleSameMarker.path, { recursive: true, force: true });
  await mkdir(staleSameMarker.path, { recursive: true });
  await writeFile(path.join(staleSameMarker.path, '.git'), staleSameMarkerText);
  await writeFile(path.join(staleSameMarker.path, 'replacement.txt'), 'same marker replacement\n');
  finishStaleSameMarkerDeletion();
  const staleSameMarkerDeleteResult = await staleSameMarkerDelete;
  assert.equal(staleSameMarkerDeleteResult.statusCode, 409);
  assert.match(responseJson(staleSameMarkerDeleteResult).error, /worktree identity changed/i);
  assert.equal(await readFile(path.join(staleSameMarker.path, 'replacement.txt'), 'utf8'), 'same marker replacement\n');
  await rm(staleSameMarker.path, { recursive: true, force: true });
  await git(repo, ['worktree', 'prune']);

  const staleSymlink = await createWorkspace(raceApp, raceProject.id, 'stale-symlink');
  const symlinkTarget = await createWorkspace(raceApp, raceProject.id, 'symlink-target');
  await git(repo, ['worktree', 'remove', '--force', staleSymlink.path]);
  await symlink(symlinkTarget.path, staleSymlink.path, 'dir');
  const staleSymlinkDelete = await raceApp.inject({ method: 'DELETE', url: `/api/projects/${raceProject.id}/workspaces/${staleSymlink.id}?force=true` });
  assert.equal(staleSymlinkDelete.statusCode, 409);
  assert.match(responseJson(staleSymlinkDelete).error, /filesystem identity/i);
  assert.equal(await readFile(path.join(symlinkTarget.path, 'tracked.txt'), 'utf8'), 'base\n');
  assert.match((await git(repo, ['worktree', 'list', '--porcelain'])).stdout, new RegExp(symlinkTarget.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await unlink(staleSymlink.path);
  await git(repo, ['worktree', 'remove', '--force', symlinkTarget.path]);
  await raceApp.close();

  await mkdir(path.join(repo, 'packages/a'), { recursive: true });
  await mkdir(path.join(repo, 'packages/b'), { recursive: true });
  await writeFile(path.join(repo, 'packages/a/a.txt'), 'a\n');
  await writeFile(path.join(repo, 'packages/b/b.txt'), 'b\n');
  await git(repo, ['add', 'packages']);
  await git(repo, ['commit', '-qm', 'add monorepo projects']);
  const nestedRegistry = new ProjectRegistry(path.join(repo, 'packages/a'));
  const nestedLifecycle = new WorkspaceLifecycleCoordinator();
  const nestedApp = Fastify({ logger: false });
  let nestedDeletionRoot: string | undefined;
  let markNestedDeletionStarted: () => void = () => undefined;
  let finishNestedDeletion: () => void = () => undefined;
  const nestedDeletionStarted = new Promise<void>((resolve) => { markNestedDeletionStarted = resolve; });
  const nestedDeletionGate = new Promise<void>((resolve) => { finishNestedDeletion = resolve; });
  registerWorkspaceActivityHooks(nestedApp, nestedRegistry, nestedLifecycle);
  await registerProjectRoutes(nestedApp, nestedRegistry, {
    worktreeRoot,
    workspaceLifecycle: nestedLifecycle,
    beforeWorkspaceDelete: async (worktreePath) => {
      nestedDeletionRoot = worktreePath;
      markNestedDeletionStarted();
      await nestedDeletionGate;
    },
  });
  await nestedApp.ready();
  const nestedProject = nestedRegistry.list()[0];
  const nestedWorkspace = await createWorkspace(nestedApp, nestedProject.id, 'monorepo');
  const nestedWorktreeRoot = path.resolve(nestedWorkspace.path, '../..');
  const siblingProject = nestedRegistry.add(path.join(nestedWorktreeRoot, 'packages/b'), { hidden: true });
  const siblingActivity = nestedLifecycle.acquireActivity(siblingProject.path);
  const nestedBlockedDelete = await nestedApp.inject({ method: 'DELETE', url: `/api/projects/${nestedProject.id}/workspaces/${nestedWorkspace.id}?force=true` });
  assert.equal(nestedBlockedDelete.statusCode, 409);
  assert.match(responseJson(nestedBlockedDelete).error, /workspace is in use/i);
  assert.equal(nestedDeletionRoot, undefined);
  assert.equal(await readFile(path.join(siblingProject.path, 'b.txt'), 'utf8'), 'b\n');
  siblingActivity.release();
  const externalDirectory = path.join(root, 'external-project');
  const lexicalDescendantAlias = path.join(nestedWorktreeRoot, 'packages/external-alias');
  const nestedLexicalDescendantAlias = path.join(nestedWorktreeRoot, 'packages/external-nested-alias');
  const sourceProjectAlias = path.join(nestedWorktreeRoot, 'packages/source-project-alias');
  const commonAncestorAlias = path.join(nestedWorktreeRoot, 'packages/common-ancestor-alias');
  await mkdir(path.join(externalDirectory, 'nested'), { recursive: true });
  await symlink(externalDirectory, lexicalDescendantAlias, 'dir');
  await symlink(path.join(externalDirectory, 'nested'), nestedLexicalDescendantAlias, 'dir');
  await symlink(nestedProject.path, sourceProjectAlias, 'dir');
  await symlink(root, commonAncestorAlias, 'dir');
  const lexicalDescendantProject = nestedRegistry.add(lexicalDescendantAlias, { hidden: true });
  const nestedLexicalDescendantProject = nestedRegistry.add(nestedLexicalDescendantAlias, { hidden: true });
  const sourceAliasProject = nestedRegistry.add(sourceProjectAlias, { hidden: true });
  const commonAncestorAliasProject = nestedRegistry.add(commonAncestorAlias, { hidden: true });
  const aliasActivity = nestedLifecycle.acquireActivity(lexicalDescendantProject.path);
  const aliasBlockedDelete = await nestedApp.inject({ method: 'DELETE', url: `/api/projects/${nestedProject.id}/workspaces/${nestedWorkspace.id}?force=true` });
  assert.equal(aliasBlockedDelete.statusCode, 409);
  assert.match(responseJson(aliasBlockedDelete).error, /workspace is in use/i);
  aliasActivity.release();
  const sourceActivity = nestedLifecycle.acquireActivity(nestedProject.path);
  const sourceBlockedDelete = await nestedApp.inject({ method: 'DELETE', url: `/api/projects/${nestedProject.id}/workspaces/${nestedWorkspace.id}?force=true` });
  assert.equal(sourceBlockedDelete.statusCode, 409);
  assert.match(responseJson(sourceBlockedDelete).error, /workspace is in use/i);
  sourceActivity.release();

  const deletionScopeResponse = await nestedApp.inject({ method: 'GET', url: `/api/projects/${nestedProject.id}/workspaces/${nestedWorkspace.id}/deletion-scope` });
  assert.equal(deletionScopeResponse.statusCode, 200, deletionScopeResponse.body);
  const initialDeletionScope = responseJson(deletionScopeResponse) as { workspaceIds: string[]; participantIds: string[]; scopeToken: string };
  const deletionScope = new Set<string>(initialDeletionScope.workspaceIds);
  const deletionParticipants = new Set<string>(initialDeletionScope.participantIds);
  assert.equal(deletionScope.has(nestedWorkspace.id), true);
  assert.equal(deletionScope.has(siblingProject.id), true);
  assert.equal(deletionScope.has(lexicalDescendantProject.id), true);
  assert.equal(deletionScope.has(nestedLexicalDescendantProject.id), true);
  assert.equal(deletionScope.has(sourceAliasProject.id), true);
  assert.equal(deletionScope.has(commonAncestorAliasProject.id), true);
  assert.equal(deletionScope.has(nestedProject.id), false);
  assert.equal(deletionParticipants.has(nestedProject.id), true);

  const addedScopedProject = nestedRegistry.add(nestedWorktreeRoot, { hidden: true });
  const addedScopeDelete = await nestedApp.inject({ method: 'DELETE', url: `/api/projects/${nestedProject.id}/workspaces/${nestedWorkspace.id}?force=true&scope=${encodeURIComponent(initialDeletionScope.scopeToken)}` });
  assert.equal(addedScopeDelete.statusCode, 409);
  assert.match(responseJson(addedScopeDelete).error, /deletion scope changed/i);
  nestedRegistry.remove(addedScopedProject.id);

  const beforeRemovalScope = responseJson(await nestedApp.inject({ method: 'GET', url: `/api/projects/${nestedProject.id}/workspaces/${nestedWorkspace.id}/deletion-scope` })) as { scopeToken: string };
  nestedRegistry.remove(siblingProject.id);
  const removedScopeDelete = await nestedApp.inject({ method: 'DELETE', url: `/api/projects/${nestedProject.id}/workspaces/${nestedWorkspace.id}?force=true&scope=${encodeURIComponent(beforeRemovalScope.scopeToken)}` });
  assert.equal(removedScopeDelete.statusCode, 409);
  assert.match(responseJson(removedScopeDelete).error, /deletion scope changed/i);
  nestedRegistry.add(siblingProject.path, { hidden: true });

  const beforeRetargetScope = responseJson(await nestedApp.inject({ method: 'GET', url: `/api/projects/${nestedProject.id}/workspaces/${nestedWorkspace.id}/deletion-scope` })) as { scopeToken: string };
  const otherExternalDirectory = path.join(root, 'other-external-project');
  await mkdir(otherExternalDirectory);
  await unlink(lexicalDescendantAlias);
  await symlink(otherExternalDirectory, lexicalDescendantAlias, 'dir');
  const retargetedScopeDelete = await nestedApp.inject({ method: 'DELETE', url: `/api/projects/${nestedProject.id}/workspaces/${nestedWorkspace.id}?force=true&scope=${encodeURIComponent(beforeRetargetScope.scopeToken)}` });
  assert.equal(retargetedScopeDelete.statusCode, 409);
  assert.match(responseJson(retargetedScopeDelete).error, /deletion scope changed/i);
  await unlink(lexicalDescendantAlias);
  await symlink(externalDirectory, lexicalDescendantAlias, 'dir');

  const finalDeletionScope = responseJson(await nestedApp.inject({ method: 'GET', url: `/api/projects/${nestedProject.id}/workspaces/${nestedWorkspace.id}/deletion-scope` })) as { scopeToken: string };
  const nestedDeletePromise = nestedApp.inject({ method: 'DELETE', url: `/api/projects/${nestedProject.id}/workspaces/${nestedWorkspace.id}?force=true&scope=${encodeURIComponent(finalDeletionScope.scopeToken)}` });
  await nestedDeletionStarted;
  const concurrentRegistration = await nestedApp.inject({ method: 'POST', url: '/api/projects', payload: { path: siblingProject.path } });
  assert.equal(concurrentRegistration.statusCode, 409);
  assert.match(responseJson(concurrentRegistration).error, /workspace is being deleted/i);
  finishNestedDeletion();
  const nestedDelete = await nestedDeletePromise;
  assert.equal(nestedDelete.statusCode, 200, nestedDelete.body);
  assert.equal(nestedDeletionRoot, nestedWorktreeRoot);
  assert.throws(() => nestedRegistry.get(siblingProject.id), /unknown project/i);
  assert.throws(() => nestedRegistry.get(lexicalDescendantProject.id), /unknown project/i);
  assert.throws(() => nestedRegistry.get(nestedLexicalDescendantProject.id), /unknown project/i);
  assert.throws(() => nestedRegistry.get(sourceAliasProject.id), /unknown project/i);
  assert.throws(() => nestedRegistry.get(commonAncestorAliasProject.id), /unknown project/i);
  assert.equal(nestedRegistry.get(nestedProject.id).path, nestedProject.path);

  const nestedPreserved = await createWorkspace(nestedApp, nestedProject.id, 'monorepo-preserved');
  const nestedPreservedRoot = path.resolve(nestedPreserved.path, '../..');
  const nestedPreservedSibling = nestedRegistry.add(path.join(nestedPreservedRoot, 'packages/b'), { hidden: true });
  const nestedPreservedPath = path.join(path.dirname(nestedPreservedRoot), `.${path.basename(nestedPreservedRoot)}.deleting-test`);
  await git(repo, ['worktree', 'move', nestedPreservedRoot, nestedPreservedPath]);
  const nestedPreservedDelete = await nestedApp.inject({ method: 'DELETE', url: `/api/projects/${nestedProject.id}/workspaces/${nestedPreserved.id}` });
  assert.equal(nestedPreservedDelete.statusCode, 409);
  assert.match(nestedRegistry.blockReason(nestedPreservedSibling.id) ?? '', /manual recovery/i);

  const siblingSourceRegistry = new ProjectRegistry(path.join(repo, 'packages/b'));
  const siblingSourceApp = Fastify({ logger: false });
  await registerProjectRoutes(siblingSourceApp, siblingSourceRegistry, { worktreeRoot });
  await siblingSourceApp.ready();
  const siblingSourceProject = siblingSourceRegistry.list()[0];
  const siblingWorkspaces = await siblingSourceApp.inject({ method: 'GET', url: `/api/projects/${siblingSourceProject.id}/workspaces` });
  assert.equal(siblingWorkspaces.statusCode, 200, siblingWorkspaces.body);
  assert.equal(responseJson(siblingWorkspaces).workspaces.some((workspace: { path: string }) => workspace.path.startsWith(nestedPreservedPath)), false);
  await siblingSourceApp.close();
  await git(repo, ['worktree', 'remove', '--force', nestedPreservedPath]);
  await nestedApp.close();

  const submoduleSource = path.join(root, 'submodule-source');
  await mkdir(submoduleSource);
  await git(submoduleSource, ['init', '-q']);
  await git(submoduleSource, ['config', 'user.name', 'Workspace Test']);
  await git(submoduleSource, ['config', 'user.email', 'workspace@example.invalid']);
  await writeFile(path.join(submoduleSource, 'module.txt'), 'module\n');
  await git(submoduleSource, ['add', '.']);
  await git(submoduleSource, ['commit', '-qm', 'module']);
  await git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleSource, 'modules/sample']);
  await git(repo, ['commit', '-qm', 'add submodule']);
  const withSubmodule = await createWorkspace(app, project.id, 'initialized-submodule');
  await git(withSubmodule.path, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive']);
  const submoduleDelete = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/workspaces/${withSubmodule.id}?force=true` });
  assert.equal(submoduleDelete.statusCode, 409);
  assert.match(responseJson(submoduleDelete).error, /initialized submodules/i);
  assert.equal(await readFile(path.join(withSubmodule.path, 'modules/sample/module.txt'), 'utf8'), 'module\n');
  await rm(withSubmodule.path, { recursive: true, force: true });
  await git(repo, ['worktree', 'prune']);
});

async function createWorkspace(app: ReturnType<typeof Fastify>, projectId: string, name: string) {
  const response = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/workspaces`, payload: { name } });
  assert.equal(response.statusCode, 200, response.body);
  return responseJson(response).workspace as { id: string; path: string; branch: string };
}

async function git(cwd: string, args: string[]) {
  return execFileAsync('git', args, { cwd });
}

async function exists(filePath: string) {
  return access(filePath).then(() => true, () => false);
}

function responseJson(response: { body: string }) {
  return JSON.parse(response.body) as any;
}
