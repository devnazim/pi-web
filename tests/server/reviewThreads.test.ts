import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { getGitHeadRevision, getGitStatus, getReviewableHeadFiles } from '../../src/server/git.js';
import { ProjectRegistry } from '../../src/server/projects.js';
import {
  addAgentReviewReply,
  cleanupOrphanedSessionReviewThreads,
  createAgentReviewThread,
  getPendingReviewThreads,
  getReviewThreads,
  registerReviewThreadRoutes,
  type ReviewThreadCollection,
} from '../../src/server/reviewThreads.js';
import {
  createSessionFile,
  readSessionDetail,
  registerSessionRoutes,
  resolveSessionIdentity,
  resolveSessionManager,
} from '../../src/server/sessions.js';
import { sessionIdFromPath } from '../../src/server/util.js';

const PI_SESSION_DIR_ENV = 'PI_CODING_AGENT_SESSION_DIR';
const execFileAsync = promisify(execFile);

test('review threads persist, reject conflicts and agent edits, re-anchor, and follow session deletion', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-web-review-'));
  const projectPath = path.join(root, 'project');
  const sessionDir = path.join(root, 'sessions');
  await Promise.all([
    mkdir(path.join(projectPath, '.git', 'objects'), { recursive: true }),
    mkdir(path.join(projectPath, '.git', 'refs', 'heads'), { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(projectPath, '.git', 'HEAD'), 'ref: refs/heads/main\n'),
    writeFile(path.join(projectPath, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n'),
    writeFile(path.join(projectPath, 'review.txt'), 'alpha\nbeta\ngamma\n'),
  ]);

  const sessionUuid = randomUUID();
  const sessionPath = path.join(sessionDir, 'session.jsonl');
  await writeFile(sessionPath, `${JSON.stringify({ type: 'session', id: sessionUuid, timestamp: new Date().toISOString(), cwd: projectPath, version: 3 })}\n`);
  const sessionId = sessionIdFromPath(sessionPath);
  const previousSessionDir = process.env[PI_SESSION_DIR_ENV];
  process.env[PI_SESSION_DIR_ENV] = sessionDir;

  const app = Fastify({ logger: false });
  const registry = new ProjectRegistry(projectPath);
  await registerReviewThreadRoutes(app, registry);
  await registerSessionRoutes(app, registry);
  await app.ready();
  t.after(async () => {
    await app.close();
    if (previousSessionDir === undefined) delete process.env[PI_SESSION_DIR_ENV];
    else process.env[PI_SESSION_DIR_ENV] = previousSessionDir;
    await rm(root, { recursive: true, force: true });
  });

  const project = registry.list()[0];
  const otherProjectPath = path.join(root, 'other-project');
  await mkdir(otherProjectPath);
  const otherProject = registry.add(otherProjectPath);
  const wrongProject = await app.inject({
    method: 'GET',
    url: `/api/projects/${otherProject.id}/review-threads?sessionId=${encodeURIComponent(sessionId)}`,
  });
  assert.equal(wrongProject.statusCode, 404);

  const collectionUrl = `/api/projects/${project.id}/review-threads`;
  const reviewUrl = (suffix = '') => `${collectionUrl}${suffix}?sessionId=${encodeURIComponent(sessionId)}`;
  const projectStoreDirectory = path.join(
    sessionDir,
    '.pi-web',
    'review-threads',
    `project-${createHash('sha256').update(path.resolve(projectPath)).digest('hex')}`,
  );
  const storeFile = path.join(projectStoreDirectory, `session-${createHash('sha256').update(sessionUuid).digest('hex')}.json`);
  const changedSelection = await app.inject({
    method: 'POST',
    url: reviewUrl(),
    payload: { expectedRevision: 0, anchor: { path: 'review.txt', startLine: 2, endLine: 2, selectedText: 'stale beta', contextBefore: ['alpha'], contextAfter: ['gamma', ''] }, body: 'Please revise this.' },
  });
  assert.equal(changedSelection.statusCode, 409, changedSelection.body);
  const changedContext = await app.inject({
    method: 'POST',
    url: reviewUrl(),
    payload: { expectedRevision: 0, anchor: { path: 'review.txt', startLine: 2, endLine: 2, selectedText: 'beta', contextBefore: ['unrelated'], contextAfter: ['gamma', ''] }, body: 'Please revise this.' },
  });
  assert.equal(changedContext.statusCode, 409, changedContext.body);

  const fencedCreatePromise = app.inject({
    method: 'POST',
    url: reviewUrl(),
    payload: { expectedRevision: 0, anchor: { path: 'review.txt', startLine: 2, endLine: 2, selectedText: 'beta', contextBefore: ['alpha'], contextAfter: ['gamma', ''] }, body: 'Fenced request' },
  });
  const lockPath = `${storeFile}.lock`;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await lstat(lockPath).catch(() => undefined)) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(await lstat(lockPath).catch(() => undefined), 'expected the store lock to be acquired');
  const reclaimClaim = `${lockPath}.stale-test-claim`;
  await link(lockPath, reclaimClaim);
  const fencedCreate = await fencedCreatePromise;
  assert.equal(fencedCreate.statusCode, 409, fencedCreate.body);
  await Promise.all([unlink(reclaimClaim), unlink(lockPath)]);
  assert.equal((await getReviewThreads(projectPath, sessionId)).revision, 0);

  const createdResponse = await app.inject({
    method: 'POST',
    url: reviewUrl(),
    payload: { expectedRevision: 0, anchor: { path: 'review.txt', startLine: 2, endLine: 2, selectedText: 'beta', contextBefore: ['alpha'], contextAfter: ['gamma', ''] }, body: 'Please revise this.' },
  });
  assert.equal(createdResponse.statusCode, 200, createdResponse.body);
  const created = createdResponse.json<ReviewThreadCollection>();
  assert.equal(created.revision, 1);
  assert.equal(created.threads[0].anchor.selectedText, 'beta');
  assert.deepEqual(created.threads[0].anchor.contextBefore, ['alpha']);

  const persisted = await getReviewThreads(projectPath, sessionId);
  assert.equal(persisted.revision, 1);
  assert.equal(persisted.threads[0].messages[0].author, 'user');
  await writeFile(`${storeFile}.lock`, '{"abandoned":true}\n');
  const staleTime = new Date(Date.now() - 120_000);
  await utimes(`${storeFile}.lock`, staleTime, staleTime);

  const conflict = await app.inject({
    method: 'POST',
    url: reviewUrl(`/${created.threads[0].id}/messages`),
    payload: { expectedRevision: 0, body: 'A stale reply' },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal((await getReviewThreads(projectPath, sessionId)).revision, 1);

  const concurrentReplies = await Promise.all(['First contender', 'Second contender'].map((body) => app.inject({
    method: 'POST',
    url: reviewUrl(`/${created.threads[0].id}/messages`),
    payload: { expectedRevision: 1, body },
  })));
  assert.deepEqual(concurrentReplies.map((response) => response.statusCode).sort(), [200, 409]);

  const resolved = await app.inject({
    method: 'PATCH',
    url: reviewUrl(`/${created.threads[0].id}`),
    payload: { expectedRevision: 2, status: 'resolved' },
  });
  assert.equal(resolved.statusCode, 200, resolved.body);
  assert.deepEqual((await getPendingReviewThreads(projectPath, sessionId)).threads, []);
  assert.equal((await getPendingReviewThreads(projectPath, sessionId, { includeResolved: true })).threads.length, 1);

  const withAgent = await addAgentReviewReply(projectPath, sessionId, {
    threadId: created.threads[0].id,
    body: 'I handled this.',
    handlesUserRevision: 2,
  });
  const agentMessage = withAgent.threads[0].messages.find((message) => message.author === 'agent')!;
  assert.equal(agentMessage.handlesUserRevision, 2);

  const forbidden = await app.inject({
    method: 'PATCH',
    url: reviewUrl(`/${created.threads[0].id}/messages/${agentMessage.id}`),
    payload: { expectedRevision: 4, body: 'User overwrite' },
  });
  assert.equal(forbidden.statusCode, 403);
  assert.equal((await getReviewThreads(projectPath, sessionId)).revision, 4);

  await writeFile(path.join(projectPath, 'review.txt'), 'intro\nalpha\nbeta\ngamma\n\nother\nbeta\nend\n');
  const reanchored = await getReviewThreads(projectPath, sessionId);
  assert.equal(reanchored.threads[0].outdated, false);
  assert.equal(reanchored.threads[0].anchor.startLine, 3);

  await writeFile(path.join(projectPath, 'review.txt'), 'intro\nunrelated\nbeta\nend\n');
  const wrongContext = await getReviewThreads(projectPath, sessionId);
  assert.equal(wrongContext.threads[0].outdated, true);

  await writeFile(path.join(projectPath, 'review.txt'), 'intro\nalpha\nchanged\ngamma\n');
  const outdated = await getReviewThreads(projectPath, sessionId);
  assert.equal(outdated.threads[0].outdated, true);
  assert.match(outdated.threads[0].outdatedReason ?? '', /changed|unique/i);

  const deletedRoot = await app.inject({
    method: 'DELETE',
    url: reviewUrl(`/${created.threads[0].id}/messages/${created.threads[0].messages[0].id}`),
    payload: { expectedRevision: 4 },
  });
  assert.equal(deletedRoot.statusCode, 200, deletedRoot.body);
  const tombstoned = deletedRoot.json<ReviewThreadCollection>();
  assert.equal(tombstoned.revision, 5);
  assert.equal(tombstoned.threads[0].messages[0].body, '');
  assert.ok(tombstoned.threads[0].messages[0].deletedAt);

  const openThread = await app.inject({
    method: 'PATCH',
    url: reviewUrl(`/${created.threads[0].id}`),
    payload: { expectedRevision: 5, status: 'open' },
  });
  assert.equal(openThread.statusCode, 200, openThread.body);
  const userReply = openThread.json<ReviewThreadCollection>().threads[0].messages.find((message) => message.author === 'user' && !message.deletedAt)!;
  const deletedLatestUser = await app.inject({
    method: 'DELETE',
    url: reviewUrl(`/${created.threads[0].id}/messages/${userReply.id}`),
    payload: { expectedRevision: 6 },
  });
  assert.equal(deletedLatestUser.statusCode, 200, deletedLatestUser.body);
  assert.deepEqual((await getPendingReviewThreads(projectPath, sessionId)).threads, []);

  const rootOnlyResponse = await app.inject({
    method: 'POST',
    url: reviewUrl(),
    payload: { expectedRevision: 7, anchor: { path: 'review.txt', startLine: 2, endLine: 2, selectedText: 'alpha', contextBefore: ['intro'], contextAfter: ['changed', 'gamma', ''] }, body: 'Root only' },
  });
  const rootOnly = rootOnlyResponse.json<ReviewThreadCollection>();
  assert.equal(rootOnlyResponse.statusCode, 200, rootOnlyResponse.body);
  const secondThread = rootOnly.threads.find((thread) => thread.id !== created.threads[0].id)!;
  const removedRootOnly = await app.inject({
    method: 'DELETE',
    url: reviewUrl(`/${secondThread.id}/messages/${secondThread.messages[0].id}`),
    payload: { expectedRevision: 8 },
  });
  assert.equal(removedRootOnly.statusCode, 200, removedRootOnly.body);
  assert.equal(removedRootOnly.json<ReviewThreadCollection>().threads.length, 1);

  await Promise.all([
    writeFile(path.join(projectStoreDirectory, `.${path.basename(storeFile)}.999.${randomUUID()}.tmp`), 'abandoned temp data\n'),
    writeFile(`${storeFile}.lock.stale-abandoned`, 'abandoned lock claim\n'),
  ]);
  const deletedSession = await app.inject({
    method: 'DELETE',
    url: `/api/projects/${project.id}/sessions/${sessionId}`,
  });
  assert.equal(deletedSession.statusCode, 200, deletedSession.body);
  assert.deepEqual(await readdir(projectStoreDirectory), []);
  const orphanStoreName = `session-${createHash('sha256').update(randomUUID()).digest('hex')}.json`;
  const orphanTemp = path.join(projectStoreDirectory, `.${orphanStoreName}.999.${randomUUID()}.tmp`);
  const orphanLock = path.join(projectStoreDirectory, `${orphanStoreName}.lock`);
  await Promise.all([writeFile(orphanTemp, 'orphan temp data\n'), writeFile(orphanLock, 'orphan lock data\n')]);
  await Promise.all([utimes(orphanTemp, staleTime, staleTime), utimes(orphanLock, staleTime, staleTime)]);
  await cleanupOrphanedSessionReviewThreads(projectPath, []);
  assert.deepEqual(await readdir(projectStoreDirectory), []);
  await assert.rejects(readdir(path.join(projectPath, '.pi-web')), { code: 'ENOENT' });
});

test('projects review anchors across staged and worktree baselines', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-web-staged-review-'));
  const projectPath = path.join(root, 'project');
  const sessionDir = path.join(root, 'sessions');
  await Promise.all([mkdir(projectPath), mkdir(sessionDir)]);
  await execFileAsync('git', ['init', '-q'], { cwd: projectPath });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: projectPath });
  await writeFile(path.join(projectPath, 'review.txt'), 'alpha\nbeta\ngamma\n');
  await execFileAsync('git', ['add', 'review.txt'], { cwd: projectPath });
  await execFileAsync('git', ['commit', '-qm', 'base'], { cwd: projectPath });
  await writeFile(path.join(projectPath, 'review.txt'), 'alpha\nstaged beta\ngamma\n');

  const sessionUuid = randomUUID();
  const sessionPath = path.join(sessionDir, 'session.jsonl');
  await writeFile(sessionPath, `${JSON.stringify({ type: 'session', id: sessionUuid, timestamp: new Date().toISOString(), cwd: projectPath, version: 3 })}\n`);
  const sessionId = sessionIdFromPath(sessionPath);
  const previousSessionDir = process.env[PI_SESSION_DIR_ENV];
  process.env[PI_SESSION_DIR_ENV] = sessionDir;
  t.after(async () => {
    if (previousSessionDir === undefined) delete process.env[PI_SESSION_DIR_ENV];
    else process.env[PI_SESSION_DIR_ENV] = previousSessionDir;
    await rm(root, { recursive: true, force: true });
  });

  const beforeStaging = await createAgentReviewThread(projectPath, sessionId, {
    path: 'review.txt',
    startLine: 2,
    endLine: 2,
    selectedText: 'staged beta',
    contextBefore: ['alpha'],
    contextAfter: ['gamma', ''],
    body: 'Created from the worktree',
  });
  assert.equal(beforeStaging.threads[0].anchor.staged, false);

  const storeFile = path.join(
    sessionDir,
    '.pi-web',
    'review-threads',
    `project-${createHash('sha256').update(path.resolve(projectPath)).digest('hex')}`,
    `session-${createHash('sha256').update(sessionUuid).digest('hex')}.json`,
  );
  const legacyStore = JSON.parse(await readFile(storeFile, 'utf8'));
  delete legacyStore.threads[0].anchor.staged;
  await writeFile(storeFile, `${JSON.stringify(legacyStore, null, 2)}\n`);
  assert.equal((await getReviewThreads(projectPath, sessionId)).threads[0].outdated, false);

  await writeFile(path.join(projectPath, 'review.txt'), 'changed context\nstaged beta\ngamma\n');
  await execFileAsync('git', ['add', 'review.txt'], { cwd: projectPath });
  const wrongCrossBaseline = await getReviewThreads(projectPath, sessionId);
  assert.equal(wrongCrossBaseline.threads[0].outdated, true);

  await writeFile(path.join(projectPath, 'review.txt'), 'alpha\nstaged beta\ngamma\n');
  await execFileAsync('git', ['add', 'review.txt'], { cwd: projectPath });
  const afterStaging = await getReviewThreads(projectPath, sessionId);
  assert.equal(afterStaging.threads[0].outdated, false);
  assert.equal(afterStaging.threads[0].location, 'changes');
  assert.deepEqual(afterStaging.threads[0].matchingBaselines, ['index']);
  assert.equal(afterStaging.threads[0].anchor.staged, true);

  await writeFile(path.join(projectPath, 'review.txt'), 'alpha\nworktree beta\ngamma\n');
  const stagedThread = await createAgentReviewThread(projectPath, sessionId, {
    path: 'review.txt',
    staged: true,
    startLine: 2,
    endLine: 2,
    selectedText: 'staged beta',
    contextBefore: ['alpha'],
    contextAfter: ['gamma', ''],
    body: 'Created from the index',
  });
  const stagedCreated = stagedThread.threads.find((thread) => thread.messages[0].body === 'Created from the index')!;
  assert.equal(stagedCreated.outdated, false);
  assert.deepEqual(stagedCreated.matchingBaselines, ['index']);
  assert.equal(stagedCreated.anchor.staged, true);

  const worktreeThread = await createAgentReviewThread(projectPath, sessionId, {
    path: 'review.txt',
    staged: false,
    startLine: 2,
    endLine: 2,
    selectedText: 'worktree beta',
    contextBefore: ['alpha'],
    contextAfter: ['gamma', ''],
    body: 'Created from the worktree baseline',
  });
  const worktreeCreated = worktreeThread.threads.find((thread) => thread.messages[0].body === 'Created from the worktree baseline')!;
  assert.equal(worktreeCreated.outdated, false);
  assert.equal(worktreeCreated.location, 'changes');
  assert.deepEqual(worktreeCreated.matchingBaselines, ['worktree']);
  assert.equal(worktreeCreated.anchor.staged, false);

  await assert.rejects(createAgentReviewThread(projectPath, sessionId, {
    path: 'review.txt',
    staged: true,
    startLine: 2,
    endLine: 2,
    selectedText: 'worktree beta',
    contextBefore: ['alpha'],
    contextAfter: ['gamma', ''],
    body: 'Wrong baseline',
  }), /context changed/);

  await execFileAsync('git', ['add', 'review.txt'], { cwd: projectPath });
  await execFileAsync('git', ['commit', '-qm', 'reviewed'], { cwd: projectPath });
  const afterCommit = await getReviewThreads(projectPath, sessionId);
  const committedThread = afterCommit.threads.find((thread) => thread.messages[0].body === 'Created from the worktree baseline')!;
  assert.equal(committedThread.location, 'committed');
  assert.deepEqual(committedThread.matchingBaselines, ['head']);
  assert.equal(committedThread.outdated, false);
  assert.equal(afterCommit.threads.find((thread) => thread.messages[0].body === 'Created from the index')!.location, 'outdated');
});

