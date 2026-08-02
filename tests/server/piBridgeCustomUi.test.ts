import assert from 'node:assert/strict';
import test from 'node:test';
import { PiBridge } from '../../src/server/piBridge.ts';

type SocketMessage = { type?: string; data?: { id?: string; epoch?: number; seq?: number; ansi?: string; occupied?: boolean } };

function testSocket(messages: SocketMessage[]) {
  const closeListeners: Array<() => void> = [];
  return {
    readyState: 1,
    send(data: string) {
      messages.push(JSON.parse(data) as SocketMessage);
    },
    close() {
      for (const listener of closeListeners) listener();
    },
    on(event: 'close' | 'message', listener: () => void) {
      if (event === 'close') closeListeners.push(listener);
    },
  };
}

test('custom extension UI renders through a real TUI and settles from browser input', async () => {
  const bridge = new PiBridge();
  const session = {};
  const streamKey = 'project:session';
  const messages: SocketMessage[] = [];
  const socket = testSocket(messages);
  bridge.subscribe(streamKey, socket);
  (bridge as any).sessionStreamKeys.set(session, streamKey);
  const context = (bridge as any).webUiContext(session, '/tmp/project', 'session');
  let receivedTui: unknown;
  let receivedTheme: unknown;
  let receivedKeybindings: unknown;
  let disposed = 0;

  const result = context.custom((tui: unknown, theme: unknown, keybindings: unknown, done: (value: string) => void) => {
    receivedTui = tui;
    receivedTheme = theme;
    receivedKeybindings = keybindings;
    return {
      render: () => ['Custom UI ready'],
      invalidate: () => undefined,
      handleInput: (data: string) => {
        if (data === '\r') done('accepted');
      },
      dispose: () => { disposed += 1; },
    };
  });

  await waitFor(() => messages.some(({ type }) => type === 'agent:ui-custom-start'));
  const id = messages.find(({ type }) => type === 'agent:ui-custom-start')?.data?.id;
  assert.equal(typeof id, 'string');
  bridge.handleExtensionCustomUiMessage(streamKey, socket, { type: 'agent:ui-custom-attach', id, cols: 100, rows: 20 });
  await waitFor(() => messages.some(({ type, data }) => type === 'agent:ui-custom-data' && data?.ansi?.includes('Custom UI ready')));
  const epoch = messages.find(({ type }) => type === 'agent:ui-custom-ready')?.data?.epoch;
  assert.equal(typeof epoch, 'number');
  bridge.handleExtensionCustomUiMessage(streamKey, socket, { type: 'agent:ui-custom-input', id, epoch, data: '\r' });

  assert.equal(await result, 'accepted');
  assert.equal(bridge.handleExtensionCustomUiMessage(streamKey, socket, { type: 'agent:ui-custom-ack', id, epoch, seq: 1 }), true);
  assert.equal(bridge.handleExtensionCustomUiMessage(streamKey, socket, { type: 'agent:ui-custom-keepalive', id }), true);
  assert.equal(messages.some(({ type }) => type === 'error'), false);
  assert.ok(receivedTui);
  assert.ok(receivedTheme);
  assert.ok(receivedKeybindings);
  assert.equal(disposed, 1);
  assert.equal(messages.filter(({ type }) => type === 'agent:ui-custom-end').length, 1);
  await bridge.dispose();
});

