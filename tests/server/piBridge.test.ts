import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { PiBridge } from '../../src/server/piBridge.js';
import { createSessionFile, sessionManagerForSession } from '../../src/server/sessions.js';
import { sessionIdFromPath } from '../../src/server/util.js';

test('binds browser extension UI in RPC mode', async () => {
  const bridge = new PiBridge();
  let bindings: Record<string, unknown> | undefined;

  await (bridge as any).bindWebExtensions({
    bindExtensions: async (next: Record<string, unknown>) => { bindings = next; },
  }, '/workspace', 'session-1', 'project-1:session-1');

  assert.equal(bindings?.mode, 'rpc');
});

test('applies explicit agent selection only before Pi Web review extension commands', async () => {
  const bridge = new PiBridge();
  const calls: string[] = [];
  const session = {
    extensionRunner: {
      getCommand: (name: string) => ['pi-web-review', 'pi-web-notes', 'other-extension', 'agent'].includes(name) ? {} : undefined,
    },
    prompt: async (prompt: string) => { calls.push(`prompt:${prompt}`); },
  };
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => undefined });
  (bridge as any).getSession = async () => session;
  (bridge as any).applySuiteAgentSelection = async (_session: unknown, agent: string) => { calls.push(`select:${agent}`); };
  (bridge as any).waitForCommandActivity = async () => undefined;
  (bridge as any).broadcast = () => undefined;

  await bridge.prompt(process.cwd(), {
    sessionId: 'review-agent-session',
    prompt: '/pi-web-review',
    agent: 'reviewer',
  }, 'project:review-agent-session');
  await bridge.prompt(process.cwd(), {
    sessionId: 'review-agent-session',
    prompt: '/pi-web-notes thread-1',
    agent: 'notes',
  }, 'project:review-agent-session');
  await bridge.prompt(process.cwd(), {
    sessionId: 'review-agent-session',
    prompt: '/other-extension',
    agent: 'other',
  }, 'project:review-agent-session');
  await bridge.prompt(process.cwd(), {
    sessionId: 'review-agent-session',
    prompt: '/agent alternate',
    agent: 'alternate',
  }, 'project:review-agent-session');

  assert.deepEqual(calls, [
    'select:reviewer',
    'prompt:/pi-web-review',
    'select:notes',
    'prompt:/pi-web-notes thread-1',
    'prompt:/other-extension',
    'prompt:/agent alternate',
  ]);
});

test('recovers a settled agent operation whose SDK promise never resolves', async () => {
  const bridge = new PiBridge({ runtimeSettledGraceMs: 5, runtimeIdleGraceMs: 20, runtimeWatchIntervalMs: 1 });
  const events: Array<{ type?: string; message?: string }> = [];
  let listener: ((event: unknown) => void) | undefined;
  let released = false;
  let disposed = 0;
  const session = {
    isStreaming: false,
    subscribe: (next: (event: unknown) => void) => {
      listener = next;
      return () => { listener = undefined; };
    },
    prompt: (_prompt: string, options: { preflightResult?: (success: boolean) => void }) => {
      options.preflightResult?.(true);
      queueMicrotask(() => listener?.({ type: 'agent_settled' }));
      return new Promise<void>(() => undefined);
    },
    dispose: () => { disposed += 1; },
  };
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => { released = true; } });
  (bridge as any).getSession = async () => session;
  (bridge as any).broadcast = (_key: string, event: { type?: string; message?: string }) => { events.push(event); };

  await assert.rejects(
    bridge.prompt(process.cwd(), { sessionId: 'crashed-session', prompt: 'test' }, 'project:crashed-session'),
    /session runtime was reset/i,
  );

  assert.equal(released, true);
  assert.equal(disposed, 1);
  assert.equal(events.filter((event) => event.type === 'agent:error').length, 1);
  const { running, recovery } = await bridge.status(process.cwd(), 'crashed-session', 'project:crashed-session');
  assert.equal(running, false);
  assert.match(recovery?.message ?? '', /retry or continue/i);

  let freshPromptCalls = 0;
  (bridge as any).getSession = async () => ({
    prompt: async (_prompt: string, options: { preflightResult?: (success: boolean) => void }) => {
      freshPromptCalls += 1;
      options.preflightResult?.(true);
    },
  });
  await bridge.prompt(process.cwd(), { sessionId: 'crashed-session', prompt: 'continue' }, 'project:crashed-session');
  assert.equal(freshPromptCalls, 1);
  assert.equal((await bridge.status(process.cwd(), 'crashed-session', 'project:crashed-session')).recovery, undefined);
});

test('does not recover a pending operation while the SDK reports it active', async () => {
  const bridge = new PiBridge({ runtimeSettledGraceMs: 2, runtimeIdleGraceMs: 5, runtimeWatchIntervalMs: 1 });
  let finishPrompt: (() => void) | undefined;
  let disposed = 0;
  let released = false;
  const session = {
    isStreaming: false,
    prompt: (_prompt: string, options: { preflightResult?: (success: boolean) => void }) => {
      session.isStreaming = true;
      options.preflightResult?.(true);
      return new Promise<void>((resolve) => { finishPrompt = resolve; });
    },
    dispose: () => { disposed += 1; },
  };
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => { released = true; } });
  (bridge as any).getSession = async () => session;

  const prompt = bridge.prompt(process.cwd(), { sessionId: 'active-session', prompt: 'test' }, 'project:active-session');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(disposed, 0);
  assert.equal(released, false);

  session.isStreaming = false;
  finishPrompt?.();
  await prompt;
  assert.equal(released, true);
  assert.equal(disposed, 0);
});

