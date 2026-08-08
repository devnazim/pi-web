import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { processGroupExists, registerTerminalRoutes, resizeTerminalSession, signalProcessGroup } from '../../src/server/terminal.js';

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

test('flushes pending output before acknowledging an unchanged terminal size', () => {
  const messages: Array<{ type?: string; data?: string }> = [];
  let resizeCalls = 0;
  const socket = {
    readyState: 1,
    send: (data: string) => messages.push(JSON.parse(data) as { type?: string; data?: string }),
    close: () => undefined,
    on: () => undefined,
  };
  const session = {
    projectId: 'project-1',
    terminal: { resize: () => { resizeCalls += 1; } },
    sockets: new Set([socket]),
    pendingOutput: [{ data: 'pending', replay: false }],
    pendingDataLength: 7,
    cols: 80,
    rows: 24,
    flowControlSocket: socket,
    sentDataOffset: 0,
    acknowledgedDataOffset: 0,
  } as never;

  resizeTerminalSession(session, 80, 24);

  assert.equal(resizeCalls, 0);
  assert.equal(messages[0]?.type, 'data');
  assert.equal(messages[0]?.data, 'pending');
});

test('clamps terminal dimensions and reports the accepted grid', async () => {
  const app = Fastify();
  await app.register(websocket);
  await registerTerminalRoutes(app, {
    getOrAdd: () => ({ id: 'project-1', path: process.cwd() }),
  } as never);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const socket = new WebSocket(`${address.replace(/^http/, 'ws')}/ws/projects/project-1/terminal?cols=2&rows=1`);
  const messages: Array<{ type?: string; cols?: number; rows?: number; resizeId?: number }> = [];
  socket.addEventListener('message', (event) => {
    messages.push(JSON.parse(String(event.data)) as { type?: string; cols?: number; rows?: number; resizeId?: number });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('Terminal WebSocket failed')), { once: true });
    });
    assert.equal(await waitUntil(() => messages.some(({ type }) => type === 'ready'), 1_000), true);
    const ready = messages.find(({ type }) => type === 'ready');
    assert.equal(ready?.cols, 20);
    assert.equal(ready?.rows, 5);

    socket.send(JSON.stringify({ type: 'resize', cols: 1_000, rows: 1_000, resizeId: 7 }));
    assert.equal(await waitUntil(() => messages.some(({ type, resizeId }) => type === 'resized' && resizeId === 7), 1_000), true);
    assert.deepEqual(messages.find(({ type, resizeId }) => type === 'resized' && resizeId === 7), {
      type: 'resized',
      cols: 500,
      rows: 200,
      resizeId: 7,
    });
  } finally {
    socket.close();
    await app.close();
  }
});

test('a reconnect separates a carried query from a new live query', { skip: process.platform === 'win32' }, async () => {
  const app = Fastify();
  await app.register(websocket);
  await registerTerminalRoutes(app, {
    getOrAdd: () => ({ id: 'project-1', path: process.cwd() }),
  } as never);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `${address.replace(/^http/, 'ws')}/ws/projects/project-1/terminal`;
  const firstSocket = new WebSocket(url);
  let firstOutput = '';
  firstSocket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { type?: string; data?: string };
    if (message.type === 'data' && message.data) firstOutput += message.data;
  });
  await new Promise<void>((resolve, reject) => {
    firstSocket.addEventListener('open', () => resolve(), { once: true });
    firstSocket.addEventListener('error', () => reject(new Error('First terminal WebSocket failed')), { once: true });
  });

  firstSocket.send(JSON.stringify({ type: 'input', data: 'stty -echo\n' }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  firstSocket.send(JSON.stringify({
    type: 'input',
    data: `node -e "process.stdout.write(String.fromCharCode(27,93,52,59,49,59,63,59,50,59));setTimeout(()=>process.stdout.write(String.fromCharCode(63,7,27,91,62,99,76,73,86,69,95,68,79,78,69,10)),1000)"\n`,
  }));
  assert.equal(await waitUntil(() => firstOutput.includes('\x1b]4;1;?;2;'), 2_000), true);

  const secondSocket = new WebSocket(url);
  const secondMessages: { data: string; replay: boolean; responseQuery?: string }[] = [];
  secondSocket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { type?: string; data?: string; replay?: boolean; responseQuery?: string };
    if (message.type === 'data' && message.data) secondMessages.push({ data: message.data, replay: message.replay === true, responseQuery: message.responseQuery });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      secondSocket.addEventListener('open', () => resolve(), { once: true });
      secondSocket.addEventListener('error', () => reject(new Error('Second terminal WebSocket failed')), { once: true });
    });
    assert.equal(await waitUntil(() => secondMessages.some(({ data }) => data.includes('LIVE_DONE')), 3_000), true);
    const output = secondMessages.map(({ data }) => data).join('');
    assert.equal(output.includes('\x1b]4;1;?;2;?\x07\x1b[>cLIVE_DONE'), true, JSON.stringify(secondMessages));
    assert.equal(secondMessages.some(({ data, replay, responseQuery }) => replay && data === '\x1b]4;1;?;2;?\x07' && responseQuery === data), true);
    assert.equal(secondMessages.some(({ data, replay }) => !replay && data.includes('\x1b[>cLIVE_DONE')), true);
  } finally {
    firstSocket.close();
    secondSocket.close();
    await app.close();
  }
});

