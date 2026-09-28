import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxProvider, type FauxProviderHandle } from '@earendil-works/pi-ai';
import { PiBridge } from '../../src/server/piBridge.js';

async function extensionFixture(t: TestContext, factory: (pi: ExtensionAPI) => void, faux?: FauxProviderHandle, bridgeOptions: ConstructorParameters<typeof PiBridge>[0] = {}) {
  const root = await mkdtemp('/tmp/pi-web-extension-integration-');
  const previousHome = process.env.HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
  const cwd = path.join(root, 'project');
  await mkdir(cwd);
  const bridge = new PiBridge(bridgeOptions);
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  t.after(async () => {
    if (session) await (bridge as any).disposeCachedSession(session);
    await bridge.dispose();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
    noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    extensionFactories: [factory],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(root, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  if (faux) modelRuntime.registerNativeProvider(faux.provider);
  ({ session } = await createAgentSession({
    cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager, resourceLoader, modelRuntime, model: faux?.getModel(),
    sessionManager: SessionManager.inMemory(cwd),
  }));
  const sessionId = 'extension-integration';
  const key = `project:${sessionId}`;
  const cacheKey = (bridge as any).runtimeSessionCacheKey(cwd, sessionId);
  (bridge as any).setCachedSession((bridge as any).runtimeSessions, cwd, cacheKey, Promise.resolve(session));
  const events: any[] = [];
  const notifications: any[] = [];
  const socket = (messages: any[]) => ({ readyState: 1, send: (payload: string) => messages.push(JSON.parse(payload)), on: () => undefined });
  bridge.subscribe(key, socket(events));
  bridge.subscribeNotifications('project', socket(notifications));
  return { bridge, session, sessionId, cwd, key, events, notifications, resourceLoader };
}

test('real SDK delivers idle subagent feedback after a command and refreshes history without ending a run', async (t) => {
  let api!: ExtensionAPI;
  const { bridge, session, sessionId, cwd, key, events, notifications } = await extensionFixture(t, (pi) => {
    api = pi;
    pi.registerCommand('smoke', { description: 'Local command', handler: async () => undefined });
  });
  await bridge.prompt(cwd, { sessionId, prompt: '/smoke' }, key);
  events.length = 0;
  notifications.length = 0;
  api.sendMessage({ customType: 'subagents-feedback', content: 'Child finished', display: true }, { triggerTurn: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(events.filter((event) => event.type === 'agent:event' && event.data?.type === 'message_end').length, 1);
  assert.equal(events.filter((event) => event.type === 'agent:history-updated').length, 1);
  assert.equal(notifications.filter((event) => event.type === 'agent:history-updated').length, 1);
  assert.equal(events.some((event) => ['agent:start', 'agent:finish', 'agent:error'].includes(event.type)), false);
  assert.equal(session.messages.some((message: any) => message.customType === 'subagents-feedback'), true);
});

test('bound event relay delivers foreground and background events once and detaches on disposal', async () => {
  const bridge = new PiBridge();
  const listeners = new Set<(event: unknown) => void>();
  let subscriptions = 0;
  let unsubscriptions = 0;
  const session = {
    subscribe: (listener: (event: unknown) => void) => {
      subscriptions += 1;
      listeners.add(listener);
      return () => { unsubscriptions += 1; listeners.delete(listener); };
    },
    bindExtensions: async () => undefined,
    dispose: () => undefined,
  };
  const events: any[] = [];
  (bridge as any).broadcast = (key: string, event: unknown) => events.push({ key, ...event as object });
  await (bridge as any).bindWebExtensions(session, '/tmp', 's', 'project:s');
  const unsubscribe = (bridge as any).subscribeSessionEvents(session, 'project:s', 's', { operationId: 'foreground' });
  for (const listener of listeners) listener({ type: 'message_start', message: { role: 'user', content: 'hi' } });
  assert.equal(events.length, 1);
  assert.equal(events[0].operationId, 'foreground');
  unsubscribe();
  await (bridge as any).bindWebExtensions(session, '/tmp', 's', 'other:s');
  for (const listener of listeners) listener({ type: 'agent_start' });
  for (const listener of listeners) listener({ type: 'message_update' });
  for (const listener of listeners) listener({ type: 'agent_settled' });
  assert.equal(events.filter((event) => event.type === 'agent:start').length, 1);
  assert.equal(events.filter((event) => event.type === 'agent:finish').length, 1);
  assert.equal(events.filter((event) => event.type === 'agent:event').length, 4);
  assert.equal(events.at(-1).key, 'other:s');
  assert.equal(subscriptions, 1);
  const staleListener = [...listeners][0];
  await (bridge as any).disposeCachedSession(session);
  assert.equal(unsubscriptions, 1);
  assert.equal(listeners.size, 0);
  const count = events.length;
  staleListener({ type: 'message_end' });
  assert.equal(events.length, count);
  await bridge.dispose();
});

for (const behavior of ['steer', 'followUp'] as const) {
  test(`real SDK ${behavior} input runs once with RPC source, including handled input`, async (t) => {
    const inputs: Array<{ text: string; source: string; streamingBehavior?: string }> = [];
    const { bridge, session, sessionId, cwd, key, events } = await extensionFixture(t, (pi) => {
      pi.on('input', (event) => {
        inputs.push(event);
        return event.text === 'handled' ? { action: 'handled' } : { action: 'transform', text: `transformed ${event.text}` };
      });
    });
    // Exercise the real queue API without starting a model request.
    (session as any)._isAgentRunActive = true;
    t.after(() => { (session as any)._isAgentRunActive = false; });
    for (const prompt of ['handled', 'hello']) {
      await bridge.prompt(cwd, { sessionId, prompt, streamingBehavior: behavior, clientMessageId: prompt }, key);
    }
    assert.deepEqual(inputs.map(({ text, source, streamingBehavior }) => ({ text, source, streamingBehavior })), [
      { text: 'handled', source: 'rpc', streamingBehavior: behavior },
      { text: 'hello', source: 'rpc', streamingBehavior: behavior },
    ]);
    const queues = events.filter((event) => event.type === 'agent:event' && event.data?.type === 'queue_update');
    assert.equal(queues.length, 1);
    assert.deepEqual(queues[0].data[behavior === 'steer' ? 'steering' : 'followUp'], ['transformed hello']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal((bridge as any).streamingDispatchTails.size, 0);
    session.clearQueue();
    (session as any)._isAgentRunActive = false;
  });
}

test('input-hook steering does not take the transformed web prompt client id', { timeout: 10_000 }, async (t) => {
  const faux = fauxProvider();
  let firstStarted!: () => void;
  let releaseFirst!: () => void;
  const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  t.after(() => { releaseFirst(); });
  faux.setResponses([
    async () => { firstStarted(); await firstGate; return fauxAssistantMessage('First answer'); },
    fauxAssistantMessage('Injected answer'),
    fauxAssistantMessage('Queued answer'),
  ]);
  const inputs: Array<{ text: string; source: string }> = [];
  const { bridge, session, sessionId, cwd, key, events } = await extensionFixture(t, (pi) => {
    pi.on('input', (event) => {
      inputs.push({ text: event.text, source: event.source });
      if (event.text === 'web prompt' && event.source === 'rpc') {
        pi.sendUserMessage('extension injected', { deliverAs: 'steer' });
        return { action: 'transform', text: 'transformed web prompt' };
      }
      return { action: 'continue' };
    });
  }, faux);
  const first = bridge.prompt(cwd, { sessionId, prompt: 'first' }, key);
  await firstReady;
  await bridge.prompt(cwd, { sessionId, prompt: 'web prompt', streamingBehavior: 'steer', clientMessageId: 'web-client' }, key);
  releaseFirst();
  await first;

  assert.deepEqual(inputs.filter(({ text }) => text === 'web prompt'), [{ text: 'web prompt', source: 'rpc' }]);
  const injected = events.filter((event) => event.data?.type === 'message_start' && event.data.message?.role === 'user'
    && event.data.message.content[0]?.text === 'extension injected');
  const transformed = events.filter((event) => event.data?.type === 'message_start' && event.data.message?.role === 'user'
    && event.data.message.content[0]?.text === 'transformed web prompt');
  assert.equal(injected.length, 1);
  assert.equal(injected[0].data.clientMessageId, undefined);
  assert.equal(transformed.length, 1);
  assert.equal(transformed[0].data.clientMessageId, 'web-client');
  assert.equal(events.filter((event) => event.data?.clientMessageId === 'web-client').length, 1);
  assert.deepEqual(session.getSteeringMessages(), []);
});

test('real SDK extension load errors remain visible in status and clear after a successful reload', async (t) => {
  let broken = true;
  const { bridge, session, sessionId, cwd, key, events } = await extensionFixture(t, (pi) => {
    pi.registerCommand('healthy', { description: 'Still available', handler: async () => undefined });
    if (broken) throw new Error('suite import failed');
  });
  await (bridge as any).bindWebExtensions(session, cwd, sessionId, key);
  assert.ok(events.some((event) => event.type === 'agent:notice' && event.data?.level === 'error' && event.message.includes('suite import failed')));
  events.length = 0;
  // Polling status after the original load keeps the diagnostic available.
  const status = await bridge.status(cwd, sessionId, key);
  assert.ok(status.statuses.some(({ text }) => text.includes('suite import failed')));
  await bridge.reload(cwd, { sessionId }, key);
  assert.ok(events.some((event) => event.type === 'agent:notice' && event.data?.level === 'warning' && event.message.includes('some extensions failed')));
  assert.equal(events.some((event) => event.message === 'Reloaded extensions, skills, prompts, themes, settings, and context files.'), false);
  broken = false;
  events.length = 0;
  await bridge.reload(cwd, { sessionId }, key);
  assert.equal((await bridge.status(cwd, sessionId, key)).statuses.some(({ text }) => text.includes('suite import failed')), false);
  assert.ok(events.some((event) => event.message === 'Reloaded extensions, skills, prompts, themes, settings, and context files.'));
  assert.ok(session.extensionRunner?.getCommand('healthy'));
});

for (const outcome of ['success', 'error', 'cancelled'] as const) {
  test(`background manual compaction ${outcome} clears activity before idle feedback and the next run`, async (t) => {
    const { bridge, session, sessionId, cwd, key, events } = await extensionFixture(t, () => undefined);
    await (bridge as any).bindWebExtensions(session, cwd, sessionId, key);
    (session as any)._emit({ type: 'compaction_start', reason: 'manual' });
    (session as any)._emit({ type: 'compaction_end', reason: 'manual', aborted: outcome === 'cancelled', willRetry: false, ...(outcome === 'error' ? { errorMessage: 'Summary failed' } : {}) });
    const terminal = events.find((event) => event.type === (outcome === 'success' ? 'agent:finish' : 'agent:error'));
    assert.ok(terminal);
    assert.equal(terminal.message, outcome === 'error' ? 'Summary failed' : outcome === 'cancelled' ? 'Compaction cancelled' : undefined);
    events.length = 0;
    await session.sendCustomMessage({ customType: 'subagents-feedback', content: 'Child finished', display: true }, { triggerTurn: false });
    assert.equal(events.filter((event) => event.type === 'agent:history-updated').length, 1);
    (session as any)._emit({ type: 'agent_start' });
    const start = events.find((event) => event.type === 'agent:start');
    assert.ok(start);
    assert.notEqual(start.operationId, terminal.operationId);
    (session as any)._emit({ type: 'agent_settled' });
    assert.equal(events.filter((event) => event.type === 'agent:finish').length, 1);
  });
}

for (const cancelled of [false, true]) {
  test(`foreground compaction ${cancelled ? 'cancellation' : 'success'} clears an interrupted background run`, async (t) => {
    const { bridge, session, sessionId, cwd, key, events } = await extensionFixture(t, () => undefined);
    await (bridge as any).bindWebExtensions(session, cwd, sessionId, key);
    (session as any)._isAgentRunActive = true;
    (session as any)._emit({ type: 'agent_start' });
    (session as any)._emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'Old background failure' } });
    const oldOperationId = events.find((event) => event.type === 'agent:start').operationId;
    session.compact = async () => {
      // SDK manual compaction aborts the current run before compacting.
      (session as any)._isAgentRunActive = false;
      (session as any)._emit({ type: 'agent_settled' });
      (session as any)._emit({ type: 'compaction_start', reason: 'manual' });
      (session as any)._emit({ type: 'compaction_end', reason: 'manual', aborted: cancelled, willRetry: false });
      if (cancelled) throw new Error('Compaction cancelled');
      return {} as any;
    };
    const compaction = bridge.compact(cwd, { sessionId }, key);
    if (cancelled) await assert.rejects(compaction, /Compaction cancelled/);
    else await compaction;
    events.length = 0;
    await session.sendCustomMessage({ customType: 'subagents-feedback', content: 'Child finished', display: true }, { triggerTurn: false });
    assert.equal(events.filter((event) => event.type === 'agent:history-updated').length, 1);
    (session as any)._emit({ type: 'agent_start' });
    (session as any)._emit({ type: 'agent_settled' });
    const start = events.find((event) => event.type === 'agent:start');
    assert.ok(start);
    assert.notEqual(start.operationId, oldOperationId);
    assert.equal(events.filter((event) => event.type === 'agent:finish').length, 1);
    assert.equal(events.filter((event) => event.type === 'agent:error').length, 0);
  });
}

for (const navigationFinishesFirst of [false, true]) {
  for (const responseFails of [false, true]) {
    test(`tree navigation and its extension response share one lifecycle (${navigationFinishesFirst ? 'navigation' : 'response'} finishes first, ${responseFails ? 'error' : 'success'})`, { timeout: 10_000 }, async (t) => {
      const faux = fauxProvider();
      let responseStarted!: () => void;
      let releaseResponse!: () => void;
      let releaseNavigation!: () => void;
      const responseReady = new Promise<void>((resolve) => { responseStarted = resolve; });
      const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
      const navigationGate = new Promise<void>((resolve) => { releaseNavigation = resolve; });
      t.after(() => { releaseResponse(); releaseNavigation(); });
      faux.setResponses([
        fauxAssistantMessage('First answer'),
        fauxAssistantMessage('Second answer'),
        async () => {
          responseStarted();
          await responseGate;
          return responseFails
            ? fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Tree response failed' })
            : fauxAssistantMessage('Tree response');
        },
        fauxAssistantMessage('Next answer'),
      ]);
      let commandContext: any;
      const { bridge, session, sessionId, cwd, key, events } = await extensionFixture(t, (pi) => {
        pi.registerCommand('capture-tree', { description: 'Capture context', handler: async (_args, ctx) => { commandContext = ctx; } });
        pi.on('session_tree', async () => {
          pi.sendMessage({ customType: 'tree-response', content: 'Continue after navigation', display: true }, { triggerTurn: true });
          await responseReady;
          await navigationGate;
        });
      }, faux);
      await bridge.prompt(cwd, { sessionId, prompt: 'first' }, key);
      const target = session.sessionManager.getLeafId();
      await bridge.prompt(cwd, { sessionId, prompt: 'second' }, key);
      await bridge.prompt(cwd, { sessionId, prompt: '/capture-tree' }, key);
      let responseSettled!: () => void;
      const settled = new Promise<void>((resolve) => { responseSettled = resolve; });
      const unsubscribe = session.subscribe((event) => { if (event.type === 'agent_settled') responseSettled(); });
      events.length = 0;
      const navigation = commandContext.navigateTree(target, { summarize: false });
      await responseReady;
      if (navigationFinishesFirst) {
        releaseNavigation();
        await navigation;
        assert.equal(session.isStreaming, true);
      } else {
        releaseResponse();
        await settled;
        assert.equal(session.isCompacting, true);
      }
      assert.equal(events.some((event) => event.type === 'agent:finish' || event.type === 'agent:error'), false);
      releaseNavigation();
      releaseResponse();
      await Promise.all([navigation, settled]);
      unsubscribe();
      const starts = events.filter((event) => event.type === 'agent:start');
      const terminals = events.filter((event) => event.type === 'agent:finish' || event.type === 'agent:error');
      assert.equal(starts.length, 1);
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0].operationId, starts[0].operationId);
      assert.equal(terminals[0].type, responseFails ? 'agent:error' : 'agent:finish');
      if (responseFails) assert.equal(terminals[0].message, 'Tree response failed');
      await session.sendCustomMessage({ customType: 'feedback', content: 'Idle feedback', display: true }, { triggerTurn: false });
      assert.equal(events.filter((event) => event.type === 'agent:history-updated').length, 1);
      await bridge.prompt(cwd, { sessionId, prompt: 'next' }, key);
      const nextStart = events.filter((event) => event.type === 'agent:start').at(-1);
      assert.notEqual(nextStart.operationId, starts[0].operationId);
      assert.equal(events.filter((event) => event.type === 'agent:finish').at(-1).operationId, nextStart.operationId);
    });
  }
}

for (const outcome of ['success', 'error', 'cancelled'] as const) {
  test(`delayed extension tree navigation ${outcome} ends activity after summary retries`, async (t) => {
    let commandContext: any;
    const { bridge, session, sessionId, cwd, key, events } = await extensionFixture(t, (pi) => {
      pi.registerCommand('capture-tree', { description: 'Capture live context', handler: async (_args, ctx) => { commandContext = ctx; } });
    });
    await bridge.prompt(cwd, { sessionId, prompt: '/capture-tree' }, key);
    let finishNavigation!: () => void;
    const gate = new Promise<void>((resolve) => { finishNavigation = resolve; });
    session.navigateTree = async () => {
      (session as any)._emit({ type: 'summarization_retry_scheduled', attempt: 1 });
      (session as any)._emit({ type: 'summarization_retry_attempt_start', source: 'branchSummary' });
      (session as any)._emit({ type: 'summarization_retry_finished' });
      await gate;
      if (outcome === 'error') throw new Error('Branch summary failed');
      return { cancelled: outcome === 'cancelled' };
    };
    events.length = 0;
    const navigation = commandContext.navigateTree('target', { summarize: true });
    assert.equal(events.filter((event) => event.type === 'agent:start').length, 1);
    assert.equal(events.some((event) => event.type === 'agent:finish' || event.type === 'agent:error'), false);
    finishNavigation();
    if (outcome === 'error') await assert.rejects(navigation, /Branch summary failed/);
    else assert.equal((await navigation).cancelled, outcome === 'cancelled');
    const terminal = events.filter((event) => event.type === 'agent:finish' || event.type === 'agent:error');
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].type, outcome === 'success' ? 'agent:finish' : 'agent:error');
    assert.equal(terminal[0].operationId, events.find((event) => event.type === 'agent:start').operationId);
    events.length = 0;
    await session.sendCustomMessage({ customType: 'subagents-feedback', content: 'Child finished', display: true }, { triggerTurn: false });
    assert.equal(events.filter((event) => event.type === 'agent:history-updated').length, 1);
    (session as any)._emit({ type: 'agent_start' });
    (session as any)._emit({ type: 'agent_settled' });
    assert.equal(events.filter((event) => event.type === 'agent:start').length, 1);
    assert.equal(events.filter((event) => event.type === 'agent:finish').length, 1);
  });
}