test('provider error followed by failed auto-compaction emits one terminal error', async () => {
  const bridge = new PiBridge({ runtimeSettledGraceMs: 5, runtimeWatchIntervalMs: 1 });
  const events: Array<{ type?: string; message?: string }> = [];
  let listener: ((event: unknown) => void) | undefined;
  let disposed = 0;
  const session = {
    isStreaming: false,
    isCompacting: false,
    subscribe: (next: (event: unknown) => void) => {
      listener = next;
      return () => { listener = undefined; };
    },
    prompt: async (_prompt: string, options: { preflightResult?: (success: boolean) => void }) => {
      options.preflightResult?.(true);
      listener?.({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'WebSocket error' } });
      listener?.({ type: 'agent_end', willRetry: false });
      listener?.({ type: 'compaction_start' });
      listener?.({ type: 'compaction_end', aborted: false, willRetry: false, errorMessage: 'Auto-compaction failed: Summarization failed: WebSocket error' });
      listener?.({ type: 'agent_settled' });
    },
    dispose: () => { disposed += 1; },
  };
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => undefined });
  (bridge as any).getSession = async () => session;
  (bridge as any).broadcast = (_key: string, event: { type?: string; message?: string }) => { events.push(event); };

  await assert.rejects(
    bridge.prompt(process.cwd(), { sessionId: 'provider-error-session', prompt: 'test' }, 'project:provider-error-session'),
    /Summarization failed: WebSocket error/i,
  );

  const terminalErrors = events.filter((event) => event.type === 'agent:error');
  assert.equal(terminalErrors.length, 1);
  assert.match(terminalErrors[0].message ?? '', /Summarization failed: WebSocket error/i);
  assert.equal(events.some((event) => event.type === 'agent:finish'), false);
  assert.equal(disposed, 1);
});

test('does not recover when successful compaction retries a provider error', async () => {
  const bridge = new PiBridge({ runtimeSettledGraceMs: 5, runtimeWatchIntervalMs: 1 });
  const events: Array<{ type?: string }> = [];
  let listener: ((event: unknown) => void) | undefined;
  let disposed = 0;
  const session = {
    isStreaming: false,
    isCompacting: false,
    subscribe: (next: (event: unknown) => void) => {
      listener = next;
      return () => { listener = undefined; };
    },
    prompt: async (_prompt: string, options: { preflightResult?: (success: boolean) => void }) => {
      options.preflightResult?.(true);
      listener?.({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'Context overflow' } });
      listener?.({ type: 'agent_end', willRetry: false });
      listener?.({ type: 'compaction_start' });
      listener?.({ type: 'compaction_end', aborted: false, willRetry: true });
      listener?.({ type: 'agent_start' });
      listener?.({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [] } });
      listener?.({ type: 'agent_end', willRetry: false });
      listener?.({ type: 'agent_settled' });
    },
    dispose: () => { disposed += 1; },
  };
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => undefined });
  (bridge as any).getSession = async () => session;
  (bridge as any).broadcast = (_key: string, event: { type?: string }) => { events.push(event); };

  await bridge.prompt(process.cwd(), { sessionId: 'provider-retry-session', prompt: 'test' }, 'project:provider-retry-session');

  assert.equal(events.some((event) => event.type === 'agent:error'), false);
  assert.equal(disposed, 0);
});

test('recovers stale active flags after the no-progress timeout', async () => {
  const bridge = new PiBridge({ runtimeNoProgressTimeoutMs: 5, runtimeWatchIntervalMs: 1 });
  let disposed = 0;
  const session = {
    isStreaming: false,
    prompt: (_prompt: string, options: { preflightResult?: (success: boolean) => void }) => {
      session.isStreaming = true;
      options.preflightResult?.(true);
      return new Promise<void>(() => undefined);
    },
    dispose: () => { disposed += 1; },
  };
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => undefined });
  (bridge as any).getSession = async () => session;

  await assert.rejects(
    bridge.prompt(process.cwd(), { sessionId: 'no-progress-session', prompt: 'test' }, 'project:no-progress-session'),
    /stopped responding or crashed/i,
  );
  assert.equal(disposed, 1);
});

test('SDK events keep an active operation alive past the no-progress timeout', async () => {
  const bridge = new PiBridge({ runtimeNoProgressTimeoutMs: 8, runtimeWatchIntervalMs: 1 });
  let listener: ((event: unknown) => void) | undefined;
  let finishPrompt: (() => void) | undefined;
  let disposed = 0;
  const session = {
    isStreaming: false,
    subscribe: (next: (event: unknown) => void) => {
      listener = next;
      return () => { listener = undefined; };
    },
    prompt: (_prompt: string, options: { preflightResult?: (success: boolean) => void }) => {
      session.isStreaming = true;
      options.preflightResult?.(true);
      return new Promise<void>((resolve) => { finishPrompt = resolve; });
    },
    dispose: () => { disposed += 1; },
  };
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => undefined });
  (bridge as any).getSession = async () => session;

  const prompt = bridge.prompt(process.cwd(), { sessionId: 'progress-session', prompt: 'test' }, 'project:progress-session');
  const progress = setInterval(() => listener?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '.' } }), 2);
  await new Promise((resolve) => setTimeout(resolve, 25));
  clearInterval(progress);
  assert.equal(disposed, 0);
  session.isStreaming = false;
  finishPrompt?.();
  await prompt;
  assert.equal(disposed, 0);
});

test('recovers an extension command whose active flags stop making progress', async () => {
  const bridge = new PiBridge({ runtimeNoProgressTimeoutMs: 5, runtimeWatchIntervalMs: 1 });
  let listener: ((event: unknown) => void) | undefined;
  let disposed = 0;
  const session = {
    isStreaming: false,
    extensionRunner: { getCommand: (name: string) => name === 'stuck' ? {} : undefined },
    subscribe: (next: (event: unknown) => void) => {
      listener = next;
      return () => { listener = undefined; };
    },
    prompt: () => {
      session.isStreaming = true;
      listener?.({ type: 'agent_start' });
      return new Promise<void>(() => undefined);
    },
    dispose: () => { disposed += 1; },
  };
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => undefined });
  (bridge as any).getSession = async () => session;

  await assert.rejects(
    bridge.prompt(process.cwd(), { sessionId: 'extension-no-progress-session', prompt: '/stuck' }, 'project:extension-no-progress-session'),
    /stopped responding or crashed/i,
  );
  assert.equal(disposed, 1);
});

