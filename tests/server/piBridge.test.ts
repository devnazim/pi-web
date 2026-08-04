import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { PiBridge } from '../../src/server/piBridge.js';
import { createSessionFile, listSessions, sessionManagerForSession } from '../../src/server/sessions.js';
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

test('publishes idle status after a state-only extension command', async () => {
  const bridge = new PiBridge();
  const events: Array<{ type?: string; operationId?: string; data?: { running?: boolean; statuses?: unknown[] } }> = [];
  const session = {
    extensionRunner: { getCommand: (name: string) => name === 'state-only' ? {} : undefined },
    prompt: async () => undefined,
  };
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => undefined });
  (bridge as any).getSession = async () => session;
  (bridge as any).waitForCommandActivity = async () => undefined;
  (bridge as any).broadcast = (_key: string, event: { type?: string; operationId?: string; data?: { running?: boolean; statuses?: unknown[] } }) => { events.push(event); };

  await bridge.prompt(process.cwd(), { sessionId: 'state-only-session', prompt: '/state-only' }, 'project:state-only-session');

  assert.equal(events.some((event) => event.type === 'agent:start' || event.type === 'agent:finish'), false);
  const status = events.find((event) => event.type === 'agent:status');
  assert.equal(typeof status?.operationId, 'string');
  assert.deepEqual(status?.data, { running: false, statuses: [] });
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

test('runs input hooks and tags a delivered steering message with its client message id', async () => {
  const bridge = new PiBridge();
  const events: Array<{ type?: string; data?: { type?: string; clientMessageId?: string; message?: { role?: string; content?: unknown } } }> = [];
  let listener: ((event: unknown) => void) | undefined;
  let finishInitialPrompt: (() => void) | undefined;
  const session = {
    isStreaming: false,
    subscribe: (next: (event: unknown) => void) => {
      listener = next;
      return () => { listener = undefined; };
    },
    prompt: (prompt: string, options: { preflightResult?: (success: boolean) => void }) => {
      options.preflightResult?.(true);
      if (prompt === 'first') {
        session.isStreaming = true;
        queueMicrotask(() => {
          listener?.({ type: 'agent_start' });
          listener?.({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: prompt }] } });
        });
        return new Promise<void>((resolve) => {
          finishInitialPrompt = () => {
            session.isStreaming = false;
            listener?.({ type: 'agent_settled' });
            resolve();
          };
        });
      }
      return Promise.resolve();
    },
    extensionRunner: {
      hasHandlers: (type: string) => type === 'input',
      emitInput: async (text: string, _images: unknown, source: string, streamingBehavior: string) => {
        assert.equal(source, 'rpc');
        assert.equal(streamingBehavior, 'steer');
        return { action: 'transform', text: `transformed ${text}` };
      },
    },
    steer: (prompt: string) => {
      listener?.({ type: 'queue_update', steering: [prompt], followUp: [] });
      listener?.({ type: 'queue_update', steering: [], followUp: [] });
      listener?.({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: prompt }] } });
      return Promise.resolve();
    },
    dispose: () => undefined,
  };
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => undefined });
  (bridge as any).getSession = async () => session;
  (bridge as any).broadcast = (_key: string, event: { type?: string; data?: { type?: string; clientMessageId?: string; message?: { role?: string; content?: unknown } } }) => { events.push(event); };

  const activePrompt = bridge.prompt(process.cwd(), { sessionId: 'steering-session', prompt: 'first' }, 'project:steering-session');
  await new Promise((resolve) => setTimeout(resolve, 1));
  await bridge.prompt(process.cwd(), {
    sessionId: 'steering-session',
    prompt: 'second',
    streamingBehavior: 'steer',
    clientMessageId: 'client-message-1',
  }, 'project:steering-session');

  const userStarts = events.filter((event) => event.type === 'agent:event' && event.data?.type === 'message_start' && event.data.message?.role === 'user');
  assert.equal(userStarts.length, 2);
  assert.equal(userStarts[0].data?.clientMessageId, undefined);
  assert.equal(userStarts[1].data?.clientMessageId, 'client-message-1');
  assert.deepEqual(userStarts[1].data?.message?.content, [{ type: 'text', text: 'transformed second' }]);

  finishInitialPrompt?.();
  await activePrompt;
});

