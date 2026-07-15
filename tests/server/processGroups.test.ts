import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { processGroupExists, registerTerminalRoutes, signalProcessGroup } from '../../src/server/terminal.js';

async function waitUntil(check: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

test('rejects a terminal request whose body completes after shutdown starts', async () => {
  const app = Fastify();
  let finishParsing: (() => void) | undefined;
  let closing = false;
  let finishEarlierCleanup: (() => void) | undefined;
  app.addContentTypeParser('application/x-delayed', { parseAs: 'string' }, (_request, _body, done) => {
    finishParsing = () => done(null, { command: 'echo too-late' });
  });
  app.addHook('preClose', async () => { closing = true; });
  app.addHook('preClose', async () => new Promise<void>((resolve) => { finishEarlierCleanup = resolve; }));
  await registerTerminalRoutes(app, {} as never, { isClosing: () => closing });
  await app.ready();

  const responsePromise = app.inject({
    method: 'POST',
    url: '/api/projects/project-1/terminal',
    headers: { 'content-type': 'application/x-delayed' },
    payload: 'pending',
  });
  assert.equal(await waitUntil(() => Boolean(finishParsing), 1_000), true);
  const closePromise = app.close();
  assert.equal(await waitUntil(() => closing && Boolean(finishEarlierCleanup), 1_000), true);
  finishParsing?.();

  const response = await responsePromise;
  assert.equal(response.statusCode, 503);
  finishEarlierCleanup?.();
  await closePromise;
});

test('closing terminal WebSocket kills TERM-ignoring PTY descendants', { skip: process.platform === 'win32' }, async () => {
  const app = Fastify();
  await app.register(websocket);
  await registerTerminalRoutes(app, {
    getOrAdd: () => ({ id: 'project-1', path: process.cwd() }),
  } as never);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const socket = new WebSocket(`${address.replace(/^http/, 'ws')}/ws/projects/project-1/terminal`);
  const output: string[] = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { type?: string; data?: string };
    if (message.type === 'data' && message.data) output.push(message.data);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('Terminal WebSocket failed')), { once: true });
  });
  socket.send(JSON.stringify({ type: 'input', data: "(trap '' HUP TERM; while :; do sleep 1; done) & echo PTY_CHILD:$!\n" }));
  assert.equal(await waitUntil(() => /PTY_CHILD:\d+/.test(output.join('')), 2_000), true);
  const descendantPid = Number(/PTY_CHILD:(\d+)/.exec(output.join(''))?.[1]);
  assert.ok(descendantPid > 0);

  try {
    await app.close();
    assert.equal(await waitUntil(() => {
      try {
        process.kill(descendantPid, 0);
        return false;
      } catch {
        return true;
      }
    }, 2_000), true);
  } finally {
    try { process.kill(descendantPid, 'SIGKILL'); } catch { /* Already gone. */ }
    socket.close();
    await app.close().catch(() => undefined);
  }
});

test('pauses PTY output until the browser acknowledges rendered data', { skip: process.platform === 'win32' }, async () => {
  const app = Fastify();
  await app.register(websocket);
  await registerTerminalRoutes(app, {
    getOrAdd: () => ({ id: 'project-1', path: process.cwd() }),
  } as never);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const socket = new WebSocket(`${address.replace(/^http/, 'ws')}/ws/projects/project-1/terminal`);
  let output = '';
  let acknowledgeData = false;
  let latestDataOffset: number | undefined;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { type?: string; data?: string; dataOffset?: number; replay?: boolean };
    if (message.type !== 'data' || !message.data) return;
    output += message.data;
    if (Number.isSafeInteger(message.dataOffset)) latestDataOffset = message.dataOffset;
    if (acknowledgeData && message.replay !== true && Number.isSafeInteger(message.dataOffset)) {
      socket.send(JSON.stringify({ type: 'ack', dataOffset: message.dataOffset }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('Terminal WebSocket failed')), { once: true });
  });

  try {
    socket.send(JSON.stringify({
      type: 'input',
      data: `node -e "process.stdout.write('x'.repeat(500000));process.stdout.write(String.fromCharCode(70,76,79,87,95,68,79,78,69,10))"\n`,
    }));
    assert.equal(await waitUntil(() => output.length > 100_000, 2_000), true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const pausedOutputLength = output.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(output.length, pausedOutputLength);
    assert.equal(output.includes('FLOW_DONE'), false);

    assert.ok(latestDataOffset);
    socket.send(JSON.stringify({ type: 'ack', dataOffset: latestDataOffset + 1 }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(output.length, pausedOutputLength);

    acknowledgeData = true;
    socket.send(JSON.stringify({ type: 'ack', dataOffset: latestDataOffset }));
    assert.equal(await waitUntil(() => output.includes('FLOW_DONE'), 5_000), true);
  } finally {
    socket.close();
    await app.close();
  }
});

test('a new terminal connection replaces the previous browser controller', async () => {
  const app = Fastify();
  await app.register(websocket);
  await registerTerminalRoutes(app, {
    getOrAdd: () => ({ id: 'project-1', path: process.cwd() }),
  } as never);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const firstSocket = new WebSocket(`${address.replace(/^http/, 'ws')}/ws/projects/project-1/terminal`);
  await new Promise<void>((resolve, reject) => {
    firstSocket.addEventListener('open', () => resolve(), { once: true });
    firstSocket.addEventListener('error', () => reject(new Error('First terminal WebSocket failed')), { once: true });
  });
  let firstSocketCloseCode: number | undefined;
  firstSocket.addEventListener('close', (event) => { firstSocketCloseCode = event.code; }, { once: true });
  const secondSocket = new WebSocket(`${address.replace(/^http/, 'ws')}/ws/projects/project-1/terminal`);

  try {
    await new Promise<void>((resolve, reject) => {
      secondSocket.addEventListener('open', () => resolve(), { once: true });
      secondSocket.addEventListener('error', () => reject(new Error('Second terminal WebSocket failed')), { once: true });
    });
    assert.equal(await waitUntil(() => firstSocketCloseCode !== undefined, 1_000), true);
    assert.equal(firstSocketCloseCode, 4001);
  } finally {
    firstSocket.close();
    secondSocket.close();
    await app.close();
  }
});

test('signals a surviving process group after its leader exits', { skip: process.platform === 'win32' }, async () => {
  const leader = spawn('/bin/sh', ['-c', "(trap '' TERM; while :; do sleep 1; done) </dev/null >/dev/null 2>&1 & echo $!; exit 0"], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const processGroupId = leader.pid;
  assert.ok(processGroupId);
  let output = '';
  leader.stdout?.on('data', (chunk) => { output += String(chunk); });
  await once(leader, 'exit');
  const descendantPid = Number(output.trim());
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);

  try {
    assert.equal(processGroupExists(processGroupId), true);
    signalProcessGroup(processGroupId, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.doesNotThrow(() => process.kill(descendantPid, 0));

    signalProcessGroup(processGroupId, 'SIGKILL');
    assert.equal(await waitUntil(() => {
      try {
        process.kill(descendantPid, 0);
        return false;
      } catch {
        return true;
      }
    }, 2_000), true);
  } finally {
    signalProcessGroup(processGroupId, 'SIGKILL');
    try { process.kill(descendantPid, 'SIGKILL'); } catch { /* Already gone. */ }
  }
});