test('does not spin when the outer session remains streaming after the core agent is idle', async () => {
  const bridge = new PiBridge();
  let waitForIdleCalls = 0;
  let timerRan = false;
  const session = {
    isStreaming: true,
    agent: {
      waitForIdle: async () => {
        waitForIdleCalls += 1;
        // Keep the pre-fix implementation from hanging the test process forever.
        if (waitForIdleCalls === 1_000) session.isStreaming = false;
      },
    },
  };
  const timer = setTimeout(() => {
    timerRan = true;
    session.isStreaming = false;
  }, 0);

  await (bridge as any).waitForSessionIdle(session);
  clearTimeout(timer);

  assert.equal(timerRan, true);
  assert.equal(waitForIdleCalls, 1);
});

test('tracked extension activity settles without polling an already-idle core agent', async () => {
  const bridge = new PiBridge();
  let waitForIdleCalls = 0;
  let idle = false;
  let finishExtensionTask: () => void = () => undefined;
  let markOuterSessionIdle: () => void = () => undefined;
  const outerSessionIdle = new Promise<void>((resolve) => { markOuterSessionIdle = resolve; });
  const session = {
    isStreaming: true,
    agent: {
      waitForIdle: async () => {
        waitForIdleCalls += 1;
        // Keep the pre-fix implementation from hanging the test process forever.
        if (waitForIdleCalls === 1_000) session.isStreaming = false;
      },
    },
  };
  const extensionTask = new Promise<void>((resolve) => { finishExtensionTask = resolve; });
  (bridge as any).trackExtensionAsyncTask(session, extensionTask);
  setTimeout(() => {
    session.isStreaming = false;
    markOuterSessionIdle();
  }, 0);

  const waitForIdle = (bridge as any).waitForSessionIdle(session).then(() => { idle = true; });
  await outerSessionIdle;
  assert.equal(idle, false);

  finishExtensionTask();
  await waitForIdle;
  assert.equal(waitForIdleCalls, 0);
});

test('stops a recovered idle wait when tracked activity later settles with stale streaming state', async () => {
  const bridge = new PiBridge();
  let waitForIdleCalls = 0;
  let finishExtensionTask: () => void = () => undefined;
  const session = {
    isStreaming: true,
    agent: {
      waitForIdle: async () => { waitForIdleCalls += 1; },
    },
  };
  const extensionTask = new Promise<void>((resolve) => { finishExtensionTask = resolve; });
  (bridge as any).trackExtensionAsyncTask(session, extensionTask);
  let idleWaitFinished = false;
  const idleWait = (bridge as any).waitForSessionIdle(session).then(() => { idleWaitFinished = true; });

  (bridge as any).recoveringSessions.add(session);
  finishExtensionTask();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const finishedAfterRecovery = idleWaitFinished;
  if (!idleWaitFinished) {
    session.isStreaming = false;
    await idleWait;
  }

  assert.equal(finishedAfterRecovery, true);
  assert.equal(waitForIdleCalls, 0);
});

test('recovers a stuck tracked extension task without starving the supervisor', async () => {
  const bridge = new PiBridge({ runtimeNoProgressTimeoutMs: 5, runtimeWatchIntervalMs: 1 });
  let listener: ((event: unknown) => void) | undefined;
  let sendUserMessageCalls = 0;
  let disposed = 0;
  const session = {
    isStreaming: false,
    extensionRunner: { getCommand: (name: string) => name === 'stuck-send' ? {} : undefined },
    subscribe: (next: (event: unknown) => void) => {
      listener = next;
      return () => { listener = undefined; };
    },
    bindExtensions: async () => undefined,
    sendUserMessage: () => {
      sendUserMessageCalls += 1;
      return new Promise<void>(() => undefined);
    },
    prompt: () => {
      session.isStreaming = true;
      listener?.({ type: 'agent_start' });
      void session.sendUserMessage();
    },
    agent: { waitForIdle: async () => undefined },
    dispose: () => { disposed += 1; },
  };
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => undefined });
  (bridge as any).getSession = async () => session;

  await assert.rejects(
    bridge.prompt(process.cwd(), { sessionId: 'stuck-extension-task-session', prompt: '/stuck-send' }, 'project:stuck-extension-task-session'),
    /stopped responding or crashed/i,
  );
  assert.equal(sendUserMessageCalls, 1);
  assert.equal(disposed, 1);
});

test('finishes extension activity only after the whole command settles', async () => {
  const bridge = new PiBridge({ runtimeSettledGraceMs: 1_000, runtimeWatchIntervalMs: 1 });
  const events: Array<{ type?: string; operationId?: string }> = [];
  let listener: ((event: unknown) => void) | undefined;
  let finishPrompt: (() => void) | undefined;
  let markAgentEndEmitted: () => void = () => undefined;
  const agentEndEmitted = new Promise<void>((resolve) => { markAgentEndEmitted = resolve; });
  const session = {
    isStreaming: false,
    extensionRunner: { getCommand: (name: string) => name === 'settled' ? {} : undefined },
    subscribe: (next: (event: unknown) => void) => {
      listener = next;
      return () => { listener = undefined; };
    },
    prompt: () => {
      session.isStreaming = true;
      listener?.({ type: 'agent_start' });
      listener?.({ type: 'agent_end', willRetry: false });
      markAgentEndEmitted();
      return new Promise<void>((resolve) => { finishPrompt = resolve; });
    },
  };
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => undefined });
  (bridge as any).getSession = async () => session;
  (bridge as any).broadcast = (_key: string, event: { type?: string; operationId?: string }) => { events.push(event); };

  const prompt = bridge.prompt(process.cwd(), { sessionId: 'settled-extension-session', prompt: '/settled' }, 'project:settled-extension-session');
  await agentEndEmitted;
  assert.equal(events.filter((event) => event.type === 'agent:finish').length, 0);

  listener?.({ type: 'agent_settled' });
  assert.equal(events.filter((event) => event.type === 'agent:finish').length, 0);

  listener?.({ type: 'agent_start' });
  listener?.({ type: 'agent_end', willRetry: false });
  listener?.({ type: 'agent_settled' });
  assert.equal(events.filter((event) => event.type === 'agent:finish').length, 0);

  session.isStreaming = false;
  finishPrompt?.();
  await prompt;

  const starts = events.filter((event) => event.type === 'agent:start');
  const finishes = events.filter((event) => event.type === 'agent:finish');
  assert.equal(starts.length, 1);
  assert.equal(finishes.length, 1);
  assert.equal(typeof starts[0].operationId, 'string');
  assert.equal(finishes[0].operationId, starts[0].operationId);
});

