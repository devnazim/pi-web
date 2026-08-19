import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { ProjectRegistry } from '../../src/server/projects.js';
import { applyPiWebRetryDefaults } from '../../src/server/retrySettings.js';
import { registerSettingsRoutes } from '../../src/server/settings.js';

type RetrySettings = { enabled?: boolean; maxRetries?: number; baseDelayMs?: number };
type SettingsResponse = {
  global: { retry?: RetrySettings };
  project: { retry?: RetrySettings };
  effective: { retry: RetrySettings };
};

test('retry defaults only fill settings without explicit global or project values', () => {
  let overrides: { retry: Record<string, unknown> } | undefined;
  applyPiWebRetryDefaults({
    getGlobalSettings: () => ({ retry: { maxRetries: 7 } }),
    getProjectSettings: () => ({ retry: { baseDelayMs: 8_000 } }),
    applyOverrides: (value) => { overrides = value; },
  });

  assert.deepEqual(overrides, { retry: { enabled: true } });
});

test('settings use Pi Web retry defaults and preserve global and project overrides', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-web-settings-'));
  const projectPath = path.join(root, 'project');
  const agentDir = path.join(root, 'agent');
  await Promise.all([mkdir(projectPath), mkdir(agentDir)]);

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const app = Fastify({ logger: false });
  const registry = new ProjectRegistry(projectPath);
  await registerSettingsRoutes(app, registry);
  await app.ready();
  t.after(async () => {
    await app.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const project = registry.list()[0];
  const settingsUrl = `/api/projects/${project.id}/settings`;
  const defaultsResponse = await app.inject({ method: 'GET', url: settingsUrl });
  assert.equal(defaultsResponse.statusCode, 200, defaultsResponse.body);
  const defaults = defaultsResponse.json<SettingsResponse>();
  assert.equal(defaults.effective.retry.enabled, true);
  assert.equal(defaults.effective.retry.maxRetries, 5);
  assert.equal(defaults.effective.retry.baseDelayMs, 4_000);

  const globalResponse = await app.inject({
    method: 'PUT',
    url: settingsUrl,
    payload: { scope: 'global', settings: { retry: { maxRetries: 7 } } },
  });
  assert.equal(globalResponse.statusCode, 200, globalResponse.body);
  const globalSettings = globalResponse.json<SettingsResponse>();
  assert.deepEqual(globalSettings.global.retry, { maxRetries: 7 });
  assert.equal(globalSettings.effective.retry.enabled, true);
  assert.equal(globalSettings.effective.retry.maxRetries, 7);
  assert.equal(globalSettings.effective.retry.baseDelayMs, 4_000);

  const projectResponse = await app.inject({
    method: 'PUT',
    url: settingsUrl,
    payload: { scope: 'project', settings: { retry: { enabled: false, baseDelayMs: 8_000 } } },
  });
  assert.equal(projectResponse.statusCode, 200, projectResponse.body);
  const projectSettings = projectResponse.json<SettingsResponse>();
  assert.deepEqual(projectSettings.project.retry, { enabled: false, baseDelayMs: 8_000 });
  assert.equal(projectSettings.effective.retry.enabled, false);
  assert.equal(projectSettings.effective.retry.maxRetries, 7);
  assert.equal(projectSettings.effective.retry.baseDelayMs, 8_000);

  assert.deepEqual(
    JSON.parse(await readFile(path.join(projectPath, '.pi', 'settings.json'), 'utf8')),
    { retry: { enabled: false, baseDelayMs: 8_000 } },
  );
});
