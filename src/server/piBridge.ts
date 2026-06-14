import { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { clearProjectFileCaches } from './files.js';
import { getGitBranch } from './git.js';
import type { ProjectRegistry } from './projects.js';
import { applyPendingSessionInfo, projectSessionDir, resolveSessionFile, sessionDetailFromManager } from './sessions.js';
import type { AgentEvent } from './types.js';
import { sessionIdFromPath } from './util.js';

type WebSocket = {
  readyState: number;
  send(data: string): void;
  close?(): void;
  on(event: 'close' | 'message', listener: (...args: any[]) => void): void;
};

type TreeSummaryOptions = { mode?: 'none' | 'summary' | 'custom'; instructions?: string; replace?: boolean };
type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

interface PromptBody {
  sessionId?: string;
  treeTargetId?: string;
  treeSummary?: TreeSummaryOptions;
  branchFromId?: string | null;
  prompt: string;
  model?: string;
  thinking?: string;
  attachments?: string[];
  mirrorActiveStream?: boolean;
}

interface NavigateTreeBody {
  sessionId?: string;
  targetId?: string;
  treeSummary?: TreeSummaryOptions;
}

interface BashBody {
  sessionId?: string;
  command?: string;
  excludeFromContext?: boolean;
  mirrorActiveStream?: boolean;
}

interface CompactBody {
  sessionId?: string;
  instructions?: string;
  mirrorActiveStream?: boolean;
}

interface CommandCompletionQuery {
  sessionId?: string;
  command?: string;
  prefix?: string;
}

type CommandInfo = {
  name: string;
  description?: string;
  source: 'builtin' | 'extension' | 'prompt' | 'skill';
  location?: string;
  path?: string;
  argumentHint?: string;
  hasArgumentCompletions?: boolean;
};

type CommandCompletion = { value: string; label?: string; description?: string };

type ModelInfo = { value: string; label: string; provider: string; id: string; reasoning: boolean; thinkingLevels: ThinkingLevel[] };

type AgentStatus = {
  branch?: string;
  sessionName?: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number; subscription: boolean };
  context?: { tokens: number | null; contextWindow: number; percent: number | null; autoCompact: boolean };
  statuses: Array<{ key: string; text: string }>;
};

type CachedSession = { promise: Promise<unknown>; expiresAt: number; timer?: NodeJS.Timeout };

const WEB_BUILTIN_COMMAND_NAMES = new Set(['compact']);
const SESSION_CACHE_TTL_MS = 30 * 60_000;
const SESSION_CACHE_BUSY_RETRY_MS = 60_000;

export class PiBridge {
  private readonly sockets = new Map<string, Set<WebSocket>>();
  private readonly notificationSockets = new Map<string, Set<WebSocket>>();
  private readonly runtimeSessions = new Map<string, CachedSession>();
  private readonly commandSessions = new Map<string, CachedSession>();
  private readonly boundSessions = new WeakSet<object>();
  private readonly sessionStreamKeys = new WeakMap<object, string | string[]>();
  private readonly extensionStatuses = new WeakMap<object, Map<string, string>>();
  private readonly activeRuntimeSessions = new Map<string, number>();
  private readonly deletingRuntimeSessions = new Set<string>();
  private readonly deletingRuntimeSessionFiles = new Set<string>();

  async loadSdk() {
    return import('@earendil-works/pi-coding-agent') as Promise<Record<string, any>>;
  }

  subscribe(key: string, socket: WebSocket) {
    const set = this.sockets.get(key) ?? new Set<WebSocket>();
    set.add(socket);
    this.sockets.set(key, set);
    socket.on('close', () => set.delete(socket));
  }

  subscribeNotifications(projectId: string, socket: WebSocket) {
    const set = this.notificationSockets.get(projectId) ?? new Set<WebSocket>();
    set.add(socket);
    this.notificationSockets.set(projectId, set);
    socket.on('close', () => set.delete(socket));
  }

  broadcast(key: string | string[], event: AgentEvent) {
    const payload = JSON.stringify(event);
    const keys = Array.isArray(key) ? new Set(key) : new Set([key]);
    for (const item of keys) {
      for (const socket of this.sockets.get(item) ?? []) {
        if (socket.readyState === 1) socket.send(payload);
      }
    }
    this.broadcastNotificationEvent(keys, event);
  }

  private broadcastNotificationEvent(keys: Set<string>, event: AgentEvent) {
    if (!isWorkspaceNotificationEvent(event)) return;
    const projectIds = new Set([...keys].map(projectIdFromStreamKey).filter((id): id is string => Boolean(id)));
    for (const projectId of projectIds) {
      const payload = JSON.stringify({ ...event, projectId });
      for (const socket of this.notificationSockets.get(projectId) ?? []) {
        if (socket.readyState === 1) socket.send(payload);
      }
    }
  }

  async isSessionActive(projectPath: string, sessionId: string, filePath?: string) {
    const keys = this.runtimeSessionCacheKeys(projectPath, sessionId, filePath);
    for (const key of keys) if (this.activeRuntimeSessions.has(key)) return true;
    for (const key of keys) {
      const cached = this.runtimeSessions.get(key);
      if (cached && this.cachedSessionInUse(await cached.promise.catch(() => undefined))) return true;
    }
    if (!filePath) return false;
    const targetPath = path.resolve(filePath);
    for (const [key, cached] of this.runtimeSessions) {
      if (keys.has(key) || !this.isRuntimeSessionCacheKeyForProject(projectPath, key)) continue;
      const session = await cached.promise.catch(() => undefined);
      if (this.cachedSessionFile(session) !== targetPath) continue;
      if (this.activeRuntimeSessions.has(key) || this.cachedSessionInUse(session)) return true;
    }
    return false;
  }