test('batch reads committed review files with unusual paths without desynchronizing', async (t) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-web-review-batch-'));
  t.after(() => rm(projectPath, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '-q'], { cwd: projectPath });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: projectPath });
  await Promise.all([
    writeFile(path.join(projectPath, 'binary.dat'), Buffer.from([0, 1, 2, 3])),
    writeFile(path.join(projectPath, 'line\nbreak.txt'), 'newline path\n'),
    writeFile(path.join(projectPath, 'normal.txt'), 'normal path\n'),
  ]);
  await execFileAsync('git', ['add', '.'], { cwd: projectPath });
  await execFileAsync('git', ['commit', '-qm', 'batch fixtures'], { cwd: projectPath });

  const revision = await getGitHeadRevision(projectPath);
  const contents = await getReviewableHeadFiles(projectPath, ['binary.dat', 'line\nbreak.txt', 'missing.txt', 'normal.txt'], revision);
  assert.ok(contents.get('binary.dat') instanceof Error);
  assert.equal(contents.get('line\nbreak.txt'), 'newline path\n');
  assert.equal(contents.get('missing.txt'), '');
  assert.equal(contents.get('normal.txt'), 'normal path\n');
});

test('retains the pending SessionManager and review UUID through first persistence', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-web-pending-review-'));
  const projectPath = path.join(root, 'project');
  const sessionDir = path.join(root, 'sessions');
  await Promise.all([
    mkdir(path.join(projectPath, '.git', 'objects'), { recursive: true }),
    mkdir(path.join(projectPath, '.git', 'refs', 'heads'), { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(projectPath, '.git', 'HEAD'), 'ref: refs/heads/main\n'),
    writeFile(path.join(projectPath, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n'),
    writeFile(path.join(projectPath, 'review.txt'), 'pending review\n'),
  ]);
  const previousSessionDir = process.env[PI_SESSION_DIR_ENV];
  process.env[PI_SESSION_DIR_ENV] = sessionDir;
  t.after(async () => {
    if (previousSessionDir === undefined) delete process.env[PI_SESSION_DIR_ENV];
    else process.env[PI_SESSION_DIR_ENV] = previousSessionDir;
    await rm(root, { recursive: true, force: true });
  });

  const filePath = await createSessionFile(projectPath);
  const sessionId = sessionIdFromPath(filePath);
  const identityBefore = await resolveSessionIdentity(sessionId, projectPath);
  const otherProjectPath = path.join(root, 'other-project');
  await mkdir(otherProjectPath);
  await assert.rejects(resolveSessionManager(sessionId, otherProjectPath), /does not belong/);
  const retainedManager = await resolveSessionManager(sessionId, projectPath);
  assert.equal(readSessionDetail(filePath, projectPath).header?.id, identityBefore.sessionUuid);
  assert.strictEqual(await resolveSessionManager(identityBefore.sessionUuid, projectPath), retainedManager);

  const beforePersistence = await createAgentReviewThread(projectPath, sessionId, {
    path: 'review.txt',
    startLine: 1,
    endLine: 1,
    selectedText: 'pending review',
    contextBefore: [],
    contextAfter: [''],
    body: 'Created before persistence',
  });
  assert.equal(beforePersistence.threads.length, 1);

  retainedManager.appendMessage({ role: 'user', content: 'Persist this session', timestamp: Date.now() } as any);
  retainedManager.appendMessage({
    role: 'assistant',
    content: [],
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  } as any);

  const identityAfter = await resolveSessionIdentity(sessionId, projectPath);
  assert.equal(identityAfter.sessionUuid, identityBefore.sessionUuid);
  const afterPersistence = await getReviewThreads(projectPath, sessionId);
  assert.equal(afterPersistence.threads[0].id, beforePersistence.threads[0].id);
});

test('excludes reserved Pi Web state from git discovery', async (t) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-web-git-state-'));
  t.after(() => rm(projectPath, { recursive: true, force: true }));
  await Promise.all([
    mkdir(path.join(projectPath, '.git', 'objects'), { recursive: true }),
    mkdir(path.join(projectPath, '.git', 'refs', 'heads'), { recursive: true }),
    mkdir(path.join(projectPath, '.pi-web', 'review-threads'), { recursive: true }),
    mkdir(path.join(projectPath, '.sessions', '.pi-web', 'review-threads'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(projectPath, '.git', 'HEAD'), 'ref: refs/heads/main\n'),
    writeFile(path.join(projectPath, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n'),
    writeFile(path.join(projectPath, '.pi-web', 'review-threads', 'state.json'), '{}\n'),
    writeFile(path.join(projectPath, '.sessions', '.pi-web', 'review-threads', 'state.json'), '{}\n'),
    writeFile(path.join(projectPath, 'visible.txt'), 'visible\n'),
  ]);

  const status = await getGitStatus(projectPath);
  assert.deepEqual(status.files.map((file) => file.path), ['visible.txt']);
});