test('protocol 2 replays output with its resize boundaries and hydrates before accepting input', { skip: process.platform === 'win32' }, async () => {
  const app = Fastify();
  await app.register(websocket);
  await registerTerminalRoutes(app, {
    getOrAdd: () => ({ id: 'project-1', path: process.cwd() }),
  } as never);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const baseUrl = `${address.replace(/^http/, 'ws')}/ws/projects/project-1/terminal?protocol=2&clientId=replay-client&cols=80&rows=24`;
  const firstSocket = new WebSocket(`${baseUrl}&generation=1`);
  const firstMessages: Array<{ type?: string; data?: string; cols?: number; rows?: number; resizeId?: number; hydrated?: boolean }> = [];
  firstSocket.addEventListener('message', (event) => {
    firstMessages.push(JSON.parse(String(event.data)) as { type?: string; data?: string; cols?: number; rows?: number; resizeId?: number; hydrated?: boolean });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      firstSocket.addEventListener('open', () => resolve(), { once: true });
      firstSocket.addEventListener('error', () => reject(new Error('First terminal WebSocket failed')), { once: true });
    });
    assert.equal(await waitUntil(() => firstMessages.some(({ type }) => type === 'replay-complete'), 1_000), true);

    firstSocket.send(JSON.stringify({ type: 'input', data: "printf 'IGNORED_BEFORE_HYDRATE\\n'\n" }));
    firstSocket.send(JSON.stringify({ type: 'hydrate', resizeId: 1, cols: 80, rows: 24 }));
    assert.equal(await waitUntil(() => firstMessages.some(({ type, resizeId, hydrated }) => type === 'resized' && resizeId === 1 && hydrated), 1_000), true);

    firstSocket.send(JSON.stringify({ type: 'input', data: "printf 'BEFORE_RESIZE\\n'\n" }));
    assert.equal(await waitUntil(() => firstMessages.some(({ type, data }) => type === 'data' && data?.includes('BEFORE_RESIZE')), 2_000), true);
    firstSocket.send(JSON.stringify({ type: 'resize', resizeId: 2, cols: 100, rows: 30 }));
    assert.equal(await waitUntil(() => firstMessages.some(({ type, resizeId }) => type === 'resized' && resizeId === 2), 1_000), true);
    firstSocket.send(JSON.stringify({ type: 'input', data: "printf 'AFTER_RESIZE\\n'\n" }));
    assert.equal(await waitUntil(() => firstMessages.some(({ type, data }) => type === 'data' && data?.includes('AFTER_RESIZE')), 2_000), true);

    const secondSocket = new WebSocket(`${baseUrl}&cols=120&rows=40&generation=2`);
    const secondMessages: Array<{ type?: string; data?: string; cols?: number; rows?: number; resizeId?: number; hydrated?: boolean; replay?: boolean }> = [];
    secondSocket.addEventListener('message', (event) => {
      secondMessages.push(JSON.parse(String(event.data)) as { type?: string; data?: string; cols?: number; rows?: number; resizeId?: number; hydrated?: boolean; replay?: boolean });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        secondSocket.addEventListener('open', () => resolve(), { once: true });
        secondSocket.addEventListener('error', () => reject(new Error('Second terminal WebSocket failed')), { once: true });
      });
      assert.equal(await waitUntil(() => secondMessages.some(({ type }) => type === 'replay-complete'), 1_000), true);
      const ready = secondMessages.find(({ type }) => type === 'ready');
      assert.deepEqual({ cols: ready?.cols, rows: ready?.rows }, { cols: 100, rows: 30 });

      const replayEntries = secondMessages.filter(({ type, replay }) => type === 'data' && replay === true);
      const beforeIndex = replayEntries.findIndex(({ data, cols, rows }) => cols === 80 && rows === 24 && data?.includes('BEFORE_RESIZE'));
      const afterIndex = replayEntries.findIndex(({ data, cols, rows }) => cols === 100 && rows === 30 && data?.includes('AFTER_RESIZE'));
      assert.ok(beforeIndex >= 0, JSON.stringify(replayEntries));
      assert.ok(afterIndex > beforeIndex, JSON.stringify(replayEntries));

      secondSocket.send(JSON.stringify({ type: 'input', data: "printf 'IGNORED_SECOND_HYDRATE\\n'\n" }));
      secondSocket.send(JSON.stringify({ type: 'hydrate', resizeId: 3, cols: 120, rows: 40 }));
      assert.equal(await waitUntil(() => secondMessages.some(({ type, resizeId, hydrated }) => type === 'resized' && resizeId === 3 && hydrated), 1_000), true);
      assert.deepEqual(secondMessages.find(({ type, resizeId }) => type === 'resized' && resizeId === 3), {
        type: 'resized',
        cols: 120,
        rows: 40,
        hydrated: true,
        resizeId: 3,
      });

      secondSocket.send(JSON.stringify({ type: 'input', data: "printf 'AFTER_HYDRATE\\n'\n" }));
      assert.equal(await waitUntil(() => secondMessages.some(({ type, data }) => type === 'data' && data?.includes('AFTER_HYDRATE')), 2_000), true);
      assert.equal(secondMessages.some(({ data }) => data?.includes('IGNORED_SECOND_HYDRATE')), false);
      assert.equal(secondMessages.some(({ data }) => data?.includes('IGNORED_BEFORE_HYDRATE')), false);
    } finally {
      secondSocket.close();
    }
  } finally {
    firstSocket.close();
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

test('rejects stale terminal connection generations without replacing the active controller', async () => {
  const app = Fastify();
  await app.register(websocket);
  await registerTerminalRoutes(app, {
    getOrAdd: () => ({ id: 'project-1', path: process.cwd() }),
  } as never);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const baseUrl = `${address.replace(/^http/, 'ws')}/ws/projects/project-1/terminal?protocol=2&clientId=client-a`;
  const activeSocket = new WebSocket(`${baseUrl}&generation=2`);
  let activeClosed = false;
  let activePong = false;
  activeSocket.addEventListener('close', () => { activeClosed = true; });
  activeSocket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { type?: string };
    if (message.type === 'pong') activePong = true;
  });

  try {
    await new Promise<void>((resolve, reject) => {
      activeSocket.addEventListener('open', () => resolve(), { once: true });
      activeSocket.addEventListener('error', () => reject(new Error('Active terminal WebSocket failed')), { once: true });
    });

    for (const generation of [1, 2]) {
      const staleSocket = new WebSocket(`${baseUrl}&generation=${generation}`);
      const closeCode = await new Promise<number>((resolve, reject) => {
        staleSocket.addEventListener('close', (event) => resolve(event.code), { once: true });
        staleSocket.addEventListener('error', () => reject(new Error('Stale terminal WebSocket failed before close')), { once: true });
      });
      assert.equal(closeCode, 4002);
      assert.equal(activeClosed, false);
    }

    activeSocket.send(JSON.stringify({ type: 'ping' }));
    assert.equal(await waitUntil(() => activePong, 1_000), true);

    const newerSocket = new WebSocket(`${baseUrl}&generation=3`);
    const activeCloseCode = new Promise<number>((resolve) => activeSocket.addEventListener('close', (event) => resolve(event.code), { once: true }));
    try {
      await new Promise<void>((resolve, reject) => {
        newerSocket.addEventListener('open', () => resolve(), { once: true });
        newerSocket.addEventListener('error', () => reject(new Error('Newer terminal WebSocket failed')), { once: true });
      });
      assert.equal(await activeCloseCode, 4002);
    } finally {
      newerSocket.close();
    }
  } finally {
    activeSocket.close();
    await app.close();
  }
});

test('rotates inactive terminal client generations without locking out new controllers', async () => {
  const app = Fastify();
  await app.register(websocket);
  await registerTerminalRoutes(app, {
    getOrAdd: () => ({ id: 'project-1', path: process.cwd() }),
  } as never);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const baseUrl = `${address.replace(/^http/, 'ws')}/ws/projects/project-1/terminal?protocol=2&generation=1`;

  try {
    for (let index = 0; index < 70; index += 1) {
      const socket = new WebSocket(`${baseUrl}&clientId=client-${index}`);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('message', (event) => {
          const message = JSON.parse(String(event.data)) as { type?: string };
          if (message.type === 'ready') resolve();
        });
        socket.addEventListener('close', (event) => reject(new Error(`Terminal client ${index} closed before ready with code ${event.code}`)), { once: true });
        socket.addEventListener('error', () => reject(new Error(`Terminal client ${index} failed before ready`)), { once: true });
      });
      const closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve(), { once: true }));
      socket.close();
      await closed;
    }
  } finally {
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