  async lockSessionDeletion(projectPath: string, sessionId: string, filePath?: string) {
    const keys = this.runtimeSessionCacheKeys(projectPath, sessionId, filePath);
    const fileKey = filePath ? path.resolve(filePath) : undefined;
    if ([...keys].some((key) => this.deletingRuntimeSessions.has(key)) || (fileKey && this.deletingRuntimeSessionFiles.has(fileKey))) return undefined;
    for (const key of keys) this.deletingRuntimeSessions.add(key);
    if (fileKey) this.deletingRuntimeSessionFiles.add(fileKey);

    let locked = true;
    const release = () => {
      if (!locked) return;
      locked = false;
      for (const key of keys) this.deletingRuntimeSessions.delete(key);
      if (fileKey) this.deletingRuntimeSessionFiles.delete(fileKey);
    };

    try {
      if (await this.isSessionActive(projectPath, sessionId, filePath)) {
        release();
        return undefined;
      }
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  async lockSessionMutation(projectPath: string, sessionId: string, filePath?: string) {
    return this.lockRuntimeSession(projectPath, sessionId, filePath);
  }

  async disposeSession(projectPath: string, sessionId: string, filePath?: string) {
    const keys = this.runtimeSessionCacheKeys(projectPath, sessionId, filePath);
    const entries: Array<[string, CachedSession]> = [];
    for (const key of keys) {
      const cached = this.runtimeSessions.get(key);
      if (cached) entries.push([key, cached]);
    }
    if (filePath) {
      const targetPath = path.resolve(filePath);
      for (const [key, cached] of this.runtimeSessions) {
        if (keys.has(key) || !this.isRuntimeSessionCacheKeyForProject(projectPath, key)) continue;
        const session = await cached.promise.catch(() => undefined);
        if (this.cachedSessionFile(session) === targetPath) entries.push([key, cached]);
      }
    }
    await Promise.all(entries.map(([key, cached]) => this.disposeCachedSessionEntry(this.runtimeSessions, key, cached)));
  }

  async renameSession(projectPath: string, sessionId: string, name: string, filePath?: string) {
    const cached = await this.findRuntimeSession(projectPath, sessionId, filePath);
    if (!cached) return undefined;
    const session = await cached.promise.catch(() => undefined) as any;
    const manager = session?.sessionManager ?? session;
    if (typeof manager?.appendSessionInfo !== 'function') return undefined;
    const currentName = typeof manager?.getSessionName === 'function' ? this.normalizedSessionName(manager.getSessionName()) : undefined;
    const nextName = this.normalizedSessionName(name);
    if (currentName !== nextName) {
      if (typeof session?.setSessionName === 'function') session.setSessionName(name);
      else manager.appendSessionInfo(name);
    }
    const sessionFile = typeof manager?.getSessionFile === 'function' ? manager.getSessionFile() : undefined;
    return sessionDetailFromManager(filePath ?? sessionFile ?? await resolveSessionFile(sessionId, projectPath), manager);
  }

  async prompt(projectPath: string, body: PromptBody, key: string | string[], options: { startEvent?: boolean } = {}) {
    let markSessionIdle: () => void = () => undefined;
    let subscription: (() => void) | undefined;
    try {
      markSessionIdle = await this.markSessionActive(projectPath, body.sessionId);
      const session = await this.getSession(projectPath, body.sessionId);
      await this.bindWebExtensions(session, projectPath, body.sessionId, key);
      const extensionCommand = this.isExtensionCommandPrompt(session, body.prompt);
      const lifecycle = { started: false, finished: false };
      subscription = this.subscribeSessionEvents(session, key, body.sessionId, { mirrorLifecycle: extensionCommand, lifecycle });
      const useSyntheticStart = (options.startEvent ?? true) && !extensionCommand;
      if (useSyntheticStart) this.broadcast(key, { type: 'agent:start', sessionId: body.sessionId });

      if (body.treeTargetId) {
        if (typeof session?.navigateTree !== 'function') throw new Error('Loaded pi SDK session does not expose navigateTree()');
        const result = await session.navigateTree(body.treeTargetId, {
          summarize: body.treeSummary?.mode === 'summary' || body.treeSummary?.mode === 'custom',
          customInstructions: body.treeSummary?.mode === 'custom' ? body.treeSummary.instructions : undefined,
          replaceInstructions: body.treeSummary?.mode === 'custom' ? body.treeSummary.replace : undefined,
        });
        if (result?.cancelled) throw new Error(result.aborted ? 'Tree navigation aborted' : 'Tree navigation cancelled');
      }
      else if ('branchFromId' in body) this.branchSession(session, body.branchFromId);

      await this.applySessionControls(session, body);

      const prompt = body.attachments?.length
        ? `${body.prompt}\n\nAttached files in the workspace:\n${body.attachments.map((file) => `- ${file}`).join('\n')}`
        : body.prompt;

      if (typeof session?.prompt === 'function') {
        await session.prompt(prompt, { source: 'rpc' });
      } else if (typeof session?.followUp === 'function') {
        await session.followUp(prompt);
      } else {
        throw new Error('Loaded pi SDK session does not expose prompt() or followUp()');
      }

      if (extensionCommand) await this.waitForCommandActivity(session, lifecycle);
      subscription?.();
      subscription = undefined;
      const needsSyntheticFinish = !extensionCommand || (!lifecycle.started && options.startEvent === false);
      if (needsSyntheticFinish) this.broadcast(key, { type: 'agent:finish', sessionId: body.sessionId });
      else if (lifecycle.started && !lifecycle.finished && !this.cachedSessionInUse(session)) {
        this.broadcast(key, { type: 'agent:finish', sessionId: body.sessionId });
      }
    } catch (error) {
      subscription?.();
      this.broadcast(key, { type: 'agent:error', sessionId: body.sessionId, message: error instanceof Error ? error.message : 'Agent failed' });
      throw error;
    } finally {
      markSessionIdle();
    }
  }

  async navigateTree(projectPath: string, body: NavigateTreeBody, key: string | string[], options: { finishEvent?: boolean } = {}) {
    if (!body.targetId) throw new Error('Missing tree target');
    let markSessionIdle: () => void = () => undefined;
    let subscription: (() => void) | undefined;
    try {
      markSessionIdle = await this.markSessionActive(projectPath, body.sessionId);
      this.broadcast(key, { type: 'agent:start', sessionId: body.sessionId });
      const session = await this.getSession(projectPath, body.sessionId);
      await this.bindWebExtensions(session, projectPath, body.sessionId, key);
      subscription = typeof session?.subscribe === 'function'
        ? session.subscribe((event: unknown) => this.broadcast(key, { type: 'agent:event', sessionId: body.sessionId, data: event }))
        : undefined;
      if (typeof session?.navigateTree !== 'function') throw new Error('Loaded pi SDK session does not expose navigateTree()');
      const result = await session.navigateTree(body.targetId, {
        summarize: body.treeSummary?.mode === 'summary' || body.treeSummary?.mode === 'custom',
        customInstructions: body.treeSummary?.mode === 'custom' ? body.treeSummary.instructions : undefined,
        replaceInstructions: body.treeSummary?.mode === 'custom' ? body.treeSummary.replace : undefined,
      });
      if (result?.cancelled) throw new Error(result.aborted ? 'Tree navigation aborted' : 'Tree navigation cancelled');
      subscription?.();
      if (options.finishEvent ?? true) this.broadcast(key, { type: 'agent:finish', sessionId: body.sessionId });
      return result ?? { cancelled: false };
    } catch (error) {
      subscription?.();
      this.broadcast(key, { type: 'agent:error', sessionId: body.sessionId, message: error instanceof Error ? error.message : 'Tree navigation failed' });
      throw error;
    } finally {
      markSessionIdle();
    }
  }

  models(_projectPath: string): ModelInfo[] {
    const registry = ModelRegistry.create(AuthStorage.create());
    return registry.getAvailable()
      .map((model) => ({
        value: `${model.provider}/${model.id}`,
        label: [model.name || model.id, registry.getProviderDisplayName(model.provider)].filter(Boolean).join(' · '),
        provider: model.provider,
        id: model.id,
        reasoning: Boolean(model.reasoning),
        thinkingLevels: supportedThinkingLevels(model),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  async commands(projectPath: string, sessionId?: string): Promise<CommandInfo[]> {
    const session = await this.getCommandSession(projectPath, sessionId);
    return [
      ...(sessionId ? this.builtinCommands() : []),
      ...this.extensionCommands(session),
      ...this.promptTemplateCommands(session),
      ...this.skillCommands(session),
    ];
  }

  async commandCompletions(projectPath: string, query: CommandCompletionQuery): Promise<CommandCompletion[]> {
    if (!query.command) return [];
    const session = await this.getCommandSession(projectPath, query.sessionId);
    const command = typeof session?.extensionRunner?.getCommand === 'function'
      ? session.extensionRunner.getCommand(query.command)
      : undefined;
    if (typeof command?.getArgumentCompletions !== 'function') return [];
    const completions = await command.getArgumentCompletions(query.prefix ?? '');
    if (!Array.isArray(completions)) return [];
    return completions.map((item: unknown) => this.commandCompletion(item)).filter((item): item is CommandCompletion => Boolean(item));
  }

  async status(projectPath: string, sessionId: string | undefined, key: string | string[]): Promise<AgentStatus> {
    const branch = await getGitBranch(projectPath).catch(() => undefined);
    if (!sessionId) return {
      branch,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, subscription: false },
      statuses: [],
    };
    const session = await this.getSession(projectPath, sessionId);
    await this.bindWebExtensions(session, projectPath, sessionId, key);
    return this.agentStatus(session, branch);
  }

  async compact(projectPath: string, body: CompactBody, key: string | string[]) {
    if (!body.sessionId) throw new Error('Missing session');
    let markSessionIdle: () => void = () => undefined;
    let subscription: (() => void) | undefined;
    try {
      markSessionIdle = await this.markSessionActive(projectPath, body.sessionId);
      const session = await this.getSession(projectPath, body.sessionId);
      if (typeof session?.compact !== 'function') throw new Error('Loaded pi SDK session does not expose compact()');
      await this.bindWebExtensions(session, projectPath, body.sessionId, key);

      this.broadcast(key, { type: 'agent:start', sessionId: body.sessionId });
      subscription = typeof session?.subscribe === 'function'
        ? session.subscribe((event: unknown) => this.broadcast(key, { type: 'agent:event', sessionId: body.sessionId, data: event }))
        : undefined;
      const result = await session.compact(body.instructions?.trim() || undefined);
      subscription?.();
      this.broadcast(key, { type: 'agent:finish', sessionId: body.sessionId });
      return result;
    } catch (error) {
      subscription?.();
      this.broadcast(key, { type: 'agent:error', sessionId: body.sessionId, message: error instanceof Error ? error.message : 'Compaction failed' });
      throw error;
    } finally {
      markSessionIdle();
    }
  }

  async executeBash(projectPath: string, body: BashBody, key: string | string[]) {
    const command = body.command?.trim();
    if (!body.sessionId) throw new Error('Missing session');
    if (!command) throw new Error('Missing command');
    let markSessionIdle: () => void = () => undefined;

    try {
      markSessionIdle = await this.markSessionActive(projectPath, body.sessionId);
      const session = await this.getSession(projectPath, body.sessionId);
      await this.bindWebExtensions(session, projectPath, body.sessionId, key);
      if (session?.isBashRunning) throw new Error('A shell command is already running');
      if (typeof session?.executeBash !== 'function') throw new Error('Loaded pi SDK session does not expose executeBash()');

      this.broadcast(key, { type: 'bash:start', sessionId: body.sessionId, message: command });
      const excludeFromContext = Boolean(body.excludeFromContext);
      const eventResult = typeof session?.extensionRunner?.emitUserBash === 'function'
        ? await session.extensionRunner.emitUserBash({ type: 'user_bash', command, excludeFromContext, cwd: projectPath })
        : undefined;
      if (eventResult?.result) {
        if (eventResult.result.output) this.broadcast(key, { type: 'bash:update', sessionId: body.sessionId, message: eventResult.result.output });
        if (typeof session?.recordBashResult === 'function') session.recordBashResult(command, eventResult.result, { excludeFromContext });
        this.broadcast(key, { type: 'bash:finish', sessionId: body.sessionId, message: command, data: eventResult.result });
        return eventResult.result;
      }
      const result = await session.executeBash(command, (chunk: string) => {
        this.broadcast(key, { type: 'bash:update', sessionId: body.sessionId, message: chunk });
      }, { excludeFromContext, operations: eventResult?.operations });
      this.broadcast(key, { type: 'bash:finish', sessionId: body.sessionId, message: command, data: result });
      return result;
    } catch (error) {
      this.broadcast(key, { type: 'bash:error', sessionId: body.sessionId, message: error instanceof Error ? error.message : 'Shell command failed' });
      throw error;
    } finally {
      markSessionIdle();
    }
  }

  async abort(projectPath: string, sessionId?: string) {
    const session = await this.getSession(projectPath, sessionId);
    if (typeof session?.clearQueue === 'function') session.clearQueue();
    if (typeof session?.abortBash === 'function' && session.isBashRunning) session.abortBash();
    if (typeof session?.abortBranchSummary === 'function') session.abortBranchSummary();
    if (typeof session?.abortCompaction === 'function' && session.isCompacting) session.abortCompaction();
    if (typeof session?.abortRetry === 'function' && session.isRetrying) session.abortRetry();
    if (typeof session?.abort === 'function') await session.abort();
  }

  private subscribeSessionEvents(session: any, key: string | string[], sessionId: string | undefined, options: { mirrorLifecycle?: boolean; lifecycle?: { started: boolean; finished: boolean } } = {}) {
    if (typeof session?.subscribe !== 'function') return undefined;
    return session.subscribe((event: unknown) => {
      const type = agentEventType(event);
      if (options.mirrorLifecycle && isCommandActivityStartEvent(type) && !options.lifecycle?.started) {
        if (options.lifecycle) options.lifecycle.started = true;
        this.broadcast(key, { type: 'agent:start', sessionId });
      }
      this.broadcast(key, { type: 'agent:event', sessionId, data: event });
      if (options.mirrorLifecycle && type === 'agent_end') {
        if (options.lifecycle) options.lifecycle.finished = true;
        this.broadcast(key, { type: 'agent:finish', sessionId });
      }
    });
  }

  private isExtensionCommandPrompt(session: any, prompt: string) {
    const commandName = slashCommandName(prompt);
    return Boolean(commandName && typeof session?.extensionRunner?.getCommand === 'function' && session.extensionRunner.getCommand(commandName));
  }

  private async waitForCommandActivity(session: any, lifecycle: { started: boolean; finished: boolean }) {
    if (this.cachedSessionInUse(session)) {
      await this.waitForSessionIdle(session);
      return;
    }

    const deadline = Date.now() + 250;
    while (!lifecycle.started && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (this.cachedSessionInUse(session)) {
        await this.waitForSessionIdle(session);
        return;
      }
    }

    if (lifecycle.started && !lifecycle.finished && this.cachedSessionInUse(session)) await this.waitForSessionIdle(session);
  }

  private async waitForSessionIdle(session: any) {
    while (this.cachedSessionInUse(session)) {
      if (this.cachedSessionIsStreaming(session) && typeof session?.agent?.waitForIdle === 'function') await session.agent.waitForIdle();
      else await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private async bindWebExtensions(session: any, projectPath: string, sessionId: string | undefined, key: string | string[]) {
    if (!session || typeof session !== 'object') return;
    this.sessionStreamKeys.set(session, key);
    if (this.boundSessions.has(session) || typeof session.bindExtensions !== 'function') return;
    this.boundSessions.add(session);
    await session.bindExtensions({
      uiContext: this.webUiContext(session, sessionId),
      abortHandler: () => {
        if (typeof session?.clearQueue === 'function') session.clearQueue();
        if (typeof session?.abortBranchSummary === 'function') session.abortBranchSummary();
        if (typeof session?.abort === 'function') void session.abort();
      },
      commandContextActions: {
        waitForIdle: async () => {
          if (typeof session?.agent?.waitForIdle === 'function') await session.agent.waitForIdle();
        },
        newSession: async () => ({ cancelled: true }),
        fork: async () => ({ cancelled: true }),
        navigateTree: async (targetId: string, options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }) => {
          if (typeof session?.navigateTree !== 'function') return { cancelled: true };
          const result = await session.navigateTree(targetId, options);
          return { cancelled: Boolean(result?.cancelled) };
        },
        switchSession: async () => ({ cancelled: true }),
        reload: async () => {
          if (typeof session?.reload === 'function') await session.reload();
        },
      },
      onError: (error: { extensionPath?: string; event?: string; error?: string }) => {
        this.broadcast(this.sessionStreamKeys.get(session) ?? key, {
          type: 'agent:error',
          sessionId,
          message: [error.extensionPath, error.event, error.error].filter(Boolean).join(': ') || 'Extension failed',
        });
      },
    });
  }

  private webUiContext(session: object, sessionId?: string) {
    const notify = (message: string, level?: string) => {
      this.broadcast(this.sessionStreamKeys.get(session) ?? [], { type: 'agent:notice', sessionId, message, data: { level } });
    };
    const passthrough = (text: string) => text;
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: passthrough,
      italic: passthrough,
      underline: passthrough,
      inverse: passthrough,
      strikethrough: passthrough,
      getFgAnsi: () => '',
      getBgAnsi: () => '',
      getColorMode: () => 'none',
      getThinkingBorderColor: () => passthrough,
      getBashModeBorderColor: () => passthrough,
    };
    return {
      select: async (title: string) => { notify(`${title}: selection UI is not available in web yet`, 'warning'); return undefined; },
      confirm: async (title: string, message: string) => { notify(`${title}: ${message}`, 'warning'); return false; },
      input: async (title: string) => { notify(`${title}: input UI is not available in web yet`, 'warning'); return undefined; },
      notify,
      onTerminalInput: () => () => undefined,
      setStatus: (key: string, text?: string) => this.setExtensionStatus(session, key, text, sessionId),
      setWorkingMessage: () => undefined,
      setWorkingVisible: () => undefined,
      setWorkingIndicator: () => undefined,
      setHiddenThinkingLabel: () => undefined,
      setWidget: () => undefined,
      setFooter: () => undefined,
      setHeader: () => undefined,
      setTitle: () => undefined,
      custom: async () => undefined,
      pasteToEditor: () => undefined,
      setEditorText: () => undefined,
      getEditorText: () => '',
      editor: async () => undefined,
      addAutocompleteProvider: () => undefined,
      setEditorComponent: () => undefined,
      getEditorComponent: () => undefined,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: 'Theme UI is not available in web yet' }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => undefined,
      theme,
    };
  }

  private agentStatus(session: any, branch?: string): AgentStatus {
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, subscription: false };
    for (const entry of typeof session?.sessionManager?.getEntries === 'function' ? session.sessionManager.getEntries() : []) {
      const message = entry?.type === 'message' ? entry.message : undefined;
      if (message?.role !== 'assistant' || !message.usage) continue;
      usage.input += this.finiteNumber(message.usage.input) ?? 0;
      usage.output += this.finiteNumber(message.usage.output) ?? 0;
      usage.cacheRead += this.finiteNumber(message.usage.cacheRead) ?? 0;
      usage.cacheWrite += this.finiteNumber(message.usage.cacheWrite) ?? 0;
      usage.cost += this.finiteNumber(message.usage.cost?.total) ?? 0;
    }
    usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    try {
      usage.subscription = Boolean(session?.state?.model && session?.modelRegistry?.isUsingOAuth?.(session.state.model));
    } catch {
      usage.subscription = false;
    }

    const contextUsage = typeof session?.getContextUsage === 'function' ? session.getContextUsage() : undefined;
    const contextWindow = this.finiteNumber(contextUsage?.contextWindow) ?? this.finiteNumber(session?.state?.model?.contextWindow) ?? 0;
    const context = contextWindow > 0
      ? {
          tokens: contextUsage?.tokens === null ? null : this.finiteNumber(contextUsage?.tokens) ?? 0,
          contextWindow,
          percent: contextUsage?.percent === null ? null : this.finiteNumber(contextUsage?.percent) ?? 0,
          autoCompact: Boolean(session?.autoCompactionEnabled ?? session?.settingsManager?.getCompactionEnabled?.()),
        }
      : undefined;

    return {
      branch,
      sessionName: typeof session?.sessionManager?.getSessionName === 'function' ? session.sessionManager.getSessionName() || undefined : undefined,
      usage,
      context,
      statuses: this.statusEntries(session),
    };
  }

  private setExtensionStatus(session: object, key: string, text: unknown, sessionId?: string) {
    const statusKey = sanitizeStatusText(String(key ?? ''));
    if (!statusKey) return;
    const statuses = this.extensionStatuses.get(session) ?? new Map<string, string>();
    if (!this.extensionStatuses.has(session)) this.extensionStatuses.set(session, statuses);
    if (text === undefined) statuses.delete(statusKey);
    else statuses.set(statusKey, sanitizeStatusText(String(text)));
    this.broadcast(this.sessionStreamKeys.get(session) ?? [], {
      type: 'agent:status',
      sessionId,
      data: { statuses: this.statusEntries(session) },
    });
  }

  private statusEntries(session: object) {
    return [...(this.extensionStatuses.get(session)?.entries() ?? [])]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, text]) => ({ key, text }))
      .filter((status) => status.text);
  }