for (const recovers of [false, true]) {
  test(`background assistant error ${recovers ? 'followed by recovery finishes successfully' : 'reports failure instead of success'}`, async (t) => {
    const { bridge, session, sessionId, cwd, key, events } = await extensionFixture(t, () => undefined);
    await (bridge as any).bindWebExtensions(session, cwd, sessionId, key);
    (session as any)._emit({ type: 'agent_start' });
    (session as any)._emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'Provider unavailable' } });
    if (recovers) {
      (session as any)._emit({ type: 'auto_retry_start', attempt: 1 });
      (session as any)._emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [] } });
    }
    (session as any)._emit({ type: 'agent_settled' });
    assert.equal(events.filter((event) => event.type === 'agent:finish').length, recovers ? 1 : 0);
    const errors = events.filter((event) => event.type === 'agent:error');
    assert.equal(errors.length, recovers ? 0 : 1);
    if (!recovers) assert.equal(errors[0].message, 'Provider unavailable');
  });
}

for (const behavior of ['steer', 'followUp'] as const) {
  for (const settlesDuringInput of [false, true]) {
    test(`real SDK delivers ${behavior} input ${settlesDuringInput ? 'after settlement during its hook' : 'through the active queue'}`, { timeout: 10_000 }, async (t) => {
      const faux = fauxProvider();
      let releaseFirst!: () => void;
      let firstStarted!: () => void;
      let inputStarted!: () => void;
      let releaseInput!: () => void;
      let secondStarted!: () => void;
      let releaseSecond!: () => void;
      let secondStarting!: () => void;
      let releaseSecondStart!: () => void;
      const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const inputReady = new Promise<void>((resolve) => { inputStarted = resolve; });
      const inputGate = new Promise<void>((resolve) => { releaseInput = resolve; });
      const secondReady = new Promise<void>((resolve) => { secondStarted = resolve; });
      const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
      const secondStartReady = new Promise<void>((resolve) => { secondStarting = resolve; });
      const secondStartGate = new Promise<void>((resolve) => { releaseSecondStart = resolve; });
      t.after(() => { releaseFirst(); releaseInput(); releaseSecond(); releaseSecondStart(); });
      const requests: unknown[] = [];
      faux.setResponses([
        async (context) => { requests.push(context); firstStarted(); await firstGate; return fauxAssistantMessage('First answer'); },
        async (context) => { requests.push(context); secondStarted(); await secondGate; return fauxAssistantMessage('Second answer'); },
        fauxAssistantMessage('Third answer'),
      ]);
      const inputs: Array<{ text: string; source: string }> = [];
      let sdkStarts = 0;
      const { bridge, session, sessionId, cwd, key, events } = await extensionFixture(t, (pi) => {
        pi.on('agent_start', async () => {
          if (++sdkStarts === 2 && settlesDuringInput) { secondStarting(); await secondStartGate; }
        });
        pi.on('input', async (event) => {
          inputs.push({ text: event.text, source: event.source });
          if (event.text !== 'second') return { action: 'continue' };
          inputStarted();
          if (settlesDuringInput) await inputGate;
          return { action: 'transform', text: 'transformed second' };
        });
      }, faux);
      const first = bridge.prompt(cwd, { sessionId, prompt: 'first' }, key, { operationId: 'first-run' });
      await firstReady;
      // Release the input at settlement itself, before the old bridge operation
      // necessarily finishes, to cover the foreground/background handoff.
      const unsubscribe = session.subscribe((event) => {
        if (event.type === 'agent_settled' && settlesDuringInput) releaseInput();
      });
      const second = bridge.prompt(cwd, { sessionId, prompt: 'second', streamingBehavior: behavior, clientMessageId: 'second-client' }, key, { operationId: 'second-run' });
      await inputReady;
      if (!settlesDuringInput) await second;
      releaseFirst();
      if (settlesDuringInput) {
        await secondStartReady;
        await first;
        // The replacement must release dispatch before even its start hook
        // completes, and another queued request must not count the run twice.
        await bridge.prompt(cwd, { sessionId, prompt: 'third', streamingBehavior: behavior, clientMessageId: 'third-client' }, key);
        releaseSecondStart();
      }
      await secondReady;
      releaseSecond();
      await Promise.all([first, second]);
      unsubscribe();
      assert.deepEqual(inputs.filter(({ text }) => text === 'second'), [{ text: 'second', source: 'rpc' }]);
      assert.equal(requests.length, 2);
      assert.match(JSON.stringify(requests[1]), /transformed second/);
      const delivered = events.filter((event) => event.type === 'agent:event' && event.data?.type === 'message_start' && event.data?.clientMessageId === 'second-client');
      assert.equal(delivered.length, 1);
      assert.deepEqual(delivered[0].data.message.content, [{ type: 'text', text: 'transformed second' }]);
      if (settlesDuringInput) assert.equal(events.filter((event) => event.data?.type === 'message_start' && event.data.clientMessageId === 'third-client').length, 1);
      assert.deepEqual(session.getSteeringMessages(), []);
      assert.deepEqual(session.getFollowUpMessages(), []);
      const starts = events.filter((event) => event.type === 'agent:start');
      const finishes = events.filter((event) => event.type === 'agent:finish');
      assert.equal(starts.length, settlesDuringInput ? 2 : 1);
      assert.equal(finishes.filter((event) => event.operationId === 'second-run').length, settlesDuringInput ? 1 : 0);
      const replacementStart = events.findIndex((event) => event.type === 'agent:start' && event.operationId === 'second-run');
      if (replacementStart !== -1) assert.equal(events.slice(replacementStart).some((event) => event.type === 'agent:finish' && event.operationId === 'first-run'), false);
      assert.equal(events.some((event) => event.type === 'agent:error'), false);
    });
  }
}