test('rejects steering when the active stream settles before dispatch', async () => {
  const bridge = new PiBridge();
  let promptCalls = 0;
  const session = {
    isStreaming: true,
    prompt: async () => { promptCalls += 1; },
    steer: async () => { promptCalls += 1; },
  };
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => undefined });
  (bridge as any).getSession = async () => session;
  (bridge as any).applySessionControls = async () => { session.isStreaming = false; };
  (bridge as any).broadcast = () => undefined;

  await assert.rejects(bridge.prompt(process.cwd(), {
    sessionId: 'settled-steering-session',
    prompt: 'too late',
    streamingBehavior: 'steer',
    clientMessageId: 'client-message-1',
  }, 'project:settled-steering-session'), /finished before the queued message/i);
  assert.equal(promptCalls, 0);
});

test('rejects steering when the active stream settles during an input hook', async () => {
  const bridge = new PiBridge();
  let finishInputHook: (() => void) | undefined;
  let steerCalls = 0;
  const session = {
    isStreaming: true,
    extensionRunner: {
      hasHandlers: (type: string) => type === 'input',
      emitInput: async () => {
        await new Promise<void>((resolve) => { finishInputHook = resolve; });
        return { action: 'transform', text: 'transformed' };
      },
    },
    steer: async () => { steerCalls += 1; },
  };
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => undefined });
  (bridge as any).getSession = async () => session;
  (bridge as any).broadcast = () => undefined;

  const steering = bridge.prompt(process.cwd(), {
    sessionId: 'settled-during-hook-session',
    prompt: 'too late',
    streamingBehavior: 'steer',
    clientMessageId: 'client-message-1',
  }, 'project:settled-during-hook-session');
  await new Promise((resolve) => setTimeout(resolve, 0));
  session.isStreaming = false;
  finishInputHook?.();

  await assert.rejects(steering, /finished before the queued message/i);
  assert.equal(steerCalls, 0);
  assert.equal((bridge as any).streamingDispatchTails.size, 0);
});

test('handled streaming input releases the dispatch gate for the next prompt', async () => {
  const bridge = new PiBridge();
  const steerCalls: string[] = [];
  const session = {
    isStreaming: true,
    extensionRunner: {
      hasHandlers: (type: string) => type === 'input',
      emitInput: async (text: string) => text === 'handled' ? { action: 'handled' } : { action: 'continue' },
    },
    steer: async (prompt: string) => { steerCalls.push(prompt); },
  };
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => undefined });
  (bridge as any).getSession = async () => session;
  (bridge as any).broadcast = () => undefined;

  await Promise.all([
    bridge.prompt(process.cwd(), { sessionId: 'handled-input-session', prompt: 'handled', streamingBehavior: 'steer' }, 'project:handled-input-session'),
    bridge.prompt(process.cwd(), { sessionId: 'handled-input-session', prompt: 'queued next', streamingBehavior: 'steer' }, 'project:handled-input-session'),
  ]);

  assert.deepEqual(steerCalls, ['queued next']);
  assert.equal((bridge as any).streamingDispatchTails.size, 0);
});