  private finiteNumber(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private builtinCommands(): CommandInfo[] {
    return [{
      name: 'compact',
      description: 'Manually compact the session context',
      source: 'builtin',
      argumentHint: 'custom instructions',
    }];
  }

  private extensionCommands(session: any): CommandInfo[] {
    const commands = typeof session?.extensionRunner?.getRegisteredCommands === 'function'
      ? session.extensionRunner.getRegisteredCommands()
      : [];
    return commands
      .filter((command: any) => !WEB_BUILTIN_COMMAND_NAMES.has(String(command.invocationName ?? command.name)))
      .map((command: any) => this.commandInfo(command.invocationName ?? command.name, command.description, 'extension', command.sourceInfo, {
        hasArgumentCompletions: typeof command.getArgumentCompletions === 'function',
      }));
  }

  private promptTemplateCommands(session: any): CommandInfo[] {
    const templates = Array.isArray(session?.promptTemplates) ? session.promptTemplates : [];
    return templates
      .filter((template: any) => !WEB_BUILTIN_COMMAND_NAMES.has(String(template.name)))
      .map((template: any) => this.commandInfo(template.name, template.description, 'prompt', template.sourceInfo ?? { path: template.filePath }, {
        argumentHint: template.argumentHint,
      }));
  }

  private skillCommands(session: any): CommandInfo[] {
    if (typeof session?.settingsManager?.getEnableSkillCommands === 'function' && !session.settingsManager.getEnableSkillCommands()) return [];
    const skills = typeof session?.resourceLoader?.getSkills === 'function'
      ? session.resourceLoader.getSkills().skills ?? []
      : [];
    return skills.map((skill: any) => this.commandInfo(`skill:${skill.name}`, skill.description, 'skill', skill.sourceInfo ?? { path: skill.filePath }));
  }

  private commandInfo(name: unknown, description: unknown, source: CommandInfo['source'], sourceInfo: any, options: { argumentHint?: unknown; hasArgumentCompletions?: boolean } = {}): CommandInfo {
    return {
      name: String(name),
      description: typeof description === 'string' ? description : undefined,
      source,
      location: typeof sourceInfo?.scope === 'string' ? sourceInfo.scope : undefined,
      path: typeof sourceInfo?.path === 'string' ? sourceInfo.path : undefined,
      argumentHint: typeof options.argumentHint === 'string' ? options.argumentHint : undefined,
      hasArgumentCompletions: options.hasArgumentCompletions || undefined,
    };
  }

  private commandCompletion(item: unknown): CommandCompletion | undefined {
    if (typeof item === 'string') return { value: item };
    if (!item || typeof item !== 'object') return undefined;
    const record = item as Record<string, unknown>;
    const value = typeof record.value === 'string' ? record.value : typeof record.label === 'string' ? record.label : undefined;
    if (!value) return undefined;
    return {
      value,
      label: typeof record.label === 'string' ? record.label : undefined,
      description: typeof record.description === 'string' ? record.description : undefined,
    };
  }

  private branchSession(session: any, branchFromId: string | null | undefined) {
    if (branchFromId === undefined) return;
    const manager = session?.sessionManager ?? session;
    if (branchFromId === null) {
      if (typeof manager?.resetLeaf === 'function') manager.resetLeaf();
    } else if (typeof manager?.branch === 'function') {
      manager.branch(branchFromId);
    }
    if (session?.agent?.state && typeof manager?.buildSessionContext === 'function') {
      session.agent.state.messages = manager.buildSessionContext().messages;
    }
  }

  private async applySessionControls(session: any, body: { model?: string; thinking?: string }) {
    const modelReference = body.model?.trim();
    const thinkingLevel = body.thinking && isThinkingLevel(body.thinking) ? body.thinking : undefined;
    if (!modelReference && !thinkingLevel) return;

    if (modelReference) await this.setSessionModel(session, modelReference);
    if (thinkingLevel && typeof session?.setThinkingLevel === 'function' && session?.thinkingLevel !== thinkingLevel) {
      this.withoutDefaultControlPersistence(session, () => session.setThinkingLevel(thinkingLevel));
    }
  }

  private withoutDefaultControlPersistence<T>(session: any, action: () => T): T {
    const manager = session?.settingsManager;
    if (!manager) return action();
    const originals: Array<[string, unknown]> = [];
    for (const method of ['setDefaultProvider', 'setDefaultModel', 'setDefaultModelAndProvider', 'setDefaultThinkingLevel']) {
      if (typeof manager[method] !== 'function') continue;
      originals.push([method, manager[method]]);
      manager[method] = () => undefined;
    }
    try {
      return action();
    } finally {
      for (const [method, original] of originals) manager[method] = original;
    }
  }

  private async setSessionModel(session: any, reference: string) {
    if (typeof session?.setModel !== 'function') return;
    const model = await this.resolveModelReference(session, reference);
    if (!model) throw new Error(`Model not found: ${reference}`);
    if (session?.model?.provider === model.provider && session.model.id === model.id) return;
    // SDK setModel persists the chosen chat model as a global default before its first await.
    await this.withoutDefaultControlPersistence(session, () => session.setModel(model));
  }

  private async resolveModelReference(session: any, reference: string) {
    const modelReference = this.stripThinkingSuffix(reference.trim());
    if (!modelReference) return undefined;
    const registry = session?.modelRegistry;
    const availableModels = typeof registry?.getAvailable === 'function' ? await registry.getAvailable() : [];
    const match = this.findModelReferenceMatch(modelReference, availableModels);
    if (match) return match;
    const allModels = typeof registry?.getAll === 'function' ? registry.getAll() : [];
    return this.findModelReferenceMatch(modelReference, allModels);
  }

  private findModelReferenceMatch(reference: string, models: any[]) {
    const slashIndex = reference.indexOf('/');
    if (slashIndex !== -1) {
      const provider = reference.slice(0, slashIndex).toLowerCase();
      const modelId = reference.slice(slashIndex + 1).toLowerCase();
      return models.find((model) => model?.provider?.toLowerCase() === provider && model?.id?.toLowerCase() === modelId);
    }
    const matches = models.filter((model) => model?.id?.toLowerCase() === reference.toLowerCase());
    return matches.length === 1 ? matches[0] : undefined;
  }

  private stripThinkingSuffix(reference: string) {
    const colonIndex = reference.lastIndexOf(':');
    if (colonIndex === -1) return reference;
    return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(reference.slice(colonIndex + 1)) ? reference.slice(0, colonIndex) : reference;
  }

  private normalizedSessionName(name: string | undefined) {
    return name?.trim() || undefined;
  }

  private runtimeSessionCacheKey(projectPath: string, sessionId?: string) {
    return `${projectPath}:${projectSessionDir(projectPath)}:${sessionId ?? 'new'}`;
  }

  private runtimeSessionCacheKeys(projectPath: string, sessionId: string, filePath?: string) {
    const keys = new Set([this.runtimeSessionCacheKey(projectPath, sessionId)]);
    if (filePath) keys.add(this.runtimeSessionCacheKey(projectPath, sessionIdFromPath(filePath)));
    return keys;
  }

  private isRuntimeSessionCacheKeyForProject(projectPath: string, key: string) {
    return key.startsWith(`${projectPath}:${projectSessionDir(projectPath)}:`);
  }

  private sessionDeletionLocked(projectPath: string, sessionId: string, filePath?: string) {
    const keys = this.runtimeSessionCacheKeys(projectPath, sessionId, filePath);
    return [...keys].some((key) => this.deletingRuntimeSessions.has(key))
      || Boolean(filePath && this.deletingRuntimeSessionFiles.has(path.resolve(filePath)));
  }

  private async findRuntimeSession(projectPath: string, sessionId: string, filePath?: string) {
    const keys = this.runtimeSessionCacheKeys(projectPath, sessionId, filePath);
    for (const key of keys) {
      const cached = this.runtimeSessions.get(key);
      if (cached) return cached;
    }
    if (!filePath) return undefined;
    const targetPath = path.resolve(filePath);
    for (const [key, cached] of this.runtimeSessions) {
      if (keys.has(key) || !this.isRuntimeSessionCacheKeyForProject(projectPath, key)) continue;
      if (this.cachedSessionFile(await cached.promise.catch(() => undefined)) === targetPath) return cached;
    }
    return undefined;
  }

  private async lockRuntimeSession(projectPath: string, sessionId: string, filePath?: string) {
    let resolvedFilePath = filePath;
    if (this.sessionDeletionLocked(projectPath, sessionId, resolvedFilePath)) return undefined;
    if (!resolvedFilePath) {
      try {
        resolvedFilePath = await resolveSessionFile(sessionId, projectPath);
      } catch {
        const cached = this.runtimeSessions.get(this.runtimeSessionCacheKey(projectPath, sessionId));
        resolvedFilePath = cached ? this.cachedSessionFile(await cached.promise.catch(() => undefined)) : undefined;
      }
    }
    if (this.sessionDeletionLocked(projectPath, sessionId, resolvedFilePath)) return undefined;

    const keys = this.runtimeSessionCacheKeys(projectPath, sessionId, resolvedFilePath);
    for (const key of keys) this.activeRuntimeSessions.set(key, (this.activeRuntimeSessions.get(key) ?? 0) + 1);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      for (const key of keys) {
        const count = this.activeRuntimeSessions.get(key) ?? 0;
        if (count <= 1) this.activeRuntimeSessions.delete(key);
        else this.activeRuntimeSessions.set(key, count - 1);
      }
    };
  }