for (const parentSettlesFirst of [true, false]) {
  test(`an async parent settlement hook cannot finish its replacement early (${parentSettlesFirst ? 'parent' : 'replacement'} settles first)`, { timeout: 10_000 }, async (t) => {
    const faux = fauxProvider();
    let firstStarted!: () => void;
    let releaseFirst!: () => void;
    let inputStarted!: () => void;
    let releaseInput!: () => void;
    let parentSettling!: () => void;
    let releaseParent!: () => void;
    let userStarting!: () => void;
    let releaseUser!: () => void;
    const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const inputReady = new Promise<void>((resolve) => { inputStarted = resolve; });
    const inputGate = new Promise<void>((resolve) => { releaseInput = resolve; });
    const parentReady = new Promise<void>((resolve) => { parentSettling = resolve; });
    const parentGate = new Promise<void>((resolve) => { releaseParent = resolve; });
    const userReady = new Promise<void>((resolve) => { userStarting = resolve; });
    const userGate = new Promise<void>((resolve) => { releaseUser = resolve; });
    faux.setResponses([
      async () => { firstStarted(); await firstGate; return fauxAssistantMessage('First answer'); },
      fauxAssistantMessage('Second answer'),
    ]);
    let settlements = 0;
    const { bridge, session, sessionId, cwd, key, events } = await extensionFixture(t, (pi) => {
      pi.on('input', async (event) => {
        if (event.text === 'second') { inputStarted(); await inputGate; }
        return { action: 'continue' };
      });
      pi.on('agent_settled', async () => {
        if (++settlements === 1) { parentSettling(); await parentGate; }
      });
      pi.on('message_start', async (event) => {
        if (event.message.role === 'user' && JSON.stringify(event.message.content).includes('second')) {
          userStarting();
          await userGate;
        }
      });
    }, faux);
    const first = bridge.prompt(cwd, { sessionId, prompt: 'first' }, key, { operationId: 'parent' });
    await firstReady;
    const second = bridge.prompt(cwd, { sessionId, prompt: 'second', streamingBehavior: 'steer', clientMessageId: 'replacement-client' }, key, { operationId: 'replacement' });
    await inputReady;
    releaseFirst();
    await parentReady;
    releaseInput();
    await userReady;
    if (parentSettlesFirst) {
      releaseParent();
      await first;
      assert.equal(session.isStreaming, true);
    } else {
      releaseUser();
      await second;
    }
    assert.equal(events.some((event) => event.type === 'agent:finish' || event.type === 'agent:error'), false);
    releaseUser();
    releaseParent();
    await Promise.all([first, second]);
    const delivered = events.filter((event) => event.data?.type === 'message_start' && event.data.clientMessageId === 'replacement-client');
    assert.equal(delivered.length, 1);
    const finishes = events.filter((event) => event.type === 'agent:finish');
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0].operationId, 'replacement');
    assert.equal((bridge as any).sessionEventRelays.get(session).pendingAgentSettlements, 0);
  });
}