test('custom extension UI suppresses differential output until a dropped frame is redrawn', async () => {
  const bridge = new PiBridge();
  const session = {};
  const streamKey = 'project:backpressure';
  const messages: SocketMessage[] = [];
  const socket = testSocket(messages);
  bridge.subscribe(streamKey, socket);
  (bridge as any).sessionStreamKeys.set(session, streamKey);
  const context = (bridge as any).webUiContext(session, '/tmp/project', 'backpressure');
  void context.custom(() => ({ render: () => ['backpressure'], invalidate: () => undefined }));

  await waitFor(() => messages.some(({ type }) => type === 'agent:ui-custom-start'));
  const id = messages.find(({ type }) => type === 'agent:ui-custom-start')?.data?.id;
  bridge.handleExtensionCustomUiMessage(streamKey, socket, { type: 'agent:ui-custom-attach', id, cols: 80, rows: 20 });
  await waitFor(() => messages.some(({ type }) => type === 'agent:ui-custom-data'));
  const pending = (bridge as any).pendingExtensionCustomUi.get(id);
  const initialSeq = pending.seq;
  bridge.handleExtensionCustomUiMessage(streamKey, socket, { type: 'agent:ui-custom-ack', id, epoch: pending.epoch, seq: initialSeq });

  for (let index = 0; index < 4; index += 1) pending.writer('a'.repeat(225 * 1024));
  const sentBeforeDrop = messages.filter(({ type }) => type === 'agent:ui-custom-data').length;
  pending.writer('b'.repeat(200 * 1024));
  assert.equal(pending.needsRedraw, true);
  assert.equal(messages.filter(({ type }) => type === 'agent:ui-custom-data').length, sentBeforeDrop);

  bridge.handleExtensionCustomUiMessage(streamKey, socket, { type: 'agent:ui-custom-ack', id, epoch: pending.epoch, seq: initialSeq + 1 });
  pending.writer('c'.repeat(50 * 1024));
  assert.equal(messages.filter(({ type }) => type === 'agent:ui-custom-data').length, sentBeforeDrop);
  assert.equal(pending.needsRedraw, true);

  bridge.handleExtensionCustomUiMessage(streamKey, socket, { type: 'agent:ui-custom-ack', id, epoch: pending.epoch, seq: initialSeq + 2 });
  await waitFor(() => messages.filter(({ type }) => type === 'agent:ui-custom-data').length > sentBeforeDrop);
  assert.equal(pending.needsRedraw, false);
  await bridge.dispose();
});

test('custom extension UI fails safely when a component render throws', async () => {
  const bridge = new PiBridge();
  const session = {};
  const streamKey = 'project:render-error';
  const messages: SocketMessage[] = [];
  const socket = testSocket(messages);
  bridge.subscribe(streamKey, socket);
  (bridge as any).sessionStreamKeys.set(session, streamKey);
  const context = (bridge as any).webUiContext(session, '/tmp/project', 'render-error');
  const result = context.custom(() => ({
    render: () => { throw new Error('render exploded'); },
    invalidate: () => undefined,
  }));
  const rejected = assert.rejects(result, /render exploded/);

  await waitFor(() => messages.some(({ type }) => type === 'agent:ui-custom-start'));
  const id = messages.find(({ type }) => type === 'agent:ui-custom-start')?.data?.id;
  bridge.handleExtensionCustomUiMessage(streamKey, socket, { type: 'agent:ui-custom-attach', id, cols: 80, rows: 20 });

  await rejected;
  assert.equal(messages.filter(({ type }) => type === 'agent:ui-custom-end').length, 1);
  await bridge.dispose();
});

test('custom extension UI rejects over-width render output without crashing the process', async () => {
  const bridge = new PiBridge();
  const session = {};
  const streamKey = 'project:wide-render';
  const messages: SocketMessage[] = [];
  const socket = testSocket(messages);
  bridge.subscribe(streamKey, socket);
  (bridge as any).sessionStreamKeys.set(session, streamKey);
  const context = (bridge as any).webUiContext(session, '/tmp/project', 'wide-render');
  const result = context.custom(() => ({ render: (width: number) => ['x'.repeat(width + 1)], invalidate: () => undefined }));
  const rejected = assert.rejects(result, /wider than the available terminal width/);

  await waitFor(() => messages.some(({ type }) => type === 'agent:ui-custom-start'));
  const id = messages.find(({ type }) => type === 'agent:ui-custom-start')?.data?.id;
  bridge.handleExtensionCustomUiMessage(streamKey, socket, { type: 'agent:ui-custom-attach', id, cols: 80, rows: 20 });

  await rejected;
  assert.equal(messages.filter(({ type }) => type === 'agent:ui-custom-end').length, 1);
  await bridge.dispose();
});

test('custom extension UI fails safely when a component key-release getter throws', async () => {
  const bridge = new PiBridge();
  const session = {};
  const streamKey = 'project:key-release-error';
  const messages: SocketMessage[] = [];
  const socket = testSocket(messages);
  bridge.subscribe(streamKey, socket);
  (bridge as any).sessionStreamKeys.set(session, streamKey);
  const context = (bridge as any).webUiContext(session, '/tmp/project', 'key-release-error');
  const result = context.custom(() => ({
    get wantsKeyRelease() { throw new Error('key release exploded'); },
    render: () => ['key release'],
    invalidate: () => undefined,
  }));
  const rejected = assert.rejects(result, /key release exploded/);

  await waitFor(() => messages.some(({ type }) => type === 'agent:ui-custom-start'));
  const id = messages.find(({ type }) => type === 'agent:ui-custom-start')?.data?.id;
  bridge.handleExtensionCustomUiMessage(streamKey, socket, { type: 'agent:ui-custom-attach', id, cols: 80, rows: 20 });
  await waitFor(() => messages.some(({ type }) => type === 'agent:ui-custom-ready'));
  const pending = (bridge as any).pendingExtensionCustomUi.get(id);
  void pending.tui.focusedComponent.wantsKeyRelease;

  await rejected;
  assert.equal(messages.filter(({ type }) => type === 'agent:ui-custom-end').length, 1);
  await bridge.dispose();
});