  private async markSessionActive(projectPath: string, sessionId?: string) {
    if (!sessionId) return () => undefined;
    const release = await this.lockRuntimeSession(projectPath, sessionId);
    if (!release) throw new Error('Session is being deleted.');
    return release;
  }

  private getCachedSession(cache: Map<string, CachedSession>, key: string) {
    const cached = cache.get(key);
    if (!cached) return undefined;
    this.touchCachedSession(cache, key, cached);
    return cached.promise;
  }

  private setCachedSession(cache: Map<string, CachedSession>, key: string, promise: Promise<unknown>) {
    const cached: CachedSession = { promise, expiresAt: Date.now() + SESSION_CACHE_TTL_MS };
    cache.set(key, cached);
    this.scheduleCachedSessionEviction(cache, key, cached);
    return promise;
  }

  private touchCachedSession(cache: Map<string, CachedSession>, key: string, cached: CachedSession) {
    cached.expiresAt = Date.now() + SESSION_CACHE_TTL_MS;
    this.scheduleCachedSessionEviction(cache, key, cached);
  }

  private scheduleCachedSessionEviction(cache: Map<string, CachedSession>, key: string, cached: CachedSession) {
    if (cached.timer) clearTimeout(cached.timer);
    const delay = Math.max(1_000, cached.expiresAt - Date.now());
    cached.timer = setTimeout(() => {
      void this.evictCachedSession(cache, key, cached).catch(() => undefined);
    }, delay);
    cached.timer.unref();
  }