for (const parentSettlesBeforeStart of [false, true]) {
  test(`a deferred extension turn keeps activity open when the parent settles ${parentSettlesBeforeStart ? 'before' : 'after'} its start hook`, { timeout: 10_000 }, async (t) => {
    const faux = fauxProvider();
    let firstStarted!: () => void;
    let releaseFirst!: () => void;
    let inputStarted!: () => void;
    let releaseInput!: () => void;
    let parentSettling!: () => void;
    let releaseParent!: () => void;
    let thirdStarted!: () => void;
    let releaseThird!: () => void;
    let thirdStarting!: () => void;
    let releaseThirdStart!: () => void;
    const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const inputReady = new Promise<void>((resolve) => { inputStarted = resolve; });
    const inputGate = new Promise<void>((resolve) => { releaseInput = resolve; });
    const parentReady = new Promise<void>((resolve) => { parentSettling = resolve; });
    const parentGate = new Promise<void>((resolve) => { releaseParent = resolve; });
    const thirdReady = new Promise<void>((resolve) => { thirdStarted = resolve; });
    const thirdGate = new Promise<void>((resolve) => { releaseThird = resolve; });
    const thirdStartReady = new Promise<void>((resolve) => { thirdStarting = resolve; });
    const thirdStartGate = new Promise<void>((resolve) => { releaseThirdStart = resolve; });
    t.after(() => { releaseFirst(); releaseInput(); releaseParent(); releaseThird(); releaseThirdStart(); });
    faux.setResponses([
      async () => { firstStarted(); await firstGate; return fauxAssistantMessage('First answer'); },
      fauxAssistantMessage('Second answer'),
      async () => { thirdStarted(); await thirdGate; return fauxAssistantMessage('Extension answer'); },
    ]);
    let settlements = 0;
    let starts = 0;
    const { bridge, session, sessionId, cwd, key, events } = await extensionFixture(t, (pi) => {
      pi.on('input', async (event) => {
        if (event.text === 'second') { inputStarted(); await inputGate; }
        return { action: 'continue' };
      });
      pi.on('agent_settled', async () => {
        if (++settlements === 1) { parentSettling(); await parentGate; }
        else if (settlements === 2) pi.sendMessage({ customType: 'continuation', content: 'Continue', display: true }, { triggerTurn: true });
      });
      pi.on('agent_start', async () => {
        if (++starts === 3) { thirdStarting(); await thirdStartGate; }
      });
    }, faux);
    const first = bridge.prompt(cwd, { sessionId, prompt: 'first' }, key, { operationId: 'parent' });
    await firstReady;
    const second = bridge.prompt(cwd, { sessionId, prompt: 'second', streamingBehavior: 'steer', clientMessageId: 'replacement-client' }, key, { operationId: 'replacement' });
    await inputReady;
    releaseFirst();
    await parentReady;
    releaseInput();
    await thirdStartReady;
    await bridge.prompt(cwd, { sessionId, prompt: 'queued during extension start', streamingBehavior: 'steer', clientMessageId: 'queued-during-start' }, key);
    if (parentSettlesBeforeStart) {
      releaseParent();
      await first;
      assert.equal(events.some((event) => event.type === 'agent:finish' || event.type === 'agent:error'), false);
    }
    releaseThirdStart();
    await thirdReady;
    if (!parentSettlesBeforeStart) {
      releaseParent();
      await first;
    }
    assert.equal(session.isStreaming, true);
    assert.equal(events.some((event) => event.type === 'agent:finish' || event.type === 'agent:error'), false);
    releaseThird();
    await second;
    const finishes = events.filter((event) => event.type === 'agent:finish');
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0].operationId, 'replacement');
    assert.equal(events.filter((event) => event.data?.type === 'message_start' && event.data.clientMessageId === 'queued-during-start').length, 1);
    assert.equal((bridge as any).sessionEventRelays.get(session).pendingAgentSettlements, 0);
  });
}

