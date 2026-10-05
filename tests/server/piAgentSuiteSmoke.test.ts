import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { PiBridge } from '../../src/server/piBridge.js';

// Run only with an explicit published package directory. npm test stays offline.
const suitePath = process.env.PI_WEB_SUITE_PATH;

test('published pi-agent-suite 2.13.5 loads and runs through the RPC bridge with Pi 1.0.3', {
  skip: !suitePath && 'Set PI_WEB_SUITE_PATH to the extracted published package directory',
  timeout: 90_000,
}, async (t) => {
  const packageDir = path.resolve(suitePath!);
  const manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'pi-agent-suite');
  assert.equal(manifest.version, '2.13.5');
  assert.ok(manifest.pi.extensions.length > 20, 'Expected the published package extension list');
  for (const name of ['pi-agent-core', 'pi-ai', 'pi-coding-agent', 'pi-tui']) {
    const peer = `@earendil-works/${name}`;
    assert.equal(manifest.peerDependencies[peer], '1.0.2', `Unexpected suite peer requirement: ${peer}`);
    const projectManifestPath = new URL(`../../node_modules/${peer}/package.json`, import.meta.url);
    // Suite still declares 1.0.2 peers. Check runtime compatibility with the newer project SDK explicitly.
    assert.equal(JSON.parse(await readFile(projectManifestPath, 'utf8')).version, '1.0.3', `Unexpected project peer: ${peer}`);
    assert.equal(await realpath(path.join(packageDir, 'node_modules', peer, 'package.json')),
      await realpath(projectManifestPath), `Suite must use this project's peer: ${peer}`);
  }
  assert.equal(await realpath(path.join(packageDir, 'node_modules', 'typebox')),
    await realpath(new URL('../../node_modules/typebox', import.meta.url)), 'Suite must use this project\'s typebox');
  const home = process.env.HOME;
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const suiteDir = process.env.PI_AGENT_SUITE_DIR;
  const offline = process.env.PI_OFFLINE;
  const previousPath = process.env.PATH;
  const projectBin = new URL('../../node_modules/.bin/', import.meta.url);
  const piManifestUrl = new URL('../../node_modules/@earendil-works/pi-coding-agent/package.json', import.meta.url);
  const piManifest = JSON.parse(await readFile(piManifestUrl, 'utf8'));
  assert.equal(await realpath(new URL('pi', projectBin)),
    await realpath(new URL(piManifest.bin.pi, piManifestUrl)),
    'Suite children must use this project\'s Pi CLI');
  const root = await mkdtemp('/tmp/pi-web-suite-smoke-');
  const requests: { url: string | undefined; model: unknown }[] = [];
  const server = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      requests.push({ url: request.url, model: payload.model });
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions' || payload.model !== 'smoke-1') {
        response.writeHead(400).end('Unexpected fake-provider request');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'smoke-completion', model: 'smoke-1', choices: [{ index: 0, delta: { content: 'CHILD_SMOKE_DONE' }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: 'smoke-completion', model: 'smoke-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  // A smoke run can itself execute inside a suite child. Do not inherit its worker identity or tool policy.
  const childEnv = Object.entries(process.env).filter(([name]) => name.startsWith('PI_SUBAGENT_') || name === 'PI_AGENT_SUITE_CHILD_AGENT_PROCESS');
  for (const [name] of childEnv) delete process.env[name];
  const bridge = new PiBridge();
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  t.after(async () => {
    try {
      if (session) await (bridge as any).disposeCachedSession(session);
      await bridge.dispose();
    } finally {
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
      if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = agentDir;
      if (suiteDir === undefined) delete process.env.PI_AGENT_SUITE_DIR;
      else process.env.PI_AGENT_SUITE_DIR = suiteDir;
      if (offline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = offline;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      for (const [name, value] of childEnv) process.env[name] = value;
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
  process.env.PI_AGENT_SUITE_DIR = path.join(root, 'agent', 'agent-suite');
  process.env.PI_OFFLINE = '1';
  // The published suite spawns "pi" from PATH. Do not test an unrelated global install.
  process.env.PATH = `${fileURLToPath(projectBin)}${path.delimiter}${previousPath ?? ''}`;
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  await writeFile(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({
    providers: { smoke: {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'local-smoke-only',
      models: [{ id: 'smoke-1', name: 'Smoke', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }],
    } },
  }));
  const cwd = path.join(root, 'project');
  await mkdir(cwd);
  await mkdir(path.join(process.env.PI_AGENT_SUITE_DIR, 'agent-selection', 'agents'), { recursive: true });
  await writeFile(path.join(process.env.PI_AGENT_SUITE_DIR, 'agent-selection', 'agents', 'SmokeAgent.md'),
    '---\ndescription: Local smoke agent\ntype: main\n---\nSmoke test only.\n');
  await writeFile(path.join(process.env.PI_AGENT_SUITE_DIR, 'agent-selection', 'agents', 'SmokeChild.md'),
    '---\ndescription: Local child smoke agent\ntype: subagent\n---\nReturn the local provider response.\n');
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
    noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    additionalExtensionPaths: [packageDir],
  });
  await resourceLoader.reload();
  const loaded = resourceLoader.getExtensions();
  assert.deepEqual(loaded.errors, [], `Suite extension load errors:\n${JSON.stringify(loaded.errors, null, 2)}`);
  const expectedPaths = manifest.pi.extensions.map((entry: string) => path.join(packageDir, entry));
  assert.equal(loaded.extensions.length, expectedPaths.length, 'Expected only published suite extensions');
  for (const extensionPath of expectedPaths) {
    assert.ok(loaded.extensions.some((extension: { path: string }) => extension.path === extensionPath),
      `Published extension not loaded: ${extensionPath}`);
  }
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(process.env.PI_CODING_AGENT_DIR, 'auth.json'), modelsPath: path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), allowModelNetwork: false });
  const model = modelRuntime.getModel('smoke', 'smoke-1');
  assert.ok(model, `Local model not loaded: ${modelRuntime.getError()}`);
  ({ session } = await createAgentSession({
    cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager, resourceLoader, modelRuntime, model,
    sessionManager: SessionManager.inMemory(cwd),
  }));
  const sessionId = 'suite-smoke';
  const key = `project:${sessionId}`;
  const cacheKey = (bridge as any).runtimeSessionCacheKey(cwd, sessionId);
  (bridge as any).setCachedSession((bridge as any).runtimeSessions, cwd, cacheKey, Promise.resolve(session));
  const events: any[] = [];
  const socket = { readyState: 1, send: (payload: string) => events.push(JSON.parse(payload)), on: () => undefined };
  bridge.subscribe(key, socket);
  const status = await bridge.status(cwd, sessionId, key);
  assert.deepEqual(session.extensionRunner?.getCommandDiagnostics(), []);
  assert.equal(events.some(({ type }) => type === 'agent:error'), false,
    `Bridge extension errors: ${JSON.stringify(events.filter(({ type }) => type === 'agent:error'), null, 2)}`);
  assert.equal(events.some(({ type, data }) => type === 'agent:notice' && data?.level === 'error'), false,
    `Bridge extension diagnostics: ${JSON.stringify(events, null, 2)}`);
  assert.equal(status.statuses.some(({ text }) => /extension.*fail|extension.*error/i.test(text)), false,
    `Bridge status diagnostics: ${JSON.stringify(status.statuses, null, 2)}`);

  for (const name of ['subagent_start', 'subagent_steer', 'subagent_wait', 'subagent_query', 'workflow_activate']) {
    assert.ok(session.getAllTools().some((tool) => tool.name === name), `Missing suite tool: ${name}`);
  }
  for (const name of ['agent', 'mcp-refresh', 'ask']) {
    assert.ok(session.extensionRunner?.getCommand(name), `Missing RPC command: /${name}`);
  }
  assert.equal(session.extensionRunner?.getCommand('subagents'), undefined, '/subagents is TUI-only');
  assert.equal(session.extensionRunner?.getCommand('usage'), undefined, '/usage is TUI-only');

  await bridge.prompt(cwd, { sessionId, prompt: '/agent SmokeAgent' }, key);
  const statePath = path.join(process.env.PI_AGENT_SUITE_DIR, 'agent-selection', 'state',
    `${createHash('sha256').update(path.resolve(cwd)).digest('hex')}.json`);
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), { cwd, activeAgentId: 'SmokeAgent' });

  // The real suite's /agent menu uses ctx.ui.custom. Attach a browser-side controller.
  const menu = bridge.prompt(cwd, { sessionId, prompt: '/agent' }, key);
  await waitFor(() => events.some(({ type }) => type === 'agent:ui-custom-start'));
  const id = events.find(({ type }) => type === 'agent:ui-custom-start').data.id;
  bridge.handleExtensionCustomUiMessage(key, socket, { type: 'agent:ui-custom-attach', id, cols: 100, rows: 25 });
  await waitFor(() => events.some(({ type, data }) => type === 'agent:ui-custom-data' && data?.ansi?.includes('SmokeAgent')));
  const epoch = events.find(({ type }) => type === 'agent:ui-custom-ready').data.epoch;
  bridge.handleExtensionCustomUiMessage(key, socket, { type: 'agent:ui-custom-input', id, epoch, data: '\u001b' });
  await menu;
  assert.ok(events.some(({ type }) => type === 'agent:ui-custom-end'));
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).activeAgentId, 'SmokeAgent');
  assert.equal(events.some(({ type }) => type === 'agent:error'), false,
    `Suite runtime errors: ${JSON.stringify(events.filter(({ type }) => type === 'agent:error'), null, 2)}`);

  // Call the published tool definitions, not a mock coordinator. The suite spawns its real Pi RPC worker.
  const runner = session.extensionRunner;
  assert.ok(runner);
  const start = runner.getToolDefinition('subagent_start');
  const wait = runner.getToolDefinition('subagent_wait');
  assert.ok(start && wait);
  const started = await start.execute('smoke-start', {
    agentId: 'SmokeChild', taskName: 'Local child completion', prompt: 'Return the provider response.',
  }, undefined, undefined, (runner as any).createToolContext('smoke-start'));
  const acceptance = JSON.parse(started.content.find((item) => item.type === 'text')?.text ?? 'null');
  assert.equal(acceptance.outcome, 'accepted', JSON.stringify(started));
  assert.ok(Number.isInteger(acceptance.sessionId) && acceptance.sessionId > 0);
  const finished = await wait.execute('smoke-wait', { sessionIds: [acceptance.sessionId], timeout: 30 },
    undefined, undefined, (runner as any).createToolContext('smoke-wait'));
  const feedback = JSON.parse(finished.content.find((item) => item.type === 'text')?.text ?? 'null');
  assert.deepEqual({ outcome: feedback.outcome, sessionId: feedback.sessionId, status: feedback.status, output: feedback.output },
    { outcome: 'feedback', sessionId: acceptance.sessionId, status: 'success', output: 'CHILD_SMOKE_DONE' },
    `Child failed: ${JSON.stringify(finished)}; provider requests: ${JSON.stringify(requests)}`);
  assert.equal(finished.details?.feedback?.status, 'success');
  assert.equal(finished.details?.feedback?.output, 'CHILD_SMOKE_DONE');
  assert.deepEqual(requests, [{ url: '/v1/chat/completions', model: 'smoke-1' }]);
  assert.equal(events.some(({ type }) => type === 'agent:error'), false,
    `Suite child errors: ${JSON.stringify(events.filter(({ type }) => type === 'agent:error'), null, 2)}`);
  console.log(`Loaded ${expectedPaths.length} published extensions; checked suite tools, RPC commands, /agent UI and real child feedback.`);
});

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for suite UI event');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