test('recovers a terminal provider error from delayed extension-command activity', async () => {
  const bridge = new PiBridge({ runtimeSettledGraceMs: 1_000, runtimeWatchIntervalMs: 1 });
  const events: Array<{ type?: string }> = [];
  let listener: ((event: unknown) => void) | undefined;
  let disposed = 0;
  const session = {
    isStreaming: false,
    extensionRunner: { getCommand: (name: string) => name === 'delayed' ? {} : undefined },
    subscribe: (next: (event: unknown) => void) => {
      listener = next;
      return () => { listener = undefined; };
    },
    prompt: async () => {
      session.isStreaming = true;
      listener?.({ type: 'agent_start' });
      setTimeout(() => {
        listener?.({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'Delayed provider failure' } });
        listener?.({ type: 'agent_end', willRetry: false });
        listener?.({ type: 'agent_settled' });
        session.isStreaming = false;
      }, 1);
    },
    dispose: () => { disposed += 1; },
  };
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => undefined });
  (bridge as any).getSession = async () => session;
  (bridge as any).broadcast = (_key: string, event: { type?: string }) => { events.push(event); };

  await assert.rejects(
    bridge.prompt(process.cwd(), { sessionId: 'delayed-extension-session', prompt: '/delayed' }, 'project:delayed-extension-session'),
    /Delayed provider failure/i,
  );

  assert.equal(events.filter((event) => event.type === 'agent:error').length, 1);
  assert.equal(events.filter((event) => event.type === 'agent:finish').length, 0);
  assert.equal(disposed, 1);
});

test('reports queued prompt recovery as a terminal error', async () => {
  const bridge = new PiBridge({ runtimeIdleGraceMs: 5, runtimeWatchIntervalMs: 1 });
  const events: Array<{ type?: string; message?: string }> = [];
  let promptCalls = 0;
  const session = {
    isStreaming: false,
    prompt: (_prompt: string, options: { preflightResult?: (success: boolean) => void }) => {
      promptCalls += 1;
      session.isStreaming = true;
      options.preflightResult?.(true);
      return new Promise<void>(() => undefined);
    },
    dispose: () => undefined,
  };
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => undefined });
  (bridge as any).getSession = async () => session;
  (bridge as any).broadcast = (_key: string, event: { type?: string; message?: string }) => { events.push(event); };

  const activePrompt = bridge.prompt(process.cwd(), { sessionId: 'queued-session', prompt: 'first' }, 'project:queued-session');
  await new Promise((resolve) => setTimeout(resolve, 1));
  const queuedPrompt = bridge.prompt(process.cwd(), {
    sessionId: 'queued-session',
    prompt: 'second',
    streamingBehavior: 'steer',
  }, 'project:queued-session');
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(promptCalls, 2);
  session.isStreaming = false;

  const results = await Promise.allSettled([activePrompt, queuedPrompt]);
  assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected']);
  assert.equal(events.some((event) => event.type === 'agent:notice' && /runtime was reset/i.test(event.message ?? '')), false);
  assert.equal(events.some((event) => event.type === 'agent:error' && /runtime was reset/i.test(event.message ?? '')), true);
});

test('recovers an accepted bash operation that remains idle and pending', async () => {
  const bridge = new PiBridge({ runtimeIdleGraceMs: 5, runtimeWatchIntervalMs: 1 });
  let disposed = 0;
  let released = false;
  const session = {
    isBashRunning: false,
    executeBash: () => new Promise<void>(() => undefined),
    dispose: () => { disposed += 1; },
  };
  (bridge as any).markSessionActive = async () => () => { released = true; };
  (bridge as any).getSession = async () => session;

  await assert.rejects(
    bridge.executeBash(process.cwd(), { sessionId: 'bash-session', command: 'sleep 60' }, 'project:bash-session'),
    /runtime was reset/i,
  );
  assert.equal(released, true);
  assert.equal(disposed, 1);
});

test('recovered bash does not resume after a late extension hook', async () => {
  const bridge = new PiBridge({ abortGraceMs: 5 });
  let finishHook: ((value: unknown) => void) | undefined;
  let nativeExecutions = 0;
  let recordedResults = 0;
  const session = {
    isBashRunning: false,
    extensionRunner: {
      emitUserBash: () => new Promise((resolve) => { finishHook = resolve; }),
    },
    executeBash: async () => { nativeExecutions += 1; },
    recordBashResult: () => { recordedResults += 1; },
    abort: async () => undefined,
    dispose: () => undefined,
  };
  (bridge as any).markSessionActive = async () => () => undefined;
  (bridge as any).getSession = async () => session;

  const execution = bridge.executeBash(process.cwd(), { sessionId: 'late-bash-hook-session', command: 'echo late' }, 'project:late-bash-hook-session');
  await new Promise((resolve) => setTimeout(resolve, 1));
  await bridge.abort(process.cwd(), 'late-bash-hook-session', 'project:late-bash-hook-session');
  await assert.rejects(execution, /did not stop after abort/i);
  finishHook?.({ result: { output: 'late output' } });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(nativeExecutions, 0);
  assert.equal(recordedResults, 0);
});