test('parent cleanup preserves confirmation UI inside a replacement start hook', { timeout: 10_000 }, async (t) => {
  const faux = fauxProvider();
  let firstStarted!: () => void;
  let releaseFirst!: () => void;
  let inputStarted!: () => void;
  let releaseInput!: () => void;
  let parentSettling!: () => void;
  let releaseParent!: () => void;
  let confirmationStarted!: () => void;
  const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const inputReady = new Promise<void>((resolve) => { inputStarted = resolve; });
  const inputGate = new Promise<void>((resolve) => { releaseInput = resolve; });
  const parentReady = new Promise<void>((resolve) => { parentSettling = resolve; });
  const parentGate = new Promise<void>((resolve) => { releaseParent = resolve; });
  const confirmationReady = new Promise<void>((resolve) => { confirmationStarted = resolve; });
  t.after(() => { releaseFirst(); releaseInput(); releaseParent(); });
  faux.setResponses([
    async () => { firstStarted(); await firstGate; return fauxAssistantMessage('First answer'); },
    fauxAssistantMessage('Second answer'),
  ]);
  let starts = 0;
  let settlements = 0;
  let confirmed: boolean | undefined;
  const { bridge, sessionId, cwd, key, events } = await extensionFixture(t, (pi) => {
    pi.on('input', async (event) => {
      if (event.text === 'second') { inputStarted(); await inputGate; }
      return { action: 'continue' };
    });
    pi.on('agent_settled', async () => {
      if (++settlements === 1) { parentSettling(); await parentGate; }
    });
    pi.on('agent_start', async (_event, ctx) => {
      if (++starts === 2) {
        const confirmation = ctx.ui.confirm('Replacement', 'Continue?');
        confirmationStarted();
        confirmed = await confirmation;
      }
    });
  }, faux);
  const first = bridge.prompt(cwd, { sessionId, prompt: 'first' }, key);
  await firstReady;
  const second = bridge.prompt(cwd, { sessionId, prompt: 'second', streamingBehavior: 'steer', clientMessageId: 'second-client' }, key);
  await inputReady;
  releaseFirst();
  await parentReady;
  releaseInput();
  await confirmationReady;
  releaseParent();
  await first;
  assert.equal(confirmed, undefined);
  assert.equal(events.some((event) => event.type === 'agent:finish' || event.type === 'agent:error'), false);
  const requests = bridge.extensionUiRequests(cwd, sessionId);
  assert.equal(requests.length, 1);
  bridge.respondExtensionUiRequest(cwd, requests[0].id, { sessionId, confirmed: true });
  await second;
  assert.equal(confirmed, true);
  assert.equal(events.filter((event) => event.type === 'agent:finish').length, 1);
  assert.equal(events.filter((event) => event.data?.type === 'message_start' && event.data.clientMessageId === 'second-client').length, 1);
});

