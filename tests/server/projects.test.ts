import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ProjectRegistry } from '../../src/server/projects.js';
import { projectId } from '../../src/server/util.js';

test('recovers an unknown project from a matching path without exposing it', async (t) => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'pi-web-project-'));
  t.after(() => rm(projectPath, { recursive: true, force: true }));
  const registry = new ProjectRegistry();
  const id = projectId(projectPath);

  const project = registry.getOrAdd(id, projectPath, { hidden: true });

  assert.equal(project.id, id);
  assert.equal(project.path, projectPath);
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(registry.list({ includeHidden: true }), [project]);
});

test('does not recover an unknown project from a mismatched path', async (t) => {
  const expectedPath = await mkdtemp(path.join(tmpdir(), 'pi-web-expected-project-'));
  const suppliedPath = await mkdtemp(path.join(tmpdir(), 'pi-web-supplied-project-'));
  t.after(() => Promise.all([
    rm(expectedPath, { recursive: true, force: true }),
    rm(suppliedPath, { recursive: true, force: true }),
  ]));
  const registry = new ProjectRegistry();
  const id = projectId(expectedPath);

  assert.throws(() => registry.getOrAdd(id, suppliedPath, { hidden: true }), { message: `Unknown project: ${id}` });
  assert.deepEqual(registry.list({ includeHidden: true }), []);
});