test('custom extension UI rejects invalid component render output', async () => {
  const bridge = new PiBridge();
  const session = {};
  const streamKey = 'project:invalid-render';
  const messages: SocketMessage[] = [];
  const socket = testSocket(messages);
  bridge.subscribe(streamKey, socket);
  (bridge as any).sessionStreamKeys.set(session, streamKey);
  const context = (bridge as any).webUiContext(session, '/tmp/project', 'invalid-render');
  const result = context.custom(() => ({ render: () => undefined, invalidate: () => undefined }));
  const rejected = assert.rejects(result, /array of strings/);

  await waitFor(() => messages.some(({ type }) => type === 'agent:ui-custom-start'));
  const id = messages.find(({ type }) => type === 'agent:ui-custom-start')?.data?.id;
  bridge.handleExtensionCustomUiMessage(streamKey, socket, { type: 'agent:ui-custom-attach', id, cols: 80, rows: 20 });

  await rejected;
  assert.equal(messages.filter(({ type }) => type === 'agent:ui-custom-end').length, 1);
  await bridge.dispose();
});

test('custom extension UI cleans up an overlay whose initial visibility check throws', async () => {
  const bridge = new PiBridge();
  const session = {};
  (bridge as any).sessionStreamKeys.set(session, 'project:overlay-error');
  const context = (bridge as any).webUiContext(session, '/tmp/project', 'overlay-error');
  let receivedHandle = false;
  const result = context.custom(() => ({ render: () => ['overlay'], invalidate: () => undefined }), {
    overlay: true,
    overlayOptions: { visible: () => { throw new Error('visibility exploded'); } },
    onHandle: () => { receivedHandle = true; },
  });

  await assert.rejects(result, /visibility exploded/);
  assert.equal(receivedHandle, false);
  assert.equal((bridge as any).pendingExtensionCustomUi.size, 0);
  await bridge.dispose();
});