test('recovery of a stale session does not evict its replacement', async () => {
  const bridge = new PiBridge();
  const projectPath = process.cwd();
  const sessionId = 'replacement-session';
  const oldSession = { dispose: () => undefined };
  const replacementSession = {};
  const oldEntry = { promise: Promise.resolve(oldSession), expiresAt: Date.now() + 60_000 };
  const replacementEntry = { promise: Promise.resolve(replacementSession), expiresAt: Date.now() + 60_000 };
  const cacheKey = (bridge as any).runtimeSessionCacheKey(projectPath, sessionId);
  let replacementUiSettled = false;
  (bridge as any).runtimeSessionEntries.set(oldSession, oldEntry);
  (bridge as any).runtimeSessions.set(cacheKey, replacementEntry);
  (bridge as any).pendingExtensionUiRequests.set('replacement-ui', {
    session: replacementSession,
    projectPath,
    streamKey: 'project:replacement-session',
    request: { id: 'replacement-ui', sessionId, method: 'input', title: 'Replacement request', createdAt: Date.now() },
    resolve: () => undefined,
    parseResponse: () => undefined,
    defaultValue: undefined,
    cleanup: () => { replacementUiSettled = true; return true; },
  });

  (bridge as any).recoverRuntimeSession(projectPath, sessionId, oldSession, 'reset');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal((bridge as any).runtimeSessions.get(cacheKey), replacementEntry);
  assert.equal((bridge as any).runtimeRecoveries.has(cacheKey), false);
  assert.equal((bridge as any).pendingExtensionUiRequests.has('replacement-ui'), true);
  assert.equal(replacementUiSettled, false);
});

test('stale operation finalization preserves replacement UI and status', async () => {
  const bridge = new PiBridge({ runtimeSettledGraceMs: 5, runtimeWatchIntervalMs: 1 });
  let listener: ((event: unknown) => void) | undefined;
  const oldSession = {
    isStreaming: false,
    subscribe: (next: (event: unknown) => void) => {
      listener = next;
      return () => { listener = undefined; };
    },
    prompt: (_prompt: string, options: { preflightResult?: (success: boolean) => void }) => {
      options.preflightResult?.(true);
      return new Promise<void>(() => undefined);
    },
    dispose: () => undefined,
  };
  const replacementSession = {};
  const projectPath = process.cwd();
  const sessionId = 'stale-wrapper-session';
  const cacheKey = (bridge as any).runtimeSessionCacheKey(projectPath, sessionId);
  const oldEntry = { promise: Promise.resolve(oldSession), expiresAt: Date.now() + 60_000 };
  const replacementEntry = { promise: Promise.resolve(replacementSession), expiresAt: Date.now() + 60_000 };
  let replacementUiSettled = false;
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => undefined });
  (bridge as any).getSession = async () => oldSession;

  const prompt = bridge.prompt(projectPath, { sessionId, prompt: 'test' }, 'project:stale-wrapper-session');
  await new Promise((resolve) => setTimeout(resolve, 1));
  (bridge as any).runtimeSessionEntries.set(oldSession, oldEntry);
  (bridge as any).runtimeSessions.set(cacheKey, replacementEntry);
  (bridge as any).pendingExtensionUiRequests.set('replacement-wrapper-ui', {
    session: replacementSession,
    projectPath,
    streamKey: 'project:stale-wrapper-session',
    request: { id: 'replacement-wrapper-ui', sessionId, method: 'input', title: 'Replacement request', createdAt: Date.now() },
    resolve: () => undefined,
    parseResponse: () => undefined,
    defaultValue: undefined,
    cleanup: () => { replacementUiSettled = true; return true; },
  });
  listener?.({ type: 'agent_settled' });

  await assert.rejects(prompt, /runtime was reset/i);
  assert.equal((bridge as any).runtimeSessions.get(cacheKey), replacementEntry);
  assert.equal((bridge as any).runtimeRecoveries.has(cacheKey), false);
  assert.equal((bridge as any).pendingExtensionUiRequests.has('replacement-wrapper-ui'), true);
  assert.equal(replacementUiSettled, false);
});

test('abort unwinds a prompt stalled during runtime setup', async () => {
  const bridge = new PiBridge({ abortGraceMs: 5 });
  let disposed = 0;
  let released = false;
  const session = {
    abort: async () => undefined,
    dispose: () => { disposed += 1; },
  };
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => { released = true; } });
  (bridge as any).getSession = async () => session;
  (bridge as any).bindWebExtensions = () => new Promise<void>(() => undefined);

  const prompt = bridge.prompt(process.cwd(), { sessionId: 'setup-stall-session', prompt: 'test' }, 'project:setup-stall-session');
  await new Promise((resolve) => setTimeout(resolve, 1));
  await bridge.abort(process.cwd(), 'setup-stall-session', 'project:setup-stall-session');

  await assert.rejects(prompt, /did not stop after abort/i);
  assert.equal(released, true);
  assert.equal(disposed, 1);
});

test('abort keeps supervising across setup-to-runtime handoff', async () => {
  const bridge = new PiBridge({ abortGraceMs: 5 });
  let finishSetup: (() => void) | undefined;
  let disposed = 0;
  const session = {
    isStreaming: false,
    prompt: (_prompt: string, options: { preflightResult?: (success: boolean) => void }) => {
      session.isStreaming = true;
      options.preflightResult?.(true);
      return new Promise<void>(() => undefined);
    },
    abort: async () => undefined,
    dispose: () => { disposed += 1; },
  };
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => undefined });
  (bridge as any).getSession = async () => session;
  (bridge as any).bindWebExtensions = () => new Promise<void>((resolve) => { finishSetup = resolve; });

  const prompt = bridge.prompt(process.cwd(), { sessionId: 'handoff-session', prompt: 'test' }, 'project:handoff-session');
  await new Promise((resolve) => setTimeout(resolve, 1));
  const abort = bridge.abort(process.cwd(), 'handoff-session', 'project:handoff-session');
  setTimeout(() => finishSetup?.(), 1);
  await abort;

  await assert.rejects(prompt, /did not stop after abort/i);
  assert.equal(disposed, 1);
});

