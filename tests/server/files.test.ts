import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { registerFileRoutes } from '../../src/server/files.js';
import { ProjectRegistry } from '../../src/server/projects.js';

test('file routes hide and protect Pi Web state', async (t) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-web-files-'));
  await Promise.all([
    mkdir(path.join(projectPath, '.pi-web', 'uploads', 'project'), { recursive: true }),
    mkdir(path.join(projectPath, 'src')),
  ]);
  await Promise.all([
    writeFile(path.join(projectPath, '.pi-web', 'state.json'), '{}'),
    writeFile(path.join(projectPath, '.pi-web', 'uploads', 'project', 'note.txt'), 'uploaded note'),
    writeFile(path.join(projectPath, 'README.md'), '# project'),
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
  const listing = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/files` });
  assert.equal(listing.statusCode, 200, listing.body);
  assert.deepEqual(listing.json<{ entries: Array<{ name: string }> }>().entries.map((entry) => entry.name), ['src', 'README.md']);

  const directListing = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/files?path=${encodeURIComponent('.pi-web')}` });
  assert.equal(directListing.statusCode, 400, directListing.body);
  assert.match(directListing.json<{ error: string }>().error, /Cannot list \.pi-web/);

  const previewed = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/file?path=${encodeURIComponent('.pi-web/state.json')}` });
  assert.equal(previewed.statusCode, 400, previewed.body);
  assert.match(previewed.json<{ error: string }>().error, /Cannot read \.pi-web/);

  const written = await app.inject({
    method: 'PUT',
    url: `/api/projects/${project.id}/file?path=${encodeURIComponent('.pi-web/state.json')}`,
    headers: { 'content-type': 'application/json' },
    payload: { content: 'corrupt' },
  });
  assert.equal(written.statusCode, 400, written.body);
  assert.match(written.json<{ error: string }>().error, /Cannot write \.pi-web/);
  assert.equal(await readFile(path.join(projectPath, '.pi-web', 'state.json'), 'utf8'), '{}');

  const protectedAsset = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/asset?path=${encodeURIComponent('.pi-web/state.json')}` });
  assert.equal(protectedAsset.statusCode, 400, protectedAsset.body);
  assert.match(protectedAsset.json<{ error: string }>().error, /Cannot read \.pi-web/);

  const uploadPreview = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/file?path=${encodeURIComponent('.pi-web/uploads/project/note.txt')}` });
  assert.equal(uploadPreview.statusCode, 200, uploadPreview.body);
  assert.equal(uploadPreview.json<{ content: string }>().content, 'uploaded note');
  const uploadAsset = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/asset?path=${encodeURIComponent('.pi-web/uploads/project/note.txt')}` });
  assert.equal(uploadAsset.statusCode, 200, uploadAsset.body);
  assert.equal(uploadAsset.body, 'uploaded note');

  const deleted = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/file?path=${encodeURIComponent('.pi-web/state.json')}` });
  assert.equal(deleted.statusCode, 400, deleted.body);
  assert.match(deleted.json<{ error: string }>().error, /Cannot delete \.pi-web/);
  assert.equal(await readFile(path.join(projectPath, '.pi-web', 'state.json'), 'utf8'), '{}');

  const created = await app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/file`,
    headers: { 'content-type': 'application/json' },
    payload: { name: '.pi-web', directory: '' },
  });
  assert.equal(created.statusCode, 400, created.body);
  assert.match(created.json<{ error: string }>().error, /Cannot create \.pi-web/);

  try {
    await symlink('.pi-web', path.join(projectPath, 'state-alias'), 'dir');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.diagnostic('Skipping symlink-alias assertions because directory symlinks are unavailable');
      return;
    }
    throw error;
  }
  const aliasCreated = await app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/file`,
    headers: { 'content-type': 'application/json' },
    payload: { name: 'injected.txt', directory: 'state-alias' },
  });
  assert.equal(aliasCreated.statusCode, 400, aliasCreated.body);
  assert.match(aliasCreated.json<{ error: string }>().error, /Cannot create \.pi-web/);

  const aliasRenamed = await app.inject({
    method: 'PATCH',
    url: `/api/projects/${project.id}/file?path=${encodeURIComponent('state-alias/state.json')}`,
    headers: { 'content-type': 'application/json' },
    payload: { name: 'renamed.json' },
  });
  assert.equal(aliasRenamed.statusCode, 400, aliasRenamed.body);
  assert.match(aliasRenamed.json<{ error: string }>().error, /Cannot rename \.pi-web/);

  const aliasDeleted = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/file?path=${encodeURIComponent('state-alias/state.json')}` });
  assert.equal(aliasDeleted.statusCode, 400, aliasDeleted.body);
  assert.match(aliasDeleted.json<{ error: string }>().error, /Cannot delete \.pi-web/);
  assert.equal(await readFile(path.join(projectPath, '.pi-web', 'state.json'), 'utf8'), '{}');
});

test('file routes support projects opened through directory symlinks', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-web-files-symlink-'));
  const projectPath = path.join(root, 'project');
  const projectAlias = path.join(root, 'project-alias');
  await mkdir(projectPath);
  await writeFile(path.join(projectPath, 'README.md'), '# project');
  try {
    await symlink('project', projectAlias, 'dir');
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Directory symlinks are unavailable on this platform');
      return;
    }
    throw error;
  }

  const app = Fastify({ logger: false });
  const registry = new ProjectRegistry(projectAlias);
  await registerFileRoutes(app, registry);
  await app.ready();
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const project = registry.list()[0];
  const listing = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/files` });
  assert.equal(listing.statusCode, 200, listing.body);
  assert.equal(listing.json<{ path: string }>().path, '');
  assert.deepEqual(listing.json<{ entries: Array<{ name: string }> }>().entries.map((entry) => entry.name), ['README.md']);
});
