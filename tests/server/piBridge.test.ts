import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PiBridge } from '../../src/server/piBridge.js';

test('binds browser extension UI in RPC mode', async () => {
  const bridge = new PiBridge();
  let bindings: Record<string, unknown> | undefined;

  await (bridge as any).bindWebExtensions({
    bindExtensions: async (next: Record<string, unknown>) => { bindings = next; },
  }, '/workspace', 'session-1', 'project-1:session-1');

  assert.equal(bindings?.mode, 'rpc');
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

test('lists refreshed models from the session registry', async () => {
  let refreshes = 0;
  const calls: Array<[string, string | undefined]> = [];
  const bridge = new PiBridge();
  (bridge as any).getCommandSession = async (projectPath: string, sessionId?: string) => {
    calls.push([projectPath, sessionId]);
    return {
      modelRegistry: {
        refresh: () => { refreshes += 1; },
        getAvailable: () => [
          { provider: 'openai', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } },
          { provider: 'ollama', id: 'llama3.1:8b', reasoning: false },
        ],
        getProviderDisplayName: (provider: string) => provider.toUpperCase(),
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