test('forces runtime recovery when the operation never settles after abort', async () => {
  const bridge = new PiBridge({ runtimeIdleGraceMs: 1_000, runtimeWatchIntervalMs: 1, abortGraceMs: 5 });
  let disposed = 0;
  const session = {
    isStreaming: false,
    prompt: (_prompt: string, options: { preflightResult?: (success: boolean) => void }) => {
      session.isStreaming = true;
      options.preflightResult?.(true);
      return new Promise<void>(() => undefined);
    },
    abort: async () => undefined,
    dispose: () => { disposed += 1; },
  };
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => undefined });
  (bridge as any).getSession = async () => session;

  const prompt = bridge.prompt(process.cwd(), { sessionId: 'abort-session', prompt: 'test' }, 'project:abort-session');
  await new Promise((resolve) => setTimeout(resolve, 1));
  await bridge.abort(process.cwd(), 'abort-session', 'project:abort-session');
  await assert.rejects(prompt, /did not stop after abort/i);
  assert.equal(disposed, 1);
});

test('forces runtime recovery when SDK abort rejects', async () => {
  const bridge = new PiBridge({ runtimeIdleGraceMs: 1_000, runtimeWatchIntervalMs: 1, abortGraceMs: 5 });
  let disposed = 0;
  const session = {
    isStreaming: false,
    prompt: (_prompt: string, options: { preflightResult?: (success: boolean) => void }) => {
      session.isStreaming = true;
      options.preflightResult?.(true);
      return new Promise<void>(() => undefined);
    },
    abort: async () => { throw new Error('abort failed'); },
    dispose: () => { disposed += 1; },
  };
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => undefined });
  (bridge as any).getSession = async () => session;

  const prompt = bridge.prompt(process.cwd(), { sessionId: 'abort-rejection-session', prompt: 'test' }, 'project:abort-rejection-session');
  await new Promise((resolve) => setTimeout(resolve, 1));
  await bridge.abort(process.cwd(), 'abort-rejection-session', 'project:abort-rejection-session');
  await assert.rejects(prompt, /did not stop after abort/i);
  assert.equal(disposed, 1);
});

test('forces recovery for a hanging follow-up fallback', async () => {
  const bridge = new PiBridge({ runtimeIdleGraceMs: 1_000, runtimeWatchIntervalMs: 1, abortGraceMs: 5 });
  let disposed = 0;
  const session = {
    followUp: () => new Promise<void>(() => undefined),
    abort: async () => undefined,
    dispose: () => { disposed += 1; },
  };
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => undefined });
  (bridge as any).getSession = async () => session;

  const prompt = bridge.prompt(process.cwd(), { sessionId: 'follow-up-session', prompt: 'continue' }, 'project:follow-up-session');
  await new Promise((resolve) => setTimeout(resolve, 1));
  await bridge.abort(process.cwd(), 'follow-up-session', 'project:follow-up-session');

  await assert.rejects(prompt, /did not stop after abort/i);
  assert.equal(disposed, 1);
});

test('does not reset a session whose tracked operation settles during abort grace', async () => {
  const bridge = new PiBridge({ abortGraceMs: 10 });
  let disposed = 0;
  const session = {
    abort: () => new Promise<void>(() => undefined),
    dispose: () => { disposed += 1; },
  };
  const projectPath = process.cwd();
  const sessionId = 'settled-abort-session';
  const operationKey = (bridge as any).runtimeSessionCacheKey(projectPath, sessionId);
  const originalOperation = { session, recover: () => true };
  let replacementRecoveries = 0;
  const replacementOperation = { session, recover: () => { replacementRecoveries += 1; return true; } };
  (bridge as any).getSession = async () => session;
  (bridge as any).runtimeOperations.set(operationKey, new Set([originalOperation]));
  setTimeout(() => (bridge as any).runtimeOperations.set(operationKey, new Set([replacementOperation])), 2);

  await bridge.abort(projectPath, sessionId, 'project:settled-abort-session');

  assert.equal(disposed, 0);
  assert.equal(replacementRecoveries, 0);
  assert.equal((bridge as any).runtimeRecoveries.size, 0);
});

test('blocks new bridge operations while abort is pending', async () => {
  const bridge = new PiBridge({ abortGraceMs: 5 });
  let disposed = 0;
  const session = {
    abort: () => new Promise<void>(() => undefined),
    dispose: () => { disposed += 1; },
  };
  const projectPath = process.cwd();
  const sessionId = 'abort-serialization-session';
  (bridge as any).getSession = async () => session;

  const abort = bridge.abort(projectPath, sessionId, 'project:abort-serialization-session');
  await new Promise((resolve) => setTimeout(resolve, 1));
  await assert.rejects((bridge as any).markSessionActiveWithState(projectPath, sessionId), /session is stopping/i);
  await abort;

  assert.equal(disposed, 0);
});

test('bounds abort session loading even without a tracked operation', async () => {
  const bridge = new PiBridge({ abortGraceMs: 5 });
  const projectPath = process.cwd();
  const sessionId = 'untracked-load-session';
  const operationKey = (bridge as any).runtimeSessionCacheKey(projectPath, sessionId);
  (bridge as any).getSession = () => new Promise<void>(() => undefined);

  await bridge.abort(projectPath, sessionId, 'project:untracked-load-session');

  assert.equal((bridge as any).runtimeRecoveries.has(operationKey), true);
  assert.equal((bridge as any).abortingRuntimeSessions.has(operationKey), false);
});

test('blocks sessionless operations while their runtime is aborting', async () => {
  const bridge = new PiBridge();
  const projectPath = process.cwd();
  const operationKey = (bridge as any).runtimeSessionCacheKey(projectPath, undefined);
  (bridge as any).abortingRuntimeSessions.add(operationKey);

  await assert.rejects((bridge as any).markSessionActiveWithState(projectPath, undefined), /session is stopping/i);
});