  private async disposeCachedSessionEntry(cache: Map<string, CachedSession>, key: string, cached: CachedSession) {
    if (cache.get(key) !== cached) return;
    cache.delete(key);
    if (cached.timer) clearTimeout(cached.timer);
    const session = await cached.promise.catch(() => undefined);
    await this.disposeCachedSession(session);
  }

  private async evictCachedSession(cache: Map<string, CachedSession>, key: string, cached: CachedSession) {
    if (cache.get(key) !== cached) return;
    if (cached.expiresAt > Date.now()) {
      this.scheduleCachedSessionEviction(cache, key, cached);
      return;
    }

    let session: unknown;
    try {
      session = await cached.promise;
    } catch {
      if (cache.get(key) === cached) cache.delete(key);
      return;
    }

    if (cache.get(key) !== cached) return;
    if (cached.expiresAt > Date.now()) {
      this.scheduleCachedSessionEviction(cache, key, cached);
      return;
    }
    if (this.cachedSessionInUse(session)) {
      cached.expiresAt = Date.now() + SESSION_CACHE_BUSY_RETRY_MS;
      this.scheduleCachedSessionEviction(cache, key, cached);
      return;
    }

    cache.delete(key);
    await this.disposeCachedSession(session);
  }

  private cachedSessionFile(session: unknown) {
    if (!session || typeof session !== 'object') return undefined;
    const manager = (session as { sessionManager?: unknown }).sessionManager ?? session;
    if (!manager || typeof manager !== 'object') return undefined;
    const filePath = typeof (manager as { getSessionFile?: unknown }).getSessionFile === 'function'
      ? (manager as { getSessionFile: () => string | undefined }).getSessionFile()
      : undefined;
    return filePath ? path.resolve(filePath) : undefined;
  }