for (const stalls of [false, true]) {
  test(`a superseded parent observes session progress when its successor ${stalls ? 'stalls' : 'keeps streaming'}`, { timeout: 10_000 }, async (t) => {
    const faux = fauxProvider({ tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } });
    let firstStarted!: () => void;
    let releaseFirst!: () => void;
    let inputStarted!: () => void;
    let releaseInput!: () => void;
    let parentSettling!: () => void;
    let releaseParent!: () => void;
    let releaseResponse!: () => void;
    const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const inputReady = new Promise<void>((resolve) => { inputStarted = resolve; });
    const inputGate = new Promise<void>((resolve) => { releaseInput = resolve; });
    const parentReady = new Promise<void>((resolve) => { parentSettling = resolve; });
    const parentGate = new Promise<void>((resolve) => { releaseParent = resolve; });
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const keepAlive = setInterval(() => undefined, 100);
    t.after(() => { clearInterval(keepAlive); releaseFirst(); releaseInput(); releaseParent(); releaseResponse(); });
    faux.setResponses([
      async () => { firstStarted(); await firstGate; return fauxAssistantMessage('A'); },
      async () => {
        if (stalls) await responseGate;
        return fauxAssistantMessage('B'.repeat(200));
      },
    ]);
    let settlements = 0;
    const { bridge, sessionId, cwd, key, events } = await extensionFixture(t, (pi) => {
      pi.on('input', async (event) => {
        if (event.text === 'second') { inputStarted(); await inputGate; }
        return { action: 'continue' };
      });
      pi.on('agent_settled', async () => {
        if (++settlements === 1) { parentSettling(); await parentGate; }
      });
    }, faux, { runtimeNoProgressTimeoutMs: 100, runtimeWatchIntervalMs: 2 });
    const first = bridge.prompt(cwd, { sessionId, prompt: 'first' }, key);
    void first.catch(() => undefined);
    await firstReady;
    const second = bridge.prompt(cwd, { sessionId, prompt: 'second', streamingBehavior: 'steer', clientMessageId: 'second-client' }, key)
      .finally(() => releaseParent());
    const completion = Promise.allSettled([first, second]);
    await inputReady;
    releaseFirst();
    await parentReady;
    const startedAt = Date.now();
    releaseInput();
    const results = await completion;
    if (stalls) {
      assert.ok(results.some((result) => result.status === 'rejected' && /runtime was reset/i.test(result.reason.message)));
      assert.ok(events.some((event) => event.type === 'agent:error' && /runtime was reset/i.test(event.message)));
    } else {
      assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled']);
      assert.ok(Date.now() - startedAt > 200, 'Successor must stream beyond the no-progress timeout');
      assert.ok(events.filter((event) => event.data?.type === 'message_update').length > 10);
      assert.equal(events.some((event) => event.type === 'agent:error'), false);
      assert.equal(events.filter((event) => event.type === 'agent:finish').length, 1);
      assert.equal(events.filter((event) => event.data?.type === 'message_start' && event.data.clientMessageId === 'second-client').length, 1);
    }
  });
}

test('recovery of a superseded parent still publishes a terminal error', { timeout: 10_000 }, async (t) => {
  const faux = fauxProvider();
  let firstStarted!: () => void;
  let releaseFirst!: () => void;
  let inputStarted!: () => void;
  let releaseInput!: () => void;
  let parentSettling!: () => void;
  let releaseParent!: () => void;
  const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const inputReady = new Promise<void>((resolve) => { inputStarted = resolve; });
  const inputGate = new Promise<void>((resolve) => { releaseInput = resolve; });
  const parentReady = new Promise<void>((resolve) => { parentSettling = resolve; });
  const parentGate = new Promise<void>((resolve) => { releaseParent = resolve; });
  const keepAlive = setInterval(() => undefined, 100);
  t.after(() => { clearInterval(keepAlive); releaseFirst(); releaseInput(); releaseParent(); });
  faux.setResponses([
    async () => { firstStarted(); await firstGate; return fauxAssistantMessage('First answer'); },
    fauxAssistantMessage('Second answer'),
  ]);
  let settlements = 0;
  const { bridge, sessionId, cwd, key, events } = await extensionFixture(t, (pi) => {
    pi.on('input', async (event) => {
      if (event.text === 'second') { inputStarted(); await inputGate; }
      return { action: 'continue' };
    });
    pi.on('agent_settled', async () => {
      if (++settlements === 1) { parentSettling(); await parentGate; }
    });
  }, faux, { runtimeIdleGraceMs: 50, runtimeWatchIntervalMs: 1 });
  const first = bridge.prompt(cwd, { sessionId, prompt: 'first' }, key);
  const recovery = assert.rejects(first, /runtime was reset/i);
  await firstReady;
  const second = bridge.prompt(cwd, { sessionId, prompt: 'second', streamingBehavior: 'steer' }, key);
  await inputReady;
  releaseFirst();
  await parentReady;
  releaseInput();
  await second;
  assert.equal(events.some((event) => event.type === 'agent:finish'), false);
  await recovery;
  assert.equal(events.filter((event) => event.type === 'agent:error').length, 1);
  assert.equal(events.some((event) => event.type === 'agent:notice' && /runtime was reset/i.test(event.message ?? '')), false);
});

test('continuation starts within one SDK run share its terminal settlement', async (t) => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage('First answer'), fauxAssistantMessage('Continuation answer')]);
  let boundaries = 0;
  const { bridge, session, sessionId, cwd, key, events } = await extensionFixture(t, (pi) => {
    pi.on('agent_before_settle', () => {
      if (++boundaries === 1) {
        pi.sendMessage({ customType: 'continuation', content: 'Continue', display: true }, { triggerTurn: true });
        return { continue: true };
      }
    });
  }, faux);
  await bridge.prompt(cwd, { sessionId, prompt: 'first' }, key);
  assert.equal(faux.state.callCount, 2);
  assert.equal(events.filter((event) => event.data?.type === 'agent_start').length, 2);
  assert.equal(events.filter((event) => event.type === 'agent:start').length, 1);
  assert.equal(events.filter((event) => event.type === 'agent:finish').length, 1);
  assert.equal((bridge as any).sessionEventRelays.get(session).pendingAgentSettlements, 0);
});