test('status follows a replacement installed while a stale cache entry resolves', async () => {
  const bridge = new PiBridge();
  const projectPath = process.cwd();
  const sessionId = 'status-replacement-session';
  const cacheKey = (bridge as any).runtimeSessionCacheKey(projectPath, sessionId);
  let resolveStale: ((session: unknown) => void) | undefined;
  const stalePromise = new Promise((resolve) => { resolveStale = resolve; });
  const replacementSession = {
    sessionManager: {
      getEntries: () => [],
      getSessionName: () => 'replacement',
    },
  };
  (bridge as any).runtimeSessions.set(cacheKey, { promise: stalePromise, expiresAt: Date.now() + 60_000 });

  const status = bridge.status(projectPath, sessionId, 'project:status-replacement-session');
  await new Promise((resolve) => setTimeout(resolve, 1));
  (bridge as any).runtimeSessions.set(cacheKey, { promise: Promise.resolve(replacementSession), expiresAt: Date.now() + 60_000 });
  resolveStale?.({ sessionManager: { getEntries: () => [], getSessionName: () => 'stale' } });

  assert.equal((await status).sessionName, 'replacement');
});

test('status follows a replacement when a stale cache entry rejects', async () => {
  const bridge = new PiBridge();
  const projectPath = process.cwd();
  const sessionId = 'status-rejected-replacement-session';
  const cacheKey = (bridge as any).runtimeSessionCacheKey(projectPath, sessionId);
  let rejectStale: ((error: Error) => void) | undefined;
  const stalePromise = new Promise((_resolve, reject) => { rejectStale = reject; });
  void stalePromise.catch(() => undefined);
  const replacementSession = {
    sessionManager: {
      getEntries: () => [],
      getSessionName: () => 'replacement-after-rejection',
    },
  };
  (bridge as any).runtimeSessions.set(cacheKey, { promise: stalePromise, expiresAt: Date.now() + 60_000 });

  const status = bridge.status(projectPath, sessionId, 'project:status-rejected-replacement-session');
  await new Promise((resolve) => setTimeout(resolve, 10));
  (bridge as any).runtimeSessions.set(cacheKey, { promise: Promise.resolve(replacementSession), expiresAt: Date.now() + 60_000 });
  rejectStale?.(new Error('stale session failed'));

  assert.equal((await status).sessionName, 'replacement-after-rejection');
});

test('uses the retained manager and named Pi Web review extension for durable sessions only', async () => {
  const sessionDir = `/tmp/pi-web-review-loader-${randomUUID()}`;
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  try {
    const projectPath = process.cwd();
    const sessionId = sessionIdFromPath(await createSessionFile(projectPath));
    const retainedSessionManager = await sessionManagerForSession(sessionId, projectPath);
    let loaderOptions: Record<string, any> | undefined;
    let reloads = 0;
    let createOptions: Record<string, any> | undefined;
    const bridge = new PiBridge();
    (bridge as any).loadSdk = async () => ({
      DefaultResourceLoader: class {
        constructor(options: Record<string, any>) { loaderOptions = options; }
        async reload() { reloads += 1; }
      },
      SettingsManager: { create: () => ({ source: 'settings' }) },
      SessionManager: {
        open: () => { throw new Error('durable sessions must use the server-retained session manager'); },
      },
      createAgentSession: async (options: Record<string, any>) => {
        createOptions = options;
        return { session: {} };
      },
    });

    await (bridge as any).getSession(projectPath, sessionId);

    assert.equal(reloads, 1);
    assert.equal(loaderOptions?.cwd, projectPath);
    assert.equal(loaderOptions?.extensionFactories.length, 1);
    assert.equal(loaderOptions?.extensionFactories[0].name, 'pi-web-review');
    assert.equal(createOptions?.resourceLoader instanceof Object, true);
    assert.equal(createOptions?.settingsManager, loaderOptions?.settingsManager);
    assert.equal(createOptions?.sessionManager, retainedSessionManager);

    let sessionlessCreateOptions: Record<string, any> | undefined;
    const sessionlessBridge = new PiBridge();
    (sessionlessBridge as any).loadSdk = async () => ({
      DefaultResourceLoader: class {
        constructor() { throw new Error('sessionless command discovery must not add the review extension'); }
      },
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: async (options: Record<string, any>) => {
        sessionlessCreateOptions = options;
        return { session: {} };
      },
    });

    assert.deepEqual(await sessionlessBridge.commands(projectPath), []);
    assert.equal(sessionlessCreateOptions?.resourceLoader, undefined);
  } finally {
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
    await rm(sessionDir, { recursive: true, force: true });
  }
});

