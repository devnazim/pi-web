import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { registerFileRoutes } from '../../src/server/files.js';
import { ProjectRegistry } from '../../src/server/projects.js';

type TextSearchRange = { startColumn: number; endColumn: number };
type TextSearchEvent =
  | { type: 'file'; path: string; matchCount: number; lines: Array<{ line: number; preview: string; previewStartColumn: number; beforeTruncated: boolean; afterTruncated: boolean; ranges: TextSearchRange[]; targetRange?: TextSearchRange }> }
  | { type: 'done'; fileCount: number; matchCount: number; limitHit: boolean; timedOut: boolean }
  | { type: 'error'; message: string };

test('text search streams grouped literal matches with case, whole-word, and context options', async (t) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-web-text-search-'));
  await Promise.all([
    mkdir(path.join(projectPath, 'src')),
    mkdir(path.join(projectPath, 'node_modules', 'hidden-package'), { recursive: true }),
    mkdir(path.join(projectPath, 'src', 'nested', 'node_modules', 'hidden-package'), { recursive: true }),
    mkdir(path.join(projectPath, 'src', 'nested', '.pi-web'), { recursive: true }),
    mkdir(path.join(projectPath, '.pi-web'), { recursive: true }),
    mkdir(path.join(projectPath, '.git'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(projectPath, 'src', 'first.txt'), ['before', '🙂 Token tokenized TOKEN', 'after'].join('\n')),
    writeFile(path.join(projectPath, 'src', 'second.txt'), 'Token in another file'),
    writeFile(path.join(projectPath, 'node_modules', 'hidden-package', 'secret.txt'), 'Token should stay hidden'),
    writeFile(path.join(projectPath, 'src', 'nested', 'node_modules', 'hidden-package', 'secret.txt'), 'Token should stay hidden'),
    writeFile(path.join(projectPath, 'src', 'nested', '.pi-web', 'secret.txt'), 'Token should stay hidden'),
    writeFile(path.join(projectPath, '.pi-web', 'secret.txt'), 'Token should stay hidden'),
    writeFile(path.join(projectPath, '.git', 'secret.txt'), 'Token should stay hidden'),
  ]);

  const app = Fastify({ logger: false });
  const registry = new ProjectRegistry(projectPath);
  await registerFileRoutes(app, registry);
  await app.ready();
  t.after(async () => {
    await app.close();
    await rm(projectPath, { recursive: true, force: true });
  });

  const project = registry.list()[0];
  const response = await app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/files/text-search`,
    headers: { 'content-type': 'application/json' },
    payload: { query: 'token', caseSensitive: false, wholeWord: true, contextLines: 1 },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.headers['content-type'] ?? '', /^application\/x-ndjson/);

  const events = parseTextSearchEvents(response.body);
  const files = events.filter((event): event is Extract<TextSearchEvent, { type: 'file' }> => event.type === 'file');
  assert.deepEqual(files.map((file) => file.path).sort(), ['src/first.txt', 'src/second.txt']);
  const first = files.find((file) => file.path === 'src/first.txt')!;
  assert.equal(first.matchCount, 2);
  assert.deepEqual(first.lines.map((line) => line.line), [1, 2, 2, 3]);
  assert.deepEqual(first.lines[1].ranges, [
    { startColumn: 4, endColumn: 9 },
    { startColumn: 20, endColumn: 25 },
  ]);
  assert.deepEqual(first.lines[1].targetRange, { startColumn: 4, endColumn: 9 });
  assert.deepEqual(first.lines[2].targetRange, { startColumn: 20, endColumn: 25 });
  const done = events.find((event): event is Extract<TextSearchEvent, { type: 'done' }> => event.type === 'done');
  assert.deepEqual(done, { type: 'done', fileCount: 2, matchCount: 3, limitHit: false, timedOut: false });
});

test('text search applies case sensitivity and optional whole-word matching', async (t) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-web-text-search-options-'));
  await writeFile(path.join(projectPath, 'words.txt'), 'Token token TOKEN tokenized');
  const app = Fastify({ logger: false });
  const registry = new ProjectRegistry(projectPath);
  await registerFileRoutes(app, registry);
  await app.ready();
  t.after(async () => {
    await app.close();
    await rm(projectPath, { recursive: true, force: true });
  });
  const project = registry.list()[0];

  const sensitive = await app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/files/text-search`,
    headers: { 'content-type': 'application/json' },
    payload: { query: 'Token', caseSensitive: true, wholeWord: true, contextLines: 0 },
  });
  const sensitiveEvents = parseTextSearchEvents(sensitive.body);
  assert.equal(sensitiveEvents.find((event) => event.type === 'done' && event)?.matchCount, 1);

  const partial = await app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/files/text-search`,
    headers: { 'content-type': 'application/json' },
    payload: { query: 'token', caseSensitive: false, wholeWord: false, contextLines: 0 },
  });
  const partialEvents = parseTextSearchEvents(partial.body);
  assert.equal(partialEvents.find((event) => event.type === 'done' && event)?.matchCount, 4);
});

test('text search keeps previews bounded when matches are far apart on a long line', async (t) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-web-text-search-preview-'));
  await writeFile(path.join(projectPath, 'long.txt'), `needle${'x'.repeat(2_000)}needle`);
  const app = Fastify({ logger: false });
  const registry = new ProjectRegistry(projectPath);
  await registerFileRoutes(app, registry);
  await app.ready();
  t.after(async () => {
    await app.close();
    await rm(projectPath, { recursive: true, force: true });
  });
  const project = registry.list()[0];

  const response = await app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/files/text-search`,
    headers: { 'content-type': 'application/json' },
    payload: { query: 'needle', contextLines: 0 },
  });
  const file = parseTextSearchEvents(response.body).find((event) => event.type === 'file');
  assert.equal(file?.matchCount, 2);
  assert.equal(file?.lines.length, 2);
  assert.equal(file?.lines[0].preview.length, 500);
  assert.equal(file?.lines[0].afterTruncated, true);
  assert.equal(file?.lines[1].beforeTruncated, true);
  assert.deepEqual(file?.lines.map((line) => line.targetRange), [
    { startColumn: 1, endColumn: 7 },
    { startColumn: 2_007, endColumn: 2_013 },
  ]);
});