for (const outcome of ['queued', 'handled'] as const) {
  test(`SDK-deferred input is ${outcome} without losing or leaking its client identity`, { timeout: 10_000 }, async (t) => {
    const faux = fauxProvider();
    let firstStarted!: () => void;
    let releaseFirst!: () => void;
    let replacementInputStarted!: () => void;
    let releaseReplacementInput!: () => void;
    let parentSettling!: () => void;
    let releaseParentSettlement!: () => void;
    let replacementStarted!: () => void;
    let releaseReplacement!: () => void;
    const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const replacementInputReady = new Promise<void>((resolve) => { replacementInputStarted = resolve; });
    const replacementInputGate = new Promise<void>((resolve) => { releaseReplacementInput = resolve; });
    const parentSettlementReady = new Promise<void>((resolve) => { parentSettling = resolve; });
    const parentSettlementGate = new Promise<void>((resolve) => { releaseParentSettlement = resolve; });
    const replacementReady = new Promise<void>((resolve) => { replacementStarted = resolve; });
    const replacementGate = new Promise<void>((resolve) => { releaseReplacement = resolve; });
    t.after(() => { releaseFirst(); releaseReplacementInput(); releaseParentSettlement(); releaseReplacement(); });
    faux.setResponses([
      async () => { firstStarted(); await firstGate; return fauxAssistantMessage('First answer'); },
      async () => { replacementStarted(); await replacementGate; return fauxAssistantMessage('Replacement answer'); },
      fauxAssistantMessage('Deferred answer'),
      fauxAssistantMessage('Next answer'),
    ]);
    const inputs: Array<{ text: string; source: string }> = [];
    let settlements = 0;
    const { bridge, session, sessionId, cwd, key, events } = await extensionFixture(t, (pi) => {
      pi.on('input', async (event) => {
        inputs.push({ text: event.text, source: event.source });
        if (event.text === 'replacement') {
          replacementInputStarted();
          await replacementInputGate;
        }
        if (event.text === 'deferred' && outcome === 'handled') return { action: 'handled' };
        return { action: 'continue' };
      });
      pi.on('agent_settled', async () => {
        if (++settlements === 1) {
          parentSettling();
          await parentSettlementGate;
        }
      });
    }, faux);

    const first = bridge.prompt(cwd, { sessionId, prompt: 'first' }, key);
    await firstReady;
    const replacement = bridge.prompt(cwd, { sessionId, prompt: 'replacement', streamingBehavior: 'steer' }, key);
    await replacementInputReady;
    releaseFirst();
    await parentSettlementReady;
    releaseReplacementInput();
    await replacementReady;

    let deferredSettled = false;
    const deferred = bridge.prompt(cwd, {
      sessionId,
      prompt: 'deferred',
      streamingBehavior: 'steer',
      clientMessageId: 'deferred-client',
    }, key).then(() => { deferredSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(deferredSettled, false);
    assert.equal(inputs.some(({ text }) => text === 'deferred'), false);

    releaseParentSettlement();
    await deferred;
    assert.deepEqual(inputs.filter(({ text }) => text === 'deferred'), [{ text: 'deferred', source: 'rpc' }]);
    releaseReplacement();
    await Promise.all([first, replacement]);

    const delivered = events.filter((event) => event.data?.type === 'message_start' && event.data.clientMessageId === 'deferred-client');
    assert.equal(delivered.length, outcome === 'queued' ? 1 : 0);
    if (outcome === 'queued') assert.equal(delivered[0].data.message.content[0]?.text, 'deferred');
    else {
      await bridge.prompt(cwd, { sessionId, prompt: 'next' }, key);
      const next = events.find((event) => event.data?.type === 'message_start' && event.data.message?.role === 'user'
        && event.data.message.content[0]?.text === 'next');
      assert.ok(next);
      assert.equal(next.data.clientMessageId, undefined);
      assert.equal(events.some((event) => event.data?.clientMessageId === 'deferred-client'), false);
    }
    assert.equal((bridge as any).sessionEventRelays.get(session).observers.size, 0);
  });
}

test('SDK-deferred direct run retains its client id through an asynchronous start hook', { timeout: 10_000 }, async (t) => {
  const faux = fauxProvider();
  let firstStarted!: () => void;
  let releaseFirst!: () => void;
  let replacementInputStarted!: () => void;
  let releaseReplacementInput!: () => void;
  let parentSettling!: () => void;
  let releaseParentSettlement!: () => void;
  let replacementStarted!: () => void;
  let releaseReplacement!: () => void;
  let deferredStarting!: () => void;
  let releaseDeferredStart!: () => void;
  const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const replacementInputReady = new Promise<void>((resolve) => { replacementInputStarted = resolve; });
  const replacementInputGate = new Promise<void>((resolve) => { releaseReplacementInput = resolve; });
  const parentSettlementReady = new Promise<void>((resolve) => { parentSettling = resolve; });
  const parentSettlementGate = new Promise<void>((resolve) => { releaseParentSettlement = resolve; });
  const replacementReady = new Promise<void>((resolve) => { replacementStarted = resolve; });
  const replacementGate = new Promise<void>((resolve) => { releaseReplacement = resolve; });
  const deferredStartReady = new Promise<void>((resolve) => { deferredStarting = resolve; });
  const deferredStartGate = new Promise<void>((resolve) => { releaseDeferredStart = resolve; });
  t.after(() => { releaseFirst(); releaseReplacementInput(); releaseParentSettlement(); releaseReplacement(); releaseDeferredStart(); });
  faux.setResponses([
    async () => { firstStarted(); await firstGate; return fauxAssistantMessage('First answer'); },
    async () => { replacementStarted(); await replacementGate; return fauxAssistantMessage('Replacement answer'); },
    fauxAssistantMessage('Deferred answer'),
  ]);
  const inputs: Array<{ text: string; source: string }> = [];
  let settlements = 0;
  let starts = 0;
  const { bridge, session, sessionId, cwd, key, events } = await extensionFixture(t, (pi) => {
    pi.on('input', async (event) => {
      inputs.push({ text: event.text, source: event.source });
      if (event.text === 'replacement') {
        replacementInputStarted();
        await replacementInputGate;
      }
      return { action: 'continue' };
    });
    pi.on('agent_settled', async () => {
      if (++settlements === 1) {
        parentSettling();
        await parentSettlementGate;
      }
    });
    pi.on('agent_start', async () => {
      if (++starts === 3) {
        deferredStarting();
        await deferredStartGate;
      }
    });
  }, faux);

  const first = bridge.prompt(cwd, { sessionId, prompt: 'first' }, key);
  await firstReady;
  const replacement = bridge.prompt(cwd, { sessionId, prompt: 'replacement', streamingBehavior: 'steer' }, key);
  await replacementInputReady;
  releaseFirst();
  await parentSettlementReady;
  releaseReplacementInput();
  await replacementReady;

  let deferredSettled = false;
  const deferred = bridge.prompt(cwd, {
    sessionId,
    prompt: 'deferred direct',
    streamingBehavior: 'steer',
    clientMessageId: 'deferred-direct-client',
  }, key).then(() => { deferredSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(deferredSettled, false);
  releaseReplacement();
  await deferredStartReady;
  assert.equal(deferredSettled, false);
  assert.equal(events.some((event) => event.data?.clientMessageId === 'deferred-direct-client'), false);

  releaseParentSettlement();
  releaseDeferredStart();
  await deferred;
  await Promise.all([first, replacement]);
  assert.deepEqual(inputs.filter(({ text }) => text === 'deferred direct'), [{ text: 'deferred direct', source: 'rpc' }]);
  const delivered = events.filter((event) => event.data?.type === 'message_start' && event.data.clientMessageId === 'deferred-direct-client');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].data.message.content[0]?.text, 'deferred direct');
  assert.equal(events.filter((event) => event.data?.clientMessageId === 'deferred-direct-client').length, 1);
  assert.equal((bridge as any).sessionEventRelays.get(session).observers.size, 0);
});

test('idle SDK-deferred input keeps its identity when its hook starts an extension run', { timeout: 10_000 }, async (t) => {
  const faux = fauxProvider();
  let firstStarted!: () => void;
  let releaseFirst!: () => void;
  let replacementInputStarted!: () => void;
  let releaseReplacementInput!: () => void;
  let parentSettling!: () => void;
  let releaseParentSettlement!: () => void;
  let replacementStarted!: () => void;
  let releaseReplacement!: () => void;
  let extensionStarted!: () => void;
  let releaseExtension!: () => void;
  const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const replacementInputReady = new Promise<void>((resolve) => { replacementInputStarted = resolve; });
  const replacementInputGate = new Promise<void>((resolve) => { releaseReplacementInput = resolve; });
  const parentSettlementReady = new Promise<void>((resolve) => { parentSettling = resolve; });
  const parentSettlementGate = new Promise<void>((resolve) => { releaseParentSettlement = resolve; });
  const replacementReady = new Promise<void>((resolve) => { replacementStarted = resolve; });
  const replacementGate = new Promise<void>((resolve) => { releaseReplacement = resolve; });
  const extensionReady = new Promise<void>((resolve) => { extensionStarted = resolve; });
  const extensionGate = new Promise<void>((resolve) => { releaseExtension = resolve; });
  t.after(() => { releaseFirst(); releaseReplacementInput(); releaseParentSettlement(); releaseReplacement(); releaseExtension(); });
  faux.setResponses([
    async () => { firstStarted(); await firstGate; return fauxAssistantMessage('First answer'); },
    async () => { replacementStarted(); await replacementGate; return fauxAssistantMessage('Replacement answer'); },
    async () => { extensionStarted(); await extensionGate; return fauxAssistantMessage('Extension answer'); },
    fauxAssistantMessage('Web answer'),
  ]);
  const inputs: Array<{ text: string; source: string; streamingBehavior?: string }> = [];
  let settlements = 0;
  const { bridge, session, sessionId, cwd, key, events } = await extensionFixture(t, (pi) => {
    pi.on('input', async (event) => {
      inputs.push({ text: event.text, source: event.source, streamingBehavior: event.streamingBehavior });
      if (event.text === 'replacement') {
        replacementInputStarted();
        await replacementInputGate;
      }
      if (event.text === 'deferred web' && event.source === 'rpc') {
        pi.sendUserMessage('extension response');
        await extensionReady;
        return { action: 'transform', text: 'transformed deferred web' };
      }
      return { action: 'continue' };
    });
    pi.on('agent_settled', async () => {
      if (++settlements === 1) {
        parentSettling();
        await parentSettlementGate;
      }
    });
  }, faux);

  const first = bridge.prompt(cwd, { sessionId, prompt: 'first' }, key);
  await firstReady;
  const replacement = bridge.prompt(cwd, { sessionId, prompt: 'replacement', streamingBehavior: 'steer' }, key);
  await replacementInputReady;
  releaseFirst();
  await parentSettlementReady;
  releaseReplacementInput();
  await replacementReady;

  const deferred = bridge.prompt(cwd, {
    sessionId,
    prompt: 'deferred web',
    streamingBehavior: 'steer',
    clientMessageId: 'idle-deferred-client',
  }, key);
  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseReplacement();
  await extensionReady;
  await deferred;
  releaseParentSettlement();
  releaseExtension();
  await Promise.all([first, replacement]);
  await session.waitForIdle();

  assert.deepEqual(inputs.filter(({ text }) => text === 'deferred web'), [
    { text: 'deferred web', source: 'rpc', streamingBehavior: undefined },
  ]);
  const extensionMessage = events.filter((event) => event.data?.type === 'message_start' && event.data.message?.role === 'user'
    && event.data.message.content[0]?.text === 'extension response');
  const webMessage = events.filter((event) => event.data?.type === 'message_start' && event.data.message?.role === 'user'
    && event.data.message.content[0]?.text === 'transformed deferred web');
  assert.equal(extensionMessage.length, 1);
  assert.equal(extensionMessage[0].data.clientMessageId, undefined);
  assert.equal(webMessage.length, 1);
  assert.equal(webMessage[0].data.clientMessageId, 'idle-deferred-client');
  assert.equal(events.filter((event) => event.data?.clientMessageId === 'idle-deferred-client').length, 1);
  assert.deepEqual(session.getSteeringMessages(), []);
});

for (const outcome of ['handled', 'rejected'] as const) {
  test(`settled queued input that is ${outcome} does not leak its client identity`, { timeout: 10_000 }, async (t) => {
    const faux = fauxProvider();
    let firstStarted!: () => void;
    let releaseFirst!: () => void;
    let inputStarted!: () => void;
    let releaseInput!: () => void;
    const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const inputReady = new Promise<void>((resolve) => { inputStarted = resolve; });
    const inputGate = new Promise<void>((resolve) => { releaseInput = resolve; });
    faux.setResponses([
      async () => { firstStarted(); await firstGate; return fauxAssistantMessage('First answer'); },
      fauxAssistantMessage('Next answer'),
    ]);
    let secondInputs = 0;
    const { bridge, session, sessionId, cwd, key, events } = await extensionFixture(t, (pi) => {
      pi.on('input', async (event) => {
        if (event.text !== 'second') return { action: 'continue' };
        secondInputs += 1;
        inputStarted();
        await inputGate;
        return outcome === 'handled' ? { action: 'handled' } : { action: 'continue' };
      });
    }, faux);
    const first = bridge.prompt(cwd, { sessionId, prompt: 'first' }, key);
    await firstReady;
    const second = bridge.prompt(cwd, { sessionId, prompt: 'second', streamingBehavior: 'steer', clientMessageId: 'must-not-leak' }, key);
    await inputReady;
    releaseFirst();
    await first;
    const model = session.model;
    if (outcome === 'rejected') (session.agent.state as any).model = undefined;
    releaseInput();
    if (outcome === 'rejected') await assert.rejects(second, /no model/i);
    else await second;
    session.agent.state.model = model!;
    assert.equal(secondInputs, 1);
    assert.equal(faux.state.callCount, 1);
    assert.deepEqual(session.getSteeringMessages(), []);
    assert.equal((bridge as any).sessionEventRelays.get(session).observers.size, 0);
    await bridge.prompt(cwd, { sessionId, prompt: 'next' }, key);
    const next = events.find((event) => event.type === 'agent:event' && event.data?.type === 'message_start' && event.data.message?.role === 'user' && event.data.message.content[0]?.text === 'next');
    assert.ok(next);
    assert.equal(next.data.clientMessageId, undefined);
    assert.equal(events.some((event) => event.data?.clientMessageId === 'must-not-leak'), false);
    assert.equal(faux.state.callCount, 2);
  });
}

test('session factory diagnostics are retained even without a resource loader or a connected client', async () => {
  const bridge = new PiBridge();
  const session = { dispose: () => undefined };
  (bridge as any).loadSdk = async () => ({
    createAgentSession: async () => ({ session, extensionsResult: { errors: [{ path: '/tmp/broken-extension.ts', error: 'module missing' }] } }),
  });
  const result = await (bridge as any).getSession(process.cwd());
  assert.equal(result, session);
  assert.deepEqual((bridge as any).statusEntries(session), [{ key: 'pi-web:extension-load:0', text: 'Extension failed to load: /tmp/broken-extension.ts: module missing' }]);
  await bridge.dispose();
});