test('bounds session creation and disposes a late runtime', async () => {
  const bridge = new PiBridge({ sessionCreateTimeoutMs: 5 });
  let finishCreation: ((value: unknown) => void) | undefined;
  let disposed = 0;
  (bridge as any).loadSdk = async () => ({
    SessionManager: { create: () => ({ getSessionFile: () => undefined, appendSessionInfo: () => undefined }) },
    createAgentSession: () => new Promise((resolve) => { finishCreation = resolve; }),
  });

  await assert.rejects((bridge as any).getSession(process.cwd()), /initialization timed out/i);
  assert.equal((bridge as any).runtimeSessions.size, 0);

  finishCreation?.({ session: { dispose: () => { disposed += 1; } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(disposed, 1);
});

test('rejected manual compaction recovers its cached runtime once', async () => {
  const bridge = new PiBridge();
  const events: Array<{ type?: string }> = [];
  let listener: ((event: unknown) => void) | undefined;
  let disposed = 0;
  const session = {
    subscribe: (next: (event: unknown) => void) => {
      listener = next;
      return () => { listener = undefined; };
    },
    compact: async () => {
      listener?.({ type: 'compaction_end', aborted: false, willRetry: false, errorMessage: 'Summarization failed' });
      throw new Error('Summarization failed');
    },
    dispose: () => { disposed += 1; },
  };
  (bridge as any).markSessionActive = async () => () => undefined;
  (bridge as any).getSession = async () => session;
  (bridge as any).broadcast = (_key: string, event: { type?: string }) => { events.push(event); };

  await assert.rejects(
    bridge.compact(process.cwd(), { sessionId: 'manual-compaction-session' }, 'project:manual-compaction-session'),
    /Summarization failed/i,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(events.filter((event) => event.type === 'agent:error').length, 1);
  assert.equal(disposed, 1);
});

test('cancelled manual compaction preserves its healthy runtime', async () => {
  const bridge = new PiBridge();
  const events: Array<{ type?: string }> = [];
  let listener: ((event: unknown) => void) | undefined;
  let disposed = 0;
  const session = {
    subscribe: (next: (event: unknown) => void) => {
      listener = next;
      return () => { listener = undefined; };
    },
    compact: async () => {
      listener?.({ type: 'compaction_end', aborted: true, willRetry: false });
      throw new Error('Compaction aborted');
    },
    dispose: () => { disposed += 1; },
  };
  (bridge as any).markSessionActive = async () => () => undefined;
  (bridge as any).getSession = async () => session;
  (bridge as any).broadcast = (_key: string, event: { type?: string }) => { events.push(event); };

  await assert.rejects(
    bridge.compact(process.cwd(), { sessionId: 'cancelled-compaction-session' }, 'project:cancelled-compaction-session'),
    /Compaction aborted/i,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(events.filter((event) => event.type === 'agent:error').length, 1);
  assert.equal(disposed, 0);
});

test('dispose closes sockets and cached SDK sessions', async () => {
  const bridge = new PiBridge();
  let disposed = 0;
  let socketsClosed = 0;
  const runtimeSession = { dispose: () => { disposed += 1; } };
  const commandSession = { dispose: () => { disposed += 1; } };
  (bridge as any).runtimeSessions.set('runtime', { promise: Promise.resolve(runtimeSession), expiresAt: Date.now() + 60_000 });
  (bridge as any).commandSessions.set('command', { promise: Promise.resolve(commandSession), expiresAt: Date.now() + 60_000 });
  (bridge as any).sockets.set('socket', new Set([{ readyState: 1, send: () => undefined, close: () => { socketsClosed += 1; }, on: () => undefined }]));

  await bridge.dispose({ timeoutMs: 50 });

  assert.equal(disposed, 2);
  assert.equal(socketsClosed, 1);
  await assert.rejects((bridge as any).getSession(process.cwd(), 'closed-session'), /shutting down/i);
});

test('lists config-refreshed model snapshots from the session runtime', async () => {
  let refreshes = 0;
  let refreshFinished = false;
  const calls: Array<[string, string | undefined]> = [];
  const bridge = new PiBridge();
  (bridge as any).getCommandSession = async (projectPath: string, sessionId?: string) => {
    calls.push([projectPath, sessionId]);
    return {
      modelRuntime: {
        reloadConfig: async () => {
          await Promise.resolve();
          refreshes += 1;
          refreshFinished = true;
        },
        getAvailableSnapshot: () => {
          assert.equal(refreshFinished, true);
          return [
            { provider: 'openai', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } },
            { provider: 'ollama', id: 'llama3.1:8b', reasoning: false },
          ];
        },
        getProvider: (provider: string) => ({ name: provider.toUpperCase() }),
      },
    };
  };

  const models = await bridge.models('/workspace', 'session-1');

  assert.deepEqual(calls, [['/workspace', 'session-1']]);
  assert.equal(refreshes, 1);
  assert.deepEqual(models, [
    {
      value: 'openai/gpt-5.6-sol',
      label: 'GPT-5.6 Sol · OPENAI',
      provider: 'openai',
      id: 'gpt-5.6-sol',
      reasoning: true,
      thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      value: 'ollama/llama3.1:8b',
      label: 'llama3.1:8b · OLLAMA',
      provider: 'ollama',
      id: 'llama3.1:8b',
      reasoning: false,
      thinkingLevels: ['off'],
    },
  ]);
});

test('resolves selected models through the session runtime', async () => {
  const bridge = new PiBridge();
  const selected: unknown[] = [];
  const model = { provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' };
  const session = {
    modelRuntime: {
      getModels: () => [model],
      getModel: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
      getAvailable: async () => [model],
    },
    setModel: async (next: unknown) => { selected.push(next); },
  };

  await (bridge as any).setSessionModel(session, 'openai-codex/gpt-5.6-sol:max');

  assert.deepEqual(selected, [model]);
});

test('uses SDK session totals and provider subscription state in status', () => {
  const bridge = new PiBridge();
  const oauthChecks: string[] = [];
  const status = (bridge as any).agentStatus({
    model: { provider: 'openai-codex', contextWindow: 272_000 },
    modelRuntime: {
      isUsingOAuth: (provider: string) => {
        oauthChecks.push(provider);
        return true;
      },
    },
    getSessionStats: () => ({
      tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 4, total: 154 },
      cost: 1.25,
      contextUsage: { tokens: 68_000, contextWindow: 272_000, percent: 25 },
    }),
    sessionManager: { getSessionName: () => 'SDK migration' },
    autoCompactionEnabled: true,
  }, 'main');

  assert.deepEqual(oauthChecks, ['openai-codex']);
  assert.deepEqual(status.usage, { input: 100, output: 20, cacheRead: 30, cacheWrite: 4, total: 154, cost: 1.25, subscription: true });
  assert.deepEqual(status.context, { tokens: 68_000, contextWindow: 272_000, percent: 25, autoCompact: true });
  assert.equal(status.sessionName, 'SDK migration');

  const kimiStatus = (bridge as any).agentStatus({
    model: { provider: 'kimi-coding' },
    modelRuntime: { isUsingOAuth: () => false },
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    sessionManager: { getSessionName: () => undefined },
  });
  assert.equal(kimiStatus.usage.subscription, true);
});