  private cachedSessionInUse(session: unknown) {
    const candidates = [session];
    if (session && typeof session === 'object') candidates.push((session as { session?: unknown }).session);
    return candidates.some((candidate) => {
      if (!candidate || typeof candidate !== 'object') return false;
      try {
        const value = candidate as { isStreaming?: unknown; isBashRunning?: unknown; isCompacting?: unknown; isRetrying?: unknown; state?: { isStreaming?: unknown }; agent?: { state?: { isStreaming?: unknown } } };
        return Boolean(value.isStreaming || value.isBashRunning || value.isCompacting || value.isRetrying || value.state?.isStreaming || value.agent?.state?.isStreaming);
      } catch {
        return false;
      }
    });
  }

  private cachedSessionIsStreaming(session: unknown) {
    const candidates = [session];
    if (session && typeof session === 'object') candidates.push((session as { session?: unknown }).session);
    return candidates.some((candidate) => {
      if (!candidate || typeof candidate !== 'object') return false;
      try {
        const value = candidate as { isStreaming?: unknown; state?: { isStreaming?: unknown }; agent?: { state?: { isStreaming?: unknown } } };
        return Boolean(value.isStreaming || value.state?.isStreaming || value.agent?.state?.isStreaming);
      } catch {
        return false;
      }
    });
  }