test('custom extension UI ignores a cold creation cancelled before runtime loading finishes', async () => {
  const bridge = new PiBridge();
  const session = {};
  let releaseRuntime!: (runtime: unknown) => void;
  (bridge as any).loadCustomUiRuntime = () => new Promise((resolve) => { releaseRuntime = resolve; });
  const context = (bridge as any).webUiContext(session, '/tmp/project', 'cold-cancel');
  const result = context.custom(() => ({ render: () => ['late'], invalidate: () => undefined }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  (bridge as any).cancelExtensionUiRequests('/tmp/project', 'cold-cancel', { session });
  releaseRuntime({ TUI: class {}, keybindings: {}, theme: {} });

  assert.equal(await result, undefined);
  assert.equal((bridge as any).pendingExtensionCustomUi.size, 0);
  await bridge.dispose();
});

test('custom extension UI can be abandoned before a browser controller attaches', async () => {
  const bridge = new PiBridge();
  const session = {};
  const streamKey = 'project:pre-attach-abandon';
  const messages: SocketMessage[] = [];
  const socket = testSocket(messages);
  bridge.subscribe(streamKey, socket);
  (bridge as any).sessionStreamKeys.set(session, streamKey);
  const context = (bridge as any).webUiContext(session, '/tmp/project', 'pre-attach-abandon');
  const result = context.custom(() => ({ render: () => ['waiting'], invalidate: () => undefined }));

  await waitFor(() => messages.some(({ type }) => type === 'agent:ui-custom-start'));
  const id = messages.find(({ type }) => type === 'agent:ui-custom-start')?.data?.id;
  assert.equal(bridge.handleExtensionCustomUiMessage(streamKey, socket, { type: 'agent:ui-custom-abandon', id }), true);

  assert.equal(await result, undefined);
  assert.equal((bridge as any).pendingExtensionCustomUi.size, 0);
  assert.equal(messages.filter(({ type }) => type === 'agent:ui-custom-end').length, 1);
  await bridge.dispose();
});

test('custom extension UI honors abandon from its controller before ready is observed', async () => {
  const bridge = new PiBridge();
  const session = {};
  const streamKey = 'project:attach-abandon';
  const messages: SocketMessage[] = [];
  const socket = testSocket(messages);
  bridge.subscribe(streamKey, socket);
  (bridge as any).sessionStreamKeys.set(session, streamKey);
  const context = (bridge as any).webUiContext(session, '/tmp/project', 'attach-abandon');
  const result = context.custom(() => ({ render: () => ['waiting'], invalidate: () => undefined }));

  await waitFor(() => messages.some(({ type }) => type === 'agent:ui-custom-start'));
  const id = messages.find(({ type }) => type === 'agent:ui-custom-start')?.data?.id;
  bridge.handleExtensionCustomUiMessage(streamKey, socket, { type: 'agent:ui-custom-attach', id, cols: 80, rows: 20 });
  assert.equal(bridge.handleExtensionCustomUiMessage(streamKey, socket, { type: 'agent:ui-custom-abandon', id }), true);

  assert.equal(await result, undefined);
  assert.equal((bridge as any).pendingExtensionCustomUi.size, 0);
  assert.equal(messages.filter(({ type }) => type === 'agent:ui-custom-end').length, 1);
  await bridge.dispose();
});

test('custom extension UI rejects live controller takeover and recovers after disconnect', async () => {
  const bridge = new PiBridge();
  const session = {};
  const streamKey = 'project:controller';
  const firstMessages: SocketMessage[] = [];
  const secondMessages: SocketMessage[] = [];
  const firstSocket = testSocket(firstMessages);
  const secondSocket = testSocket(secondMessages);
  bridge.subscribe(streamKey, firstSocket);
  bridge.subscribe(streamKey, secondSocket);
  (bridge as any).sessionStreamKeys.set(session, streamKey);
  const context = (bridge as any).webUiContext(session, '/tmp/project', 'controller');
  void context.custom(() => ({ render: () => ['controller'], invalidate: () => undefined }));

  await waitFor(() => firstMessages.some(({ type }) => type === 'agent:ui-custom-start'));
  const id = firstMessages.find(({ type }) => type === 'agent:ui-custom-start')?.data?.id;
  const pending = (bridge as any).pendingExtensionCustomUi.get(id);
  assert.ok(pending.detachTimer);
  bridge.handleExtensionCustomUiMessage(streamKey, firstSocket, { type: 'agent:ui-custom-attach', id, cols: 80, rows: 20 });
  assert.equal(pending.detachTimer, undefined);
  bridge.handleExtensionCustomUiMessage(streamKey, secondSocket, { type: 'agent:ui-custom-attach', id, cols: 80, rows: 20 });
  assert.equal(pending.controller, firstSocket);
  assert.equal(secondMessages.some(({ type, data }) => type === 'agent:ui-custom-end' && data?.occupied === true), true);

  const startsBeforeDisconnect = secondMessages.filter(({ type }) => type === 'agent:ui-custom-start').length;
  firstSocket.close();
  await waitFor(() => secondMessages.filter(({ type }) => type === 'agent:ui-custom-start').length > startsBeforeDisconnect);
  assert.ok(pending.detachTimer);
  bridge.handleExtensionCustomUiMessage(streamKey, secondSocket, { type: 'agent:ui-custom-attach', id, cols: 80, rows: 20 });
  assert.equal(pending.controller, secondSocket);
  assert.equal(pending.detachTimer, undefined);
  await bridge.dispose();
});

test('custom extension UI disposes a component returned after synchronous completion', async () => {
  const bridge = new PiBridge();
  const session = {};
  (bridge as any).sessionStreamKeys.set(session, 'project:sync-done');
  const context = (bridge as any).webUiContext(session, '/tmp/project', 'sync-done');
  let disposed = 0;

  const result = await context.custom((_tui: unknown, _theme: unknown, _keybindings: unknown, done: (value: string) => void) => {
    done('first');
    done('second');
    return { render: () => ['late'], invalidate: () => undefined, dispose: () => { disposed += 1; } };
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result, 'first');
  assert.equal(disposed, 1);
  assert.equal((bridge as any).pendingExtensionCustomUi.size, 0);
  await bridge.dispose();
});

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for custom UI event');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