test('text search continues to later files after reaching the per-file result cap', async (t) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-web-text-search-file-limit-'));
  await Promise.all([
    writeFile(path.join(projectPath, 'first.txt'), Array.from({ length: 100 }, () => 'needle').join('\n')),
    writeFile(path.join(projectPath, 'second.txt'), 'needle'),
  ]);
  const app = Fastify({ logger: false });
  const registry = new ProjectRegistry(projectPath);
  await registerFileRoutes(app, registry);
  await app.ready();
  t.after(async () => {
    await app.close();
    await rm(projectPath, { recursive: true, force: true });
  });
  const project = registry.list()[0];

  const exactResponse = await app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/files/text-search`,
    headers: { 'content-type': 'application/json' },
    payload: { query: 'needle', contextLines: 0 },
  });
  const exactDone = parseTextSearchEvents(exactResponse.body).find((event): event is Extract<TextSearchEvent, { type: 'done' }> => event.type === 'done');
  assert.equal(exactDone?.matchCount, 101);
  assert.equal(exactDone?.limitHit, false);

  await writeFile(path.join(projectPath, 'first.txt'), Array.from({ length: 101 }, () => 'needle').join('\n'));
  const limitedResponse = await app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/files/text-search`,
    headers: { 'content-type': 'application/json' },
    payload: { query: 'needle', contextLines: 0 },
  });
  const limitedEvents = parseTextSearchEvents(limitedResponse.body);
  assert.deepEqual(limitedEvents.filter((event) => event.type === 'file').map((event) => event.path).sort(), ['first.txt', 'second.txt']);
  const limitedDone = limitedEvents.find((event): event is Extract<TextSearchEvent, { type: 'done' }> => event.type === 'done');
  assert.equal(limitedDone?.matchCount, 101);
  assert.equal(limitedDone?.limitHit, true);
});

test('text search uses lookahead before reporting the global result limit', async (t) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-web-text-search-global-limit-'));
  await Promise.all(Array.from({ length: 10 }, (_, index) => writeFile(path.join(projectPath, `part-${index}.txt`), Array.from({ length: 100 }, () => 'global-needle').join('\n'))));
  const app = Fastify({ logger: false });
  const registry = new ProjectRegistry(projectPath);
  await registerFileRoutes(app, registry);
  await app.ready();
  t.after(async () => {
    await app.close();
    await rm(projectPath, { recursive: true, force: true });
  });
  const project = registry.list()[0];

  const exactResponse = await app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/files/text-search`,
    headers: { 'content-type': 'application/json' },
    payload: { query: 'global-needle', contextLines: 0 },
  });
  const exactDone = parseTextSearchEvents(exactResponse.body).find((event): event is Extract<TextSearchEvent, { type: 'done' }> => event.type === 'done');
  assert.equal(exactDone?.matchCount, 1_000);
  assert.equal(exactDone?.limitHit, false);

  await writeFile(path.join(projectPath, 'extra.txt'), 'global-needle');
  const limitedResponse = await app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/files/text-search`,
    headers: { 'content-type': 'application/json' },
    payload: { query: 'global-needle', contextLines: 0 },
  });
  const limitedDone = parseTextSearchEvents(limitedResponse.body).find((event): event is Extract<TextSearchEvent, { type: 'done' }> => event.type === 'done');
  assert.equal(limitedDone?.matchCount, 1_000);
  assert.equal(limitedDone?.limitHit, true);
});