  private async disposeCachedSession(session: unknown) {
    if (!session || typeof session !== 'object') return;
    const disposable = session as { dispose?: () => unknown; close?: () => unknown; destroy?: () => unknown };
    if (typeof disposable.dispose === 'function') await disposable.dispose();
    else if (typeof disposable.close === 'function') await disposable.close();
    else if (typeof disposable.destroy === 'function') await disposable.destroy();
  }

  private async getCommandSession(projectPath: string, sessionId?: string): Promise<any> {
    if (sessionId) return this.getSession(projectPath, sessionId);
    const cached = this.getCachedSession(this.commandSessions, projectPath);
    if (cached) return cached;

    const sessionPromise = (async () => {
      const sdk = await this.loadSdk();
      if (!sdk.createAgentSession || typeof sdk.SessionManager?.inMemory !== 'function') throw new Error('No supported pi SDK command session factory found');
      const result = await sdk.createAgentSession({ cwd: projectPath, sessionManager: sdk.SessionManager.inMemory(projectPath) });
      return result.session ?? result;
    })();
    this.setCachedSession(this.commandSessions, projectPath, sessionPromise);
    try {
      return await sessionPromise;
    } catch (error) {
      if (this.commandSessions.get(projectPath)?.promise === sessionPromise) this.commandSessions.delete(projectPath);
      throw error;
    }
  }

  private async getSession(projectPath: string, sessionId?: string): Promise<any> {
    const sessionDir = projectSessionDir(projectPath);
    const cacheKey = this.runtimeSessionCacheKey(projectPath, sessionId);
    const cached = this.getCachedSession(this.runtimeSessions, cacheKey);
    if (cached) return cached;

    const sessionPromise = (async () => {
      const sdk = await this.loadSdk();
      if (!sdk.createAgentSession) throw new Error('No supported pi SDK session factory found');

      const sessionManager = sessionId && sdk.SessionManager?.open
        ? sdk.SessionManager.open(await resolveSessionFile(sessionId, projectPath), sessionDir, projectPath)
        : sdk.SessionManager?.create(projectPath, sessionDir);
      if (sessionManager) applyPendingSessionInfo(sessionManager);

      const result = await sdk.createAgentSession({ cwd: projectPath, sessionManager });
      return result.session ?? result;
    })();
    this.setCachedSession(this.runtimeSessions, cacheKey, sessionPromise);
    try {
      return await sessionPromise;
    } catch (error) {
      if (this.runtimeSessions.get(cacheKey)?.promise === sessionPromise) this.runtimeSessions.delete(cacheKey);
      throw error;
    }
  }
}