test('keeps later steering requests behind an earlier request when the middle request fails', async () => {
  const bridge = new PiBridge();
  const steerCalls: string[] = [];
  let releaseFirstPreparation: (() => void) | undefined;
  const session = {
    isStreaming: true,
    steer: async (prompt: string) => { steerCalls.push(prompt); },
  };
  (bridge as any).markSessionActiveWithState = async () => ({ wasActive: false, release: () => undefined });
  (bridge as any).getSession = async () => session;
  (bridge as any).preparePromptAttachments = async (_projectPath: string, prompt: string) => {
    if (prompt === 'first') await new Promise<void>((resolve) => { releaseFirstPreparation = resolve; });
    if (prompt === 'second') throw new Error('second preparation failed');
    return { prompt, images: [] };
  };
  (bridge as any).broadcast = () => undefined;

  const first = bridge.prompt(process.cwd(), { sessionId: 'ordered-steering-session', prompt: 'first', streamingBehavior: 'steer' }, 'project:ordered-steering-session');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = bridge.prompt(process.cwd(), { sessionId: 'ordered-steering-session', prompt: 'second', streamingBehavior: 'steer' }, 'project:ordered-steering-session');
  await assert.rejects(second, /second preparation failed/);
  const third = bridge.prompt(process.cwd(), { sessionId: 'ordered-steering-session', prompt: 'third', streamingBehavior: 'steer' }, 'project:ordered-steering-session');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(steerCalls, []);

  releaseFirstPreparation?.();
  await Promise.all([first, third]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(steerCalls, ['first', 'third']);
  assert.equal((bridge as any).streamingDispatchTails.size, 0);
});

test('does not consume unconfirmed client message registrations', () => {
  const bridge = new PiBridge();
  const session = {};
  (bridge as any).pendingStreamingClientMessages.set(session, [
    { token: 'unconfirmed', behavior: 'steer', clientMessageId: 'client-message-1', queued: false },
  ]);

  const event = (bridge as any).agentEventWithClientMessageId(session, { type: 'message_start', message: { role: 'user', content: [] } }, 'message_start');

  assert.equal(event.clientMessageId, undefined);
  assert.equal((bridge as any).pendingStreamingClientMessages.get(session).length, 1);
});

test('tags the first observed user message when a steering message was delivered', () => {
  const bridge = new PiBridge();
  const session = {};
  (bridge as any).deliveredStreamingClientMessages.set(session, [
    { token: 'tagged-steer', behavior: 'steer', clientMessageId: 'client-message-1', queued: true },
  ]);

  const event = (bridge as any).agentEventWithClientMessageId(session, { type: 'message_start', message: { role: 'user', content: [] } }, 'message_start');

  assert.equal(event.clientMessageId, 'client-message-1');
  assert.equal((bridge as any).deliveredStreamingClientMessages.has(session), false);
});

test('matches client ids to dequeued SDK messages', () => {
  const bridge = new PiBridge();
  const session = {};
  const followUp = { token: 'follow-up', behavior: 'followUp', queued: true };
  const steer = { token: 'tagged-steer', behavior: 'steer', clientMessageId: 'client-message-1', queued: false };
  (bridge as any).pendingStreamingClientMessages.set(session, [followUp, steer]);
  (bridge as any).streamingQueueSlots.set(session, { steer: [], followUp: [followUp] });
  const userStart = { type: 'message_start', message: { role: 'user', content: [] } };

  (bridge as any).agentEventWithClientMessageId(session, { type: 'queue_update', steering: [], followUp: [] }, 'queue_update');
  (bridge as any).agentEventWithClientMessageId(session, { type: 'queue_update', steering: ['new steer'], followUp: [] }, 'queue_update');
  const deliveredFollowUp = (bridge as any).agentEventWithClientMessageId(session, userStart, 'message_start');
  (bridge as any).agentEventWithClientMessageId(session, { type: 'queue_update', steering: [], followUp: [] }, 'queue_update');
  const deliveredSteer = (bridge as any).agentEventWithClientMessageId(session, userStart, 'message_start');

  assert.equal(deliveredFollowUp.clientMessageId, undefined);
  assert.equal(deliveredSteer.clientMessageId, 'client-message-1');
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
    steer: () => {
      promptCalls += 1;
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

test('uses one pending runtime for command discovery, completion, and execution', async () => {
  const sessionDir = `/tmp/pi-web-review-loader-${randomUUID()}`;
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  try {
    const projectPath = process.cwd();
    const sessionFile = await createSessionFile(projectPath);
    const sessionId = sessionIdFromPath(sessionFile);
    const retainedSessionManager = await sessionManagerForSession(sessionId, projectPath);
    let loaderOptions: Record<string, any> | undefined;
    let reloads = 0;
    let createOptions: Record<string, any> | undefined;
    let creates = 0;
    let completionObserved = false;
    const probeCommand = {
      name: 'runtime-probe',
      description: 'Authoritative runtime probe',
      getArgumentCompletions: async () => {
        completionObserved = true;
        return [{ value: 'same-runtime' }];
      },
    };
    const session = {
      extensionRunner: {
        getRegisteredCommands: () => [probeCommand],
        getCommand: (name: string) => name === probeCommand.name ? probeCommand : undefined,
      },
      prompt: async (prompt: string, options: { preflightResult?: (success: boolean) => void }) => {
        assert.equal(completionObserved, true);
        retainedSessionManager.appendMessage({ role: 'user', content: prompt, timestamp: Date.now() } as any);
        retainedSessionManager.appendMessage({
          role: 'assistant',
          content: [],
          api: 'test',
          provider: 'test',
          model: 'test',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop',
          timestamp: Date.now(),
        } as any);
        options.preflightResult?.(true);
      },
    };
    const bridge = new PiBridge();
    (bridge as any).loadSdk = async () => ({
      DefaultResourceLoader: class {
        constructor(options: Record<string, any>) { loaderOptions = options; }
        async reload() { reloads += 1; }
      },
      SettingsManager: { create: () => ({ source: 'settings' }) },
      SessionManager: {
        open: () => { throw new Error('pending sessions must use the server-retained session manager'); },
      },
      createAgentSession: async (options: Record<string, any>) => {
        creates += 1;
        createOptions = options;
        return { session };
      },
    });

    const commands = await bridge.commands(projectPath, sessionId);
    const completions = await bridge.commandCompletions(projectPath, { sessionId, command: probeCommand.name });
    assert.equal(existsSync(sessionFile), false);
    assert.deepEqual(await listSessions('project', projectPath), []);

    await bridge.prompt(projectPath, { sessionId, prompt: 'Use the authoritative runtime' }, `project:${sessionId}`);

    assert.equal(creates, 1);
    assert.equal(reloads, 1);
    assert.equal(commands.some((command) => command.name === probeCommand.name && command.hasArgumentCompletions), true);
    assert.deepEqual(completions, [{ value: 'same-runtime', label: undefined, description: undefined }]);
    assert.equal(loaderOptions?.cwd, projectPath);
    assert.equal(loaderOptions?.extensionFactories.length, 1);
    assert.equal(loaderOptions?.extensionFactories[0].name, 'pi-web-review');
    assert.equal(createOptions?.resourceLoader instanceof Object, true);
    assert.equal(createOptions?.settingsManager, loaderOptions?.settingsManager);
    assert.equal(createOptions?.sessionManager, retainedSessionManager);
    assert.equal(existsSync(sessionFile), true);
    assert.deepEqual((await listSessions('project', projectPath)).map(({ id }) => id), [sessionId]);
    await bridge.dispose({ timeoutMs: 50 });
  } finally {
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
    await rm(sessionDir, { recursive: true, force: true });
  }
});

test('requires a reserved session for extension-backed discovery', async () => {
  const bridge = new PiBridge();

  await assert.rejects(bridge.commands('/workspace'), /missing session id/i);
  await assert.rejects(bridge.agents('/workspace'), /missing session id/i);
  await assert.rejects(bridge.commandCompletions('/workspace', { command: 'probe' }), /missing session id/i);
});

test('runtime-backed command completion blocks deletion without reporting agent activity', async () => {
  const bridge = new PiBridge();
  const projectPath = process.cwd();
  const sessionId = 'leased-completion-session';
  const cacheKey = (bridge as any).runtimeSessionCacheKey(projectPath, sessionId);
  let releaseCompletion!: (value: Array<{ value: string }>) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const session = {
    extensionRunner: {
      getCommand: () => ({
        getArgumentCompletions: () => {
          markStarted();
          return new Promise<Array<{ value: string }>>((resolve) => { releaseCompletion = resolve; });
        },
      }),
    },
  };
  const entry = { promise: Promise.resolve(session), expiresAt: Date.now() + 60_000 };
  (bridge as any).runtimeSessions.set(cacheKey, entry);
  (bridge as any).runtimeSessionEntries.set(session, entry);

  const completion = bridge.commandCompletions(projectPath, { sessionId, command: 'probe' });
  await started;
  assert.equal(await bridge.isSessionActive(projectPath, sessionId), false);
  assert.equal(await bridge.lockSessionDeletion(projectPath, sessionId), undefined);

  releaseCompletion([{ value: 'done' }]);
  assert.deepEqual(await completion, [{ value: 'done', label: undefined, description: undefined }]);
  const releaseDeletion = await bridge.lockSessionDeletion(projectPath, sessionId);
  assert.equal(typeof releaseDeletion, 'function');
  releaseDeletion?.();
  await bridge.dispose();
});

test('runtime recovery defers disposal until an in-flight completion rejects as stale', async () => {
  const bridge = new PiBridge();
  const projectPath = process.cwd();
  const sessionId = 'recovered-completion-session';
  const cacheKey = (bridge as any).runtimeSessionCacheKey(projectPath, sessionId);
  let releaseCompletion!: (value: Array<{ value: string }>) => void;
  let markStarted!: () => void;
  let disposed = 0;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const session = {
    extensionRunner: {
      getCommand: () => ({
        getArgumentCompletions: () => {
          markStarted();
          return new Promise<Array<{ value: string }>>((resolve) => { releaseCompletion = resolve; });
        },
      }),
    },
    dispose: () => { disposed += 1; },
  };
  const entry = { promise: Promise.resolve(session), expiresAt: Date.now() + 60_000 };
  (bridge as any).runtimeSessions.set(cacheKey, entry);
  (bridge as any).runtimeSessionEntries.set(session, entry);

  const completion = bridge.commandCompletions(projectPath, { sessionId, command: 'probe' });
  await started;
  (bridge as any).recoverRuntimeSession(projectPath, sessionId, session, 'runtime reset');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(disposed, 0);

  releaseCompletion([{ value: 'stale' }]);
  await assert.rejects(completion, /runtime changed/i);
  for (let attempt = 0; attempt < 50 && !disposed; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(disposed, 1);
  await bridge.dispose();
});

test('agent completions reject results from a recovered runtime generation', async () => {
  const bridge = new PiBridge();
  const projectPath = process.cwd();
  const sessionId = 'recovered-agent-completion-session';
  const cacheKey = (bridge as any).runtimeSessionCacheKey(projectPath, sessionId);
  let releaseCompletion!: (value: Array<{ value: string }>) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const session = {
    extensionRunner: { getCommand: (name: string) => name === 'agent' ? {} : undefined },
  };
  const entry = { promise: Promise.resolve(session), expiresAt: Date.now() + 60_000 };
  (bridge as any).runtimeSessions.set(cacheKey, entry);
  (bridge as any).runtimeSessionEntries.set(session, entry);
  (bridge as any).agentCommandCompletions = () => {
    markStarted();
    return new Promise<Array<{ value: string }>>((resolve) => { releaseCompletion = resolve; });
  };

  const completion = bridge.commandCompletions(projectPath, { sessionId, command: 'agent' });
  await started;
  (bridge as any).recoverRuntimeSession(projectPath, sessionId, session, 'runtime reset');
  releaseCompletion([{ value: 'stale-agent' }]);
  await assert.rejects(completion, /runtime changed/i);
  await bridge.dispose();
});

test('cache eviction waits for runtime read leases', async () => {
  const bridge = new PiBridge();
  const projectPath = process.cwd();
  const sessionId = 'evicted-completion-session';
  const cacheKey = (bridge as any).runtimeSessionCacheKey(projectPath, sessionId);
  let releaseCompletion!: (value: Array<{ value: string }>) => void;
  let markStarted!: () => void;
  let disposed = 0;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const session = {
    extensionRunner: {
      getCommand: () => ({
        getArgumentCompletions: () => {
          markStarted();
          return new Promise<Array<{ value: string }>>((resolve) => { releaseCompletion = resolve; });
        },
      }),
    },
    dispose: () => { disposed += 1; },
  };
  const entry = { promise: Promise.resolve(session), expiresAt: Date.now() + 60_000 };
  (bridge as any).runtimeSessions.set(cacheKey, entry);
  (bridge as any).runtimeSessionEntries.set(session, entry);

  const completion = bridge.commandCompletions(projectPath, { sessionId, command: 'probe' });
  await started;
  entry.expiresAt = 0;
  await (bridge as any).evictCachedSession((bridge as any).runtimeSessions, cacheKey, entry);
  assert.equal((bridge as any).runtimeSessions.get(cacheKey), entry);
  assert.equal(disposed, 0);
  if ((entry as any).timer) clearTimeout((entry as any).timer);

  releaseCompletion([{ value: 'current' }]);
  assert.deepEqual(await completion, [{ value: 'current', label: undefined, description: undefined }]);
  entry.expiresAt = 0;
  await (bridge as any).evictCachedSession((bridge as any).runtimeSessions, cacheKey, entry);
  assert.equal(disposed, 1);
  await bridge.dispose();
});

test('bounded shutdown does not poll forever for a hung recovered runtime read', async () => {
  const bridge = new PiBridge();
  const projectPath = process.cwd();
  const sessionId = 'hung-shutdown-completion-session';
  const cacheKey = (bridge as any).runtimeSessionCacheKey(projectPath, sessionId);
  let releaseCompletion!: (value: Array<{ value: string }>) => void;
  let markStarted!: () => void;
  let disposed = 0;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const session = {
    extensionRunner: {
      getCommand: () => ({
        getArgumentCompletions: () => {
          markStarted();
          return new Promise<Array<{ value: string }>>((resolve) => { releaseCompletion = resolve; });
        },
      }),
    },
    dispose: () => { disposed += 1; },
  };
  const entry = { promise: Promise.resolve(session), expiresAt: Date.now() + 60_000 };
  (bridge as any).runtimeSessions.set(cacheKey, entry);
  (bridge as any).runtimeSessionEntries.set(session, entry);

  const completion = bridge.commandCompletions(projectPath, { sessionId, command: 'probe' });
  await started;
  (bridge as any).recoverRuntimeSession(projectPath, sessionId, session, 'runtime reset');
  const startedAt = Date.now();
  await bridge.dispose({ timeoutMs: 20 });
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(disposed, 0);

  releaseCompletion([{ value: 'late' }]);
  await assert.rejects(completion, /shutting down|runtime changed/i);
  for (let attempt = 0; attempt < 50 && !disposed; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(disposed, 1);
});

test('shutdown waits for runtime reads before disposing their SDK session', async () => {
  const bridge = new PiBridge();
  const projectPath = process.cwd();
  const sessionId = 'shutdown-completion-session';
  const cacheKey = (bridge as any).runtimeSessionCacheKey(projectPath, sessionId);
  let releaseCompletion!: (value: Array<{ value: string }>) => void;
  let markStarted!: () => void;
  let disposed = 0;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const session = {
    extensionRunner: {
      getCommand: () => ({
        getArgumentCompletions: () => {
          markStarted();
          return new Promise<Array<{ value: string }>>((resolve) => { releaseCompletion = resolve; });
        },
      }),
    },
    dispose: () => { disposed += 1; },
  };
  const entry = { promise: Promise.resolve(session), expiresAt: Date.now() + 60_000 };
  (bridge as any).runtimeSessions.set(cacheKey, entry);
  (bridge as any).runtimeSessionEntries.set(session, entry);

  const completion = bridge.commandCompletions(projectPath, { sessionId, command: 'probe' });
  await started;
  const disposal = bridge.dispose({ timeoutMs: 1_000 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(disposed, 0);

  releaseCompletion([{ value: 'late' }]);
  await assert.rejects(completion, /shutting down|runtime changed/i);
  await disposal;
  assert.equal(disposed, 1);
});

test('session mutation leases block deletion without reporting agent activity', async () => {
  const bridge = new PiBridge();
  const projectPath = process.cwd();
  const sessionId = 'upload-mutation-session';
  const releaseMutation = await bridge.lockSessionMutation(projectPath, sessionId);
  assert.equal(typeof releaseMutation, 'function');
  assert.equal(await bridge.isSessionActive(projectPath, sessionId), false);
  assert.equal(await bridge.lockSessionDeletion(projectPath, sessionId), undefined);
  const operationLock = await (bridge as any).markSessionActiveWithState(projectPath, sessionId);
  assert.equal(operationLock.wasActive, true);
  operationLock.release();

  releaseMutation?.();
  const releaseDeletion = await bridge.lockSessionDeletion(projectPath, sessionId);
  assert.equal(typeof releaseDeletion, 'function');
  releaseDeletion?.();
  await bridge.dispose();
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
  (bridge as any).runtimeSessions.set('runtime', { promise: Promise.resolve(runtimeSession), expiresAt: Date.now() + 60_000 });
  (bridge as any).sockets.set('socket', new Set([{ readyState: 1, send: () => undefined, close: () => { socketsClosed += 1; }, on: () => undefined }]));

  await bridge.dispose({ timeoutMs: 50 });

  assert.equal(disposed, 1);
  assert.equal(socketsClosed, 1);
  await assert.rejects((bridge as any).getSession(process.cwd(), 'closed-session'), /shutting down/i);
  await assert.rejects(bridge.models(process.cwd()), /shutting down/i);
});

test('does not start a sessionless model runtime after disposal begins', async () => {
  let resolveSdk: ((sdk: unknown) => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let creates = 0;
  const bridge = new PiBridge();
  (bridge as any).loadSdk = () => {
    markStarted?.();
    return new Promise((resolve) => { resolveSdk = resolve; });
  };

  const models = bridge.models('/workspace');
  await started;
  await bridge.dispose({ timeoutMs: 50 });
  resolveSdk?.({ ModelRuntime: { create: async () => { creates += 1; return {}; } } });

  await assert.rejects(models, /shutting down/i);
  assert.equal(creates, 0);
});

test('does not publish an in-flight sessionless model list after disposal', async () => {
  let resolveRuntime: ((runtime: unknown) => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let refreshes = 0;
  const bridge = new PiBridge();
  (bridge as any).loadSdk = async () => ({
    ModelRuntime: {
      create: () => {
        markStarted?.();
        return new Promise((resolve) => { resolveRuntime = resolve; });
      },
    },
  });

  const models = bridge.models('/workspace');
  await started;
  await bridge.dispose({ timeoutMs: 50 });
  resolveRuntime?.({
    refresh: async () => { refreshes += 1; },
    getAvailableSnapshot: () => [],
  });

  await assert.rejects(models, /shutting down/i);
  assert.equal(refreshes, 0);
});

test('lists sessionless settings models without creating an extension runtime', async () => {
  let creates = 0;
  let refreshes = 0;
  const runtime = {
    refresh: async () => { refreshes += 1; },
    getAvailableSnapshot: () => [{ provider: 'openai', id: 'gpt-test', name: 'GPT Test', reasoning: false }],
    getProvider: () => ({ name: 'OpenAI' }),
  };
  const bridge = new PiBridge();
  (bridge as any).loadSdk = async () => ({
    ModelRuntime: { create: async () => runtime },
    createAgentSession: async () => {
      creates += 1;
      return { session: {} };
    },
  });

  assert.deepEqual(await bridge.models('/workspace'), [{
    value: 'openai/gpt-test',
    label: 'GPT Test · OpenAI',
    provider: 'openai',
    id: 'gpt-test',
    reasoning: false,
    thinkingLevels: ['off'],
  }]);
  assert.equal(refreshes, 1);
  assert.equal(creates, 0);
});

test('lists config-refreshed model snapshots from the session runtime', async () => {
  let refreshes = 0;
  let refreshFinished = false;
  const calls: Array<[string, string | undefined]> = [];
  const bridge = new PiBridge();
  (bridge as any).runtimeSessionCurrent = () => true;
  (bridge as any).getCommandSession = async (projectPath: string, sessionId?: string) => {
    calls.push([projectPath, sessionId]);
    return {
      modelRuntime: {
        refresh: async () => {
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