test('text search excludes Git worktree metadata files', async (t) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-web-text-search-worktree-'));
  await Promise.all([
    writeFile(path.join(projectPath, '.git'), 'gitdir: /outside/repository'),
    writeFile(path.join(projectPath, 'visible.txt'), 'gitdir: visible text'),
  ]);
  const app = Fastify({ logger: false });
  const registry = new ProjectRegistry(projectPath);
  await registerFileRoutes(app, registry);
  await app.ready();
  t.after(async () => {
    await app.close();
    await rm(projectPath, { recursive: true, force: true });
  });
  const project = registry.list()[0];

  const response = await app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/files/text-search`,
    headers: { 'content-type': 'application/json' },
    payload: { query: 'gitdir:', contextLines: 0 },
  });
  assert.deepEqual(parseTextSearchEvents(response.body).filter((event) => event.type === 'file').map((event) => event.path), ['visible.txt']);
});

test('text search respects ignore files outside a Git repository', async (t) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-web-text-search-ignore-'));
  await Promise.all([
    writeFile(path.join(projectPath, '.gitignore'), 'ignored.txt\n'),
    writeFile(path.join(projectPath, 'ignored.txt'), 'ignored-needle'),
    writeFile(path.join(projectPath, 'visible.txt'), 'ignored-needle'),
  ]);
  const app = Fastify({ logger: false });
  const registry = new ProjectRegistry(projectPath);
  await registerFileRoutes(app, registry);
  await app.ready();
  t.after(async () => {
    await app.close();
    await rm(projectPath, { recursive: true, force: true });
  });
  const project = registry.list()[0];

  const response = await app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/files/text-search`,
    headers: { 'content-type': 'application/json' },
    payload: { query: 'ignored-needle', contextLines: 0 },
  });
  assert.deepEqual(parseTextSearchEvents(response.body).filter((event) => event.type === 'file').map((event) => event.path), ['visible.txt']);
});

test('text search ignores ripgrep configuration that could follow workspace symlinks', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-web-text-search-config-'));
  const projectPath = path.join(root, 'project');
  const outsidePath = path.join(root, 'outside');
  await Promise.all([mkdir(projectPath), mkdir(outsidePath)]);
  await Promise.all([
    writeFile(path.join(outsidePath, 'secret.txt'), 'outside-secret'),
    writeFile(path.join(root, 'ripgrep.config'), '--follow\n'),
  ]);
  try {
    await symlink(outsidePath, path.join(projectPath, 'linked-outside'), 'dir');
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Directory symlinks are unavailable on this platform');
      return;
    }
    throw error;
  }

  const app = Fastify({ logger: false });
  const registry = new ProjectRegistry(projectPath);
  await registerFileRoutes(app, registry);
  await app.ready();
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const project = registry.list()[0];
  const previousConfig = process.env.RIPGREP_CONFIG_PATH;
  process.env.RIPGREP_CONFIG_PATH = path.join(root, 'ripgrep.config');
  let response;
  try {
    response = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/files/text-search`,
      headers: { 'content-type': 'application/json' },
      payload: { query: 'outside-secret', contextLines: 0 },
    });
  } finally {
    if (previousConfig === undefined) delete process.env.RIPGREP_CONFIG_PATH;
    else process.env.RIPGREP_CONFIG_PATH = previousConfig;
  }
  const events = parseTextSearchEvents(response.body);
  assert.equal(events.some((event) => event.type === 'file'), false);
  assert.equal(events.find((event) => event.type === 'done')?.matchCount, 0);
});

test('text search validates its options before starting a stream', async (t) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-web-text-search-invalid-'));
  const app = Fastify({ logger: false });
  const registry = new ProjectRegistry(projectPath);
  await registerFileRoutes(app, registry);
  await app.ready();
  t.after(async () => {
    await app.close();
    await rm(projectPath, { recursive: true, force: true });
  });
  const project = registry.list()[0];

  const response = await app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/files/text-search`,
    headers: { 'content-type': 'application/json' },
    payload: { query: 'text', contextLines: 4 },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.json<{ error: string }>().error, /Context lines/);

  const multiline = await app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/files/text-search`,
    headers: { 'content-type': 'application/json' },
    payload: { query: 'first\nsecond' },
  });
  assert.equal(multiline.statusCode, 400, multiline.body);
  assert.match(multiline.json<{ error: string }>().error, /single line/);
});

function parseTextSearchEvents(body: string) {
  return body.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as TextSearchEvent);
}