export async function registerPiRoutes(app: FastifyInstance, registry: ProjectRegistry, bridge: PiBridge) {
  app.get('/ws/projects/:projectId/agent', { websocket: true }, (connection: any, request: any) => {
    const socket: WebSocket = connection.socket ?? connection;
    const key = streamKey(request.params.projectId, request.query.sessionId);
    bridge.subscribe(key, socket);
    socket.on('message', (data: { toString(): string }) => {
      try {
        const message = JSON.parse(data.toString()) as { type?: string };
        if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: 'Invalid websocket message' }));
      }
    });
  });

  app.get('/ws/projects/:projectId/notifications', { websocket: true }, (connection: any, request: any) => {
    const socket: WebSocket = connection.socket ?? connection;
    try {
      const project = registry.get(request.params.projectId);
      bridge.subscribeNotifications(project.id, socket);
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: 'Unknown project' }));
      return socket.close?.();
    }
    socket.on('message', (data: { toString(): string }) => {
      try {
        const message = JSON.parse(data.toString()) as { type?: string };
        if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: 'Invalid websocket message' }));
      }
    });
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/agent/models', async (request, reply) => {
    try {
      const project = registry.get(request.params.projectId);
      return { models: bridge.models(project.path) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not load models' });
    }
  });

  app.get<{ Params: { projectId: string }; Querystring: { sessionId?: string } }>('/api/projects/:projectId/agent/commands', async (request, reply) => {
    try {
      const project = registry.get(request.params.projectId);
      return { commands: await bridge.commands(project.path, request.query.sessionId) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not load commands' });
    }
  });

  app.get<{ Params: { projectId: string }; Querystring: { sessionId?: string } }>('/api/projects/:projectId/agent/status', async (request, reply) => {
    try {
      const project = registry.get(request.params.projectId);
      return { status: await bridge.status(project.path, request.query.sessionId, streamKey(project.id, request.query.sessionId)) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not load agent status' });
    }
  });

  app.get<{ Params: { projectId: string }; Querystring: CommandCompletionQuery }>('/api/projects/:projectId/agent/command-completions', async (request, reply) => {
    try {
      const project = registry.get(request.params.projectId);
      return { completions: await bridge.commandCompletions(project.path, request.query) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not load command completions' });
    }
  });

  app.post<{ Params: { projectId: string }; Body: PromptBody }>('/api/projects/:projectId/agent/prompt', async (request, reply) => {
    if (!request.body?.prompt?.trim()) return reply.code(400).send({ error: 'Missing prompt' });
    try {
      const project = registry.get(request.params.projectId);
      const key = streamKey(project.id, request.body.sessionId);
      const streamTarget = request.body.mirrorActiveStream && request.body.sessionId
        ? [key, streamKey(project.id, undefined)]
        : key;
      let promptBody = request.body;
      if (request.body.treeTargetId) {
        await bridge.navigateTree(project.path, {
          sessionId: request.body.sessionId,
          targetId: request.body.treeTargetId,
          treeSummary: request.body.treeSummary,
        }, streamTarget, { finishEvent: false });
        const { treeTargetId: _treeTargetId, treeSummary: _treeSummary, branchFromId: _branchFromId, ...rest } = request.body;
        promptBody = rest;
      }
      bridge.prompt(project.path, promptBody, streamTarget, { startEvent: !request.body.treeTargetId })
        .finally(() => clearProjectFileCaches(project.id))
        .catch(() => undefined);
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Prompt failed' });
    }
  });

  app.post<{ Params: { projectId: string }; Body: CompactBody }>('/api/projects/:projectId/agent/compact', async (request, reply) => {
    if (!request.body?.sessionId) return reply.code(400).send({ error: 'Missing session' });
    try {
      const project = registry.get(request.params.projectId);
      const key = streamKey(project.id, request.body.sessionId);
      const streamTarget = request.body.mirrorActiveStream
        ? [key, streamKey(project.id, undefined)]
        : key;
      return await bridge.compact(project.path, request.body, streamTarget);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Compaction failed' });
    }
  });

  app.post<{ Params: { projectId: string }; Body: BashBody }>('/api/projects/:projectId/agent/bash', async (request, reply) => {
    if (!request.body?.sessionId) return reply.code(400).send({ error: 'Missing session' });
    if (!request.body?.command?.trim()) return reply.code(400).send({ error: 'Missing command' });
    try {
      const project = registry.get(request.params.projectId);
      const key = streamKey(project.id, request.body.sessionId);
      const streamTarget = request.body.mirrorActiveStream
        ? [key, streamKey(project.id, undefined)]
        : key;
      try {
        return await bridge.executeBash(project.path, request.body, streamTarget);
      } finally {
        clearProjectFileCaches(project.id);
      }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Shell command failed' });
    }
  });

  app.post<{ Params: { projectId: string }; Body: NavigateTreeBody }>('/api/projects/:projectId/session/navigate', async (request, reply) => {
    if (!request.body?.sessionId) return reply.code(400).send({ error: 'Missing session' });
    if (!request.body?.targetId) return reply.code(400).send({ error: 'Missing tree target' });
    try {
      const project = registry.get(request.params.projectId);
      return await bridge.navigateTree(project.path, request.body, streamKey(project.id, request.body.sessionId));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Tree navigation failed' });
    }
  });

  app.post<{ Params: { projectId: string }; Body: { sessionId?: string } }>('/api/projects/:projectId/agent/abort', async (request, reply) => {
    try {
      const project = registry.get(request.params.projectId);
      await bridge.abort(project.path, request.body?.sessionId);
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Abort failed' });
    }
  });
}

function streamKey(projectId: string, sessionId?: string) {
  return `${projectId}:${sessionId ?? 'active'}`;
}

function slashCommandName(prompt: string) {
  const match = prompt.trim().match(/^\/([^\s/]+)/);
  return match?.[1];
}

function agentEventType(event: unknown) {
  return event && typeof event === 'object' && typeof (event as { type?: unknown }).type === 'string' ? (event as { type: string }).type : undefined;
}

function isCommandActivityStartEvent(type: string | undefined) {
  return type === 'agent_start' || type === 'compaction_start' || type === 'auto_retry_start' || type === 'message_update' || type === 'tool_execution_start';
}

function projectIdFromStreamKey(key: string) {
  const index = key.indexOf(':');
  return index === -1 ? undefined : key.slice(0, index);
}

function isWorkspaceNotificationEvent(event: AgentEvent) {
  if (['agent:start', 'agent:finish', 'agent:error', 'agent:notice', 'bash:start', 'bash:finish', 'bash:error', 'error'].includes(event.type)) return true;
  if (event.type !== 'agent:event' || !event.data || typeof event.data !== 'object') return false;
  const type = (event.data as { type?: unknown }).type;
  if (typeof type !== 'string') return false;
  return ['notice', 'auto_retry_start', 'auto_retry_end', 'compaction_start', 'compaction_end'].includes(type)
    || /approval|permission|confirm|input|notify|review/i.test(type);
}

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as string[]).includes(value);
}

function supportedThinkingLevels(model: any): ThinkingLevel[] {
  if (!model?.reasoning) return ['off'];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh') return mapped !== undefined;
    return true;
  });
}

function sanitizeStatusText(text: string) {
  return text.replace(/[\r\n\t]/g, ' ').replace(/ +/g, ' ').trim();
}
