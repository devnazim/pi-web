import { AuthStorage, getAgentDir, ModelRegistry, parseFrontmatter, resizeImage } from '@earendil-works/pi-coding-agent';
import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Dirent, type Stats } from 'node:fs';
import { open, readdir, readFile, realpath, stat, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { clearProjectFileCaches } from './files.js';
import { getGitBranch } from './git.js';
import type { ProjectRegistry } from './projects.js';
import { applyPendingSessionInfo, projectSessionDir, resolveSessionFile, sessionDetailFromManager } from './sessions.js';
import type { AgentEvent } from './types.js';
import { resolveWithin, sessionIdFromPath } from './util.js';

type WebSocket = {
  readyState: number;
  send(data: string): void;
  close?(): void;
  on(event: 'close' | 'message', listener: (...args: any[]) => void): void;
};

type TreeSummaryOptions = { mode?: 'none' | 'summary' | 'custom'; instructions?: string; replace?: boolean };
type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
type StreamingBehavior = 'steer' | 'followUp';
type ImageContent = { type: 'image'; mimeType: string; data: string };

interface PromptBody {
  sessionId?: string;
  treeTargetId?: string;
  treeSummary?: TreeSummaryOptions;
  branchFromId?: string | null;
  prompt: string;
  agent?: string;
  model?: string;
  thinking?: string;
  attachments?: string[];
  mirrorActiveStream?: boolean;
  streamingBehavior?: StreamingBehavior;
  awaitCompletion?: boolean;
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
type AgentProfileSource = 'suite' | 'legacy';
type AgentProfileType = 'main' | 'subagent' | 'both';
type AgentListItem = { value: string; id: string; label: string; description?: string; type: AgentProfileType; source: AgentProfileSource; model?: string; thinking?: string; tools?: string[]; agents?: string[] };
type AgentListResponse = { supported: boolean; active: string | null; agents: AgentListItem[] };

type ExtensionUiRequestMethod = 'select' | 'confirm' | 'input' | 'editor';
type ExtensionUiRequest = {
  id: string;
  sessionId?: string;
  method: ExtensionUiRequestMethod;
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  createdAt: number;
};
type ExtensionUiResponse = { value?: string; confirmed?: boolean; cancelled?: boolean };
type PendingExtensionUiRequest<T = unknown> = {
  projectPath: string;
  streamKey: string | string[];
  request: ExtensionUiRequest;
  resolve: (value: T) => void;
  parseResponse: (response: ExtensionUiResponse) => T;
  defaultValue: T;
  cleanup: () => boolean;
};

interface ExtensionUiReplyBody extends ExtensionUiResponse {
  sessionId?: string;
}

type ModelInfo = { value: string; label: string; provider: string; id: string; reasoning: boolean; thinkingLevels: ThinkingLevel[] };

type AgentStatus = {
  branch?: string;
  running: boolean;
  sessionName?: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number; subscription: boolean };
  context?: { tokens: number | null; contextWindow: number; percent: number | null; autoCompact: boolean };
  statuses: Array<{ key: string; text: string }>;
};

type CachedSession = { promise: Promise<unknown>; expiresAt: number; timer?: NodeJS.Timeout };
type RuntimeSessionLock = { release: () => void; wasActive: boolean };
type StreamKeyLock = { key: string | string[]; token: symbol };
type PromptRunOptions = { startEvent?: boolean; preflightResult?: (success: boolean, error?: unknown) => void };

const WEB_BUILTIN_COMMAND_NAMES = new Set(['compact']);
const AGENT_ALREADY_PROCESSING_MESSAGE = "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.";
const SESSION_CACHE_TTL_MS = 30 * 60_000;
const SESSION_CACHE_BUSY_RETRY_MS = 60_000;
const EXTENSION_COMMAND_BUSY_DELAY_MS = 300;
const IMAGE_TYPE_SNIFF_BYTES = 4100;
const MAX_PROMPT_ATTACHMENT_PATHS = 100;
const MAX_PROMPT_IMAGE_ATTACHMENTS = 20;
const MAX_PROMPT_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_PROMPT_IMAGE_TOTAL_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_PROMPT_IMAGE_TOTAL_DATA_CHARS = 20 * 1024 * 1024;
const MAX_PNG_ANIMATION_SCAN_CHUNKS = 4096;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export class PiBridge {
  private readonly sockets = new Map<string, Set<WebSocket>>();
  private readonly notificationSockets = new Map<string, Set<WebSocket>>();
  private readonly runtimeSessions = new Map<string, CachedSession>();
  private readonly commandSessions = new Map<string, CachedSession>();
  private readonly boundSessions = new WeakSet<object>();
  private readonly sessionStreamKeys = new WeakMap<object, string | string[]>();
  private readonly sessionStreamKeyLocks = new WeakMap<object, StreamKeyLock>();
  private readonly extensionAsyncWrappedSessions = new WeakSet<object>();
  private readonly extensionAsyncTasks = new WeakMap<object, Set<Promise<unknown>>>();
  private readonly extensionErrorCounts = new WeakMap<object, number>();
  private readonly extensionStatuses = new WeakMap<object, Map<string, string>>();
  private readonly pendingExtensionUiRequests = new Map<string, PendingExtensionUiRequest<any>>();
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
      const sockets = this.sockets.get(item);
      if (!sockets) continue;
      for (const socket of [...sockets]) {
        if (!this.sendSocketPayload(socket, payload)) sockets.delete(socket);
      }
      if (!sockets.size) this.sockets.delete(item);
    }
    this.broadcastNotificationEvent(keys, event);
  }

  private broadcastNotificationEvent(keys: Set<string>, event: AgentEvent) {
    if (!isWorkspaceNotificationEvent(event)) return;
    const projectIds = new Set([...keys].map(projectIdFromStreamKey).filter((id): id is string => Boolean(id)));
    for (const projectId of projectIds) {
      const sockets = this.notificationSockets.get(projectId);
      if (!sockets) continue;
      const payload = JSON.stringify({ ...event, projectId });
      for (const socket of [...sockets]) {
        if (!this.sendSocketPayload(socket, payload)) sockets.delete(socket);
      }
      if (!sockets.size) this.notificationSockets.delete(projectId);
    }
  }

  private sendSocketPayload(socket: WebSocket, payload: string) {
    if (socket.readyState !== 1) return false;
    try {
      socket.send(payload);
      return true;
    } catch {
      return false;
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

  async prompt(projectPath: string, body: PromptBody, key: string | string[], options: PromptRunOptions = {}) {
    let markSessionIdle: () => void = () => undefined;
    let releaseStreamKeyLock: (() => void) | undefined;
    let subscription: (() => void) | undefined;
    let queuedStreamingPrompt = false;
    let commandBusyTimer: NodeJS.Timeout | undefined;
    let commandBusyStarted = false;
    let preflightReported = false;
    const clearCommandBusyTimer = () => {
      if (!commandBusyTimer) return;
      clearTimeout(commandBusyTimer);
      commandBusyTimer = undefined;
    };
    const reportPreflight = (success: boolean, error?: unknown) => {
      if (preflightReported) return;
      preflightReported = true;
      options.preflightResult?.(success, error);
    };
    try {
      const sessionLock = await this.markSessionActiveWithState(projectPath, body.sessionId);
      markSessionIdle = sessionLock.release;
      const session = await this.getSession(projectPath, body.sessionId);
      const extensionCommand = this.isExtensionCommandPrompt(session, body.prompt);
      const sessionBusy = sessionLock.wasActive || this.cachedSessionInUse(session);
      if (extensionCommand && sessionBusy) {
        const error = new Error('Agent is already processing. Extension commands cannot be queued while streaming.');
        reportPreflight(false, error);
        throw error;
      }
      if (body.streamingBehavior && (body.treeTargetId || body.treeSummary || 'branchFromId' in body)) {
        const error = new Error('Streaming behavior cannot be combined with tree navigation or branching.');
        reportPreflight(false, error);
        throw error;
      }
      const requestedStreamingBehavior = extensionCommand ? undefined : body.streamingBehavior;
      if (requestedStreamingBehavior && typeof session?.prompt !== 'function') {
        const error = new Error('Loaded pi SDK session does not support streamingBehavior');
        reportPreflight(false, error);
        throw error;
      }
      let streamingBehavior = requestedStreamingBehavior;
      if (requestedStreamingBehavior) {
        if (this.cachedSessionIsStreaming(session)) queuedStreamingPrompt = true;
        else if (sessionBusy) {
          const error = new Error(AGENT_ALREADY_PROCESSING_MESSAGE);
          reportPreflight(false, error);
          throw error;
        } else streamingBehavior = undefined;
      }
      if (!extensionCommand && !queuedStreamingPrompt && sessionBusy) {
        const error = new Error(AGENT_ALREADY_PROCESSING_MESSAGE);
        reportPreflight(false, error);
        throw error;
      }
      releaseStreamKeyLock = this.lockSessionStreamKeys(session, key);
      const extensionErrorCountBefore = extensionCommand ? this.extensionErrorCount(session) : 0;
      const lifecycle = { started: false, finished: false };
      const ensureCommandBusyStarted = () => {
        clearCommandBusyTimer();
        if (!lifecycle.started && !commandBusyStarted && this.extensionErrorCount(session) === extensionErrorCountBefore) {
          commandBusyStarted = true;
          this.broadcast(key, { type: 'agent:start', sessionId: body.sessionId });
        }
        reportPreflight(true);
      };
      subscription = queuedStreamingPrompt ? undefined : this.subscribeSessionEvents(session, key, body.sessionId, {
        mirrorLifecycle: extensionCommand,
        lifecycle,
        onActivityStart: extensionCommand ? ensureCommandBusyStarted : undefined,
        syntheticStartActive: () => commandBusyStarted,
      });
      if (extensionCommand) {
        commandBusyTimer = setTimeout(() => {
          commandBusyTimer = undefined;
          if (preflightReported) return;
          if (lifecycle.started || this.extensionErrorCount(session) !== extensionErrorCountBefore) {
            reportPreflight(true);
            return;
          }
          ensureCommandBusyStarted();
        }, EXTENSION_COMMAND_BUSY_DELAY_MS);
        commandBusyTimer.unref();
      }
      await this.bindWebExtensions(session, projectPath, body.sessionId, key);
      const useSyntheticStart = (options.startEvent ?? true) && !extensionCommand && !queuedStreamingPrompt;
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

      if (this.shouldApplySuiteAgentSelection(body, extensionCommand, queuedStreamingPrompt, requestedStreamingBehavior)) {
        await this.applySuiteAgentSelection(session, body.agent);
      }
      await this.applySessionControls(session, body);

      const { prompt, images } = await this.preparePromptAttachments(projectPath, body.prompt, body.attachments);

      if (typeof session?.prompt === 'function') {
        await session.prompt(prompt, {
          source: 'rpc',
          streamingBehavior,
          images: images.length ? images : undefined,
          preflightResult: (success: boolean) => {
            if (success && !extensionCommand) reportPreflight(true);
          },
        });
        if (!extensionCommand) reportPreflight(true);
      } else if (typeof session?.followUp === 'function') {
        await session.followUp(prompt, images.length ? images : undefined);
        reportPreflight(true);
      } else {
        throw new Error('Loaded pi SDK session does not expose prompt() or followUp()');
      }

      clearCommandBusyTimer();
      if (extensionCommand) {
        // Some extension commands only update extension state/UI (for example `/xplan steps` without a task).
        // Hold the HTTP preflight response until we know whether real agent activity started; otherwise
        // a status refresh can observe this temporary bridge lock as a running agent and leave the web UI busy.
        if (!lifecycle.started && !commandBusyStarted && this.cachedSessionInUse(session)) ensureCommandBusyStarted();
        await this.waitForCommandActivity(session, lifecycle, ensureCommandBusyStarted);
        reportPreflight(true);
      }
      subscription?.();
      subscription = undefined;
      const commandReportedError = extensionCommand && this.extensionErrorCount(session) !== extensionErrorCountBefore;
      const needsSyntheticFinish = !queuedStreamingPrompt && !commandReportedError && (!extensionCommand || (commandBusyStarted && !lifecycle.finished) || (!lifecycle.started && options.startEvent === false));
      if (needsSyntheticFinish) this.broadcast(key, { type: 'agent:finish', sessionId: body.sessionId });
      else if (!commandReportedError && lifecycle.started && !lifecycle.finished && !this.cachedSessionInUse(session)) {
        this.broadcast(key, { type: 'agent:finish', sessionId: body.sessionId });
      }
    } catch (error) {
      clearCommandBusyTimer();
      subscription?.();
      if (!preflightReported) reportPreflight(false, error);
      const message = error instanceof Error ? error.message : 'Agent failed';
      this.broadcast(key, isAgentAlreadyProcessingMessage(message) || queuedStreamingPrompt
        ? { type: 'agent:notice', sessionId: body.sessionId, message, data: { level: 'warning' } }
        : { type: 'agent:error', sessionId: body.sessionId, message });
      throw error;
    } finally {
      clearCommandBusyTimer();
      if (!queuedStreamingPrompt) this.cancelExtensionUiRequests(projectPath, body.sessionId, { allWhenSessionMissing: false });
      releaseStreamKeyLock?.();
      markSessionIdle();
    }
  }

  private async preparePromptAttachments(projectPath: string, prompt: string, attachments?: string[]) {
    const paths = uniqueAttachmentPaths(attachments);
    if (!paths.length) return { prompt, images: [] as ImageContent[] };
    for (const filePath of paths) resolveWithin(projectPath, filePath);

    const realProjectPath = await realpath(projectPath);
    const images: ImageContent[] = [];
    let totalInputBytes = 0;
    let totalDataChars = 0;
    for (const filePath of paths) {
      if (images.length >= MAX_PROMPT_IMAGE_ATTACHMENTS) break;
      const attachment = await readSupportedImageAttachment(projectPath, realProjectPath, filePath, totalInputBytes).catch(() => undefined);
      if (!attachment) continue;
      totalInputBytes += attachment.inputBytes;
      const resized = await resizeImage(attachment.data, attachment.mimeType).catch(() => undefined);
      if (!resized || totalDataChars + resized.data.length > MAX_PROMPT_IMAGE_TOTAL_DATA_CHARS) continue;
      totalDataChars += resized.data.length;
      images.push({ type: 'image', mimeType: resized.mimeType, data: resized.data });
    }

    return {
      prompt: `${prompt}\n\nAttached files in the workspace:\n${paths.map((file) => `- ${file}`).join('\n')}`,
      images,
    };
  }

  async navigateTree(projectPath: string, body: NavigateTreeBody, key: string | string[], options: { finishEvent?: boolean } = {}) {
    if (!body.targetId) throw new Error('Missing tree target');
    let markSessionIdle: () => void = () => undefined;
    let releaseStreamKeyLock: (() => void) | undefined;
    let subscription: (() => void) | undefined;
    try {
      const sessionLock = await this.markSessionActiveWithState(projectPath, body.sessionId);
      markSessionIdle = sessionLock.release;
      const session = await this.getSession(projectPath, body.sessionId);
      if (sessionLock.wasActive || this.cachedSessionInUse(session)) throw new Error(AGENT_ALREADY_PROCESSING_MESSAGE);
      releaseStreamKeyLock = this.lockSessionStreamKeys(session, key);
      this.broadcast(key, { type: 'agent:start', sessionId: body.sessionId });
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
      const message = error instanceof Error ? error.message : 'Tree navigation failed';
      this.broadcast(key, isAgentAlreadyProcessingMessage(message)
        ? { type: 'agent:notice', sessionId: body.sessionId, message, data: { level: 'warning' } }
        : { type: 'agent:error', sessionId: body.sessionId, message });
      throw error;
    } finally {
      this.cancelExtensionUiRequests(projectPath, body.sessionId, { allWhenSessionMissing: false });
      releaseStreamKeyLock?.();
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

  async agents(projectPath: string, sessionId?: string): Promise<AgentListResponse> {
    const session = await this.getCommandSession(projectPath, sessionId);
    if (!this.hasAgentExtensionCommand(session)) return { supported: false, active: null, agents: [] };
    const location = await this.agentProfileLocation();
    return {
      supported: true,
      active: await this.activeAgentId(projectPath, location),
      agents: await this.loadAgentProfilesFromDir(location.agentsDir, location.source),
    };
  }

  async commands(projectPath: string, sessionId?: string): Promise<CommandInfo[]> {
    const session = await this.getCommandSession(projectPath, sessionId);
    const hasAgentCommand = this.hasAgentExtensionCommand(session);
    return [
      ...this.builtinCommands(Boolean(sessionId)),
      ...this.extensionCommands(session, hasAgentCommand),
      ...this.promptTemplateCommands(session),
      ...this.skillCommands(session),
    ];
  }

  async commandCompletions(projectPath: string, query: CommandCompletionQuery): Promise<CommandCompletion[]> {
    if (!query.command) return [];
    const session = await this.getCommandSession(projectPath, query.sessionId);
    if (query.command === 'agent' && this.hasAgentExtensionCommand(session)) return this.agentCommandCompletions(projectPath, query.prefix ?? '');
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
      running: false,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, subscription: false },
      statuses: [],
    };
    const running = await this.isSessionActive(projectPath, sessionId);
    const session = await this.getSession(projectPath, sessionId);
    await this.bindWebExtensions(session, projectPath, sessionId, key);
    return this.agentStatus(session, branch, running);
  }

  async compact(projectPath: string, body: CompactBody, key: string | string[]) {
    if (!body.sessionId) throw new Error('Missing session');
    let markSessionIdle: () => void = () => undefined;
    let releaseStreamKeyLock: (() => void) | undefined;
    let subscription: (() => void) | undefined;
    try {
      markSessionIdle = await this.markSessionActive(projectPath, body.sessionId);
      const session = await this.getSession(projectPath, body.sessionId);
      releaseStreamKeyLock = this.lockSessionStreamKeys(session, key);
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
      this.cancelExtensionUiRequests(projectPath, body.sessionId, { allWhenSessionMissing: false });
      releaseStreamKeyLock?.();
      markSessionIdle();
    }
  }

  async executeBash(projectPath: string, body: BashBody, key: string | string[]) {
    const command = body.command?.trim();
    if (!body.sessionId) throw new Error('Missing session');
    if (!command) throw new Error('Missing command');
    let markSessionIdle: () => void = () => undefined;
    let releaseStreamKeyLock: (() => void) | undefined;

    try {
      markSessionIdle = await this.markSessionActive(projectPath, body.sessionId);
      const session = await this.getSession(projectPath, body.sessionId);
      releaseStreamKeyLock = this.lockSessionStreamKeys(session, key);
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
      this.cancelExtensionUiRequests(projectPath, body.sessionId, { allWhenSessionMissing: false });
      releaseStreamKeyLock?.();
      markSessionIdle();
    }
  }

  async abort(projectPath: string, sessionId?: string) {
    this.cancelExtensionUiRequests(projectPath, sessionId);
    const session = await this.getSession(projectPath, sessionId);
    if (typeof session?.clearQueue === 'function') session.clearQueue();
    if (typeof session?.abortBash === 'function' && session.isBashRunning) session.abortBash();
    if (typeof session?.abortBranchSummary === 'function') session.abortBranchSummary();
    if (typeof session?.abortCompaction === 'function' && session.isCompacting) session.abortCompaction();
    if (typeof session?.abortRetry === 'function' && session.isRetrying) session.abortRetry();
    if (typeof session?.abort === 'function') await session.abort();
  }

  extensionUiRequests(projectPath: string, sessionId?: string) {
    return [...this.pendingExtensionUiRequests.values()]
      .filter((item) => item.projectPath === projectPath && (!sessionId || item.request.sessionId === sessionId))
      .map((item) => item.request)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  respondExtensionUiRequest(projectPath: string, requestId: string, response: ExtensionUiReplyBody) {
    const pending = this.pendingExtensionUiRequests.get(requestId);
    if (!pending || pending.projectPath !== projectPath) throw new Error('UI request not found');
    if (response.sessionId !== pending.request.sessionId) throw new Error('UI request not found');
    this.settleExtensionUiRequest(pending, this.normalizeExtensionUiResponse(pending.request, response));
    return pending.request;
  }

  private subscribeSessionEvents(session: any, key: string | string[], sessionId: string | undefined, options: { mirrorLifecycle?: boolean; lifecycle?: { started: boolean; finished: boolean }; onActivityStart?: () => void; syntheticStartActive?: () => boolean } = {}) {
    if (typeof session?.subscribe !== 'function') return undefined;
    return session.subscribe((event: unknown) => {
      const type = agentEventType(event);
      if (options.mirrorLifecycle && isCommandActivityStartEvent(type) && !options.lifecycle?.started) {
        if (options.lifecycle) options.lifecycle.started = true;
        options.onActivityStart?.();
        if (!options.syntheticStartActive?.()) this.broadcast(key, { type: 'agent:start', sessionId });
      }
      this.broadcast(key, { type: 'agent:event', sessionId, data: event });
      if (options.mirrorLifecycle && type === 'agent_end' && !agentEventWillRetry(event)) {
        if (options.lifecycle) options.lifecycle.finished = true;
        this.broadcast(key, { type: 'agent:finish', sessionId });
      }
    });
  }

  private isExtensionCommandPrompt(session: any, prompt: string) {
    const commandName = slashCommandName(prompt);
    return Boolean(commandName && typeof session?.extensionRunner?.getCommand === 'function' && session.extensionRunner.getCommand(commandName));
  }

  private async waitForCommandActivity(session: any, lifecycle: { started: boolean; finished: boolean }, onActivityStart?: () => void) {
    if (lifecycle.started || this.cachedSessionInUse(session)) {
      onActivityStart?.();
      await this.waitForSessionIdle(session);
      return;
    }

    const deadline = Date.now() + 250;
    while (!lifecycle.started && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (this.cachedSessionInUse(session)) {
        onActivityStart?.();
        await this.waitForSessionIdle(session);
        return;
      }
    }

    if (lifecycle.started) onActivityStart?.();
    if (lifecycle.started && !lifecycle.finished && this.cachedSessionInUse(session)) await this.waitForSessionIdle(session);
  }

  private async waitForSessionIdle(session: any) {
    while (this.cachedSessionInUse(session)) {
      if (this.cachedSessionIsStreaming(session) && typeof session?.agent?.waitForIdle === 'function') await session.agent.waitForIdle();
      else await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private bindSessionStreamKeys(session: object, key: string | string[]) {
    this.sessionStreamKeys.set(session, this.sessionStreamKeyLocks.get(session)?.key ?? key);
  }

  private lockSessionStreamKeys(session: object, key: string | string[]) {
    const existing = this.sessionStreamKeyLocks.get(session);
    if (existing) {
      this.sessionStreamKeys.set(session, existing.key);
      return () => undefined;
    }
    const token = Symbol('stream-key-lock');
    this.sessionStreamKeyLocks.set(session, { key, token });
    this.sessionStreamKeys.set(session, key);
    return () => {
      const current = this.sessionStreamKeyLocks.get(session);
      if (current?.token !== token) return;
      this.sessionStreamKeyLocks.delete(session);
      this.sessionStreamKeys.set(session, primaryStreamKey(key));
    };
  }

  private wrapExtensionAsyncSessionMethods(session: any) {
    if (!session || typeof session !== 'object' || this.extensionAsyncWrappedSessions.has(session)) return;
    this.extensionAsyncWrappedSessions.add(session);
    for (const method of ['sendCustomMessage', 'sendUserMessage'] as const) {
      if (typeof session[method] !== 'function') continue;
      const original = session[method];
      session[method] = (...args: unknown[]) => {
        const result = original.apply(session, args);
        if (isPromiseLike(result)) this.trackExtensionAsyncTask(session, result);
        return result;
      };
    }
  }

  private trackExtensionAsyncTask(session: object, task: PromiseLike<unknown>) {
    const tracked = Promise.resolve(task);
    const tasks = this.extensionAsyncTasks.get(session) ?? new Set<Promise<unknown>>();
    tasks.add(tracked);
    this.extensionAsyncTasks.set(session, tasks);
    void tracked.finally(() => {
      const current = this.extensionAsyncTasks.get(session);
      if (!current) return;
      current.delete(tracked);
      if (!current.size) this.extensionAsyncTasks.delete(session);
    }).catch(() => undefined);
  }

  private extensionErrorCount(session: object) {
    return this.extensionErrorCounts.get(session) ?? 0;
  }

  private incrementExtensionErrorCount(session: object) {
    this.extensionErrorCounts.set(session, this.extensionErrorCount(session) + 1);
  }

  private async bindWebExtensions(session: any, projectPath: string, sessionId: string | undefined, key: string | string[]) {
    if (!session || typeof session !== 'object') return;
    this.bindSessionStreamKeys(session, key);
    this.wrapExtensionAsyncSessionMethods(session);
    if (this.boundSessions.has(session) || typeof session.bindExtensions !== 'function') return;
    this.boundSessions.add(session);
    await session.bindExtensions({
      uiContext: this.webUiContext(session, projectPath, sessionId),
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
        this.incrementExtensionErrorCount(session);
        this.broadcast(this.sessionStreamKeys.get(session) ?? key, {
          type: 'agent:error',
          sessionId,
          message: [error.extensionPath, error.event, error.error].filter(Boolean).join(': ') || 'Extension failed',
        });
      },
    });
  }

  private createExtensionUiRequest<T>(session: object, projectPath: string, sessionId: string | undefined, request: Omit<ExtensionUiRequest, 'id' | 'sessionId' | 'createdAt'>, opts: { signal?: AbortSignal; timeout?: number } | undefined, defaultValue: T, parseResponse: (response: ExtensionUiResponse) => T) {
    if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

    const id = randomUUID();
    const streamKey = this.sessionStreamKeys.get(session) ?? [];
    const timeout = this.finiteNumber(opts?.timeout);
    const pendingRequest: ExtensionUiRequest = {
      id,
      sessionId,
      ...request,
      timeout: timeout && timeout > 0 ? timeout : undefined,
      createdAt: Date.now(),
    };

    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    let pending: PendingExtensionUiRequest<T>;
    const cleanup = () => {
      if (settled) return false;
      settled = true;
      if (timer) clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', abort);
      this.pendingExtensionUiRequests.delete(id);
      return true;
    };
    const abort = () => this.settleExtensionUiRequest(pending, { cancelled: true }, defaultValue);

    return new Promise<T>((resolve) => {
      pending = { projectPath, streamKey, request: pendingRequest, resolve, parseResponse, defaultValue, cleanup };
      this.pendingExtensionUiRequests.set(id, pending);
      opts?.signal?.addEventListener('abort', abort, { once: true });
      if (pendingRequest.timeout) {
        timer = setTimeout(() => this.settleExtensionUiRequest(pending, { cancelled: true }, defaultValue), pendingRequest.timeout);
        timer.unref();
      }
      this.broadcast(streamKey, { type: 'agent:ui-request', sessionId, data: pendingRequest });
    });
  }

  private settleExtensionUiRequest<T>(pending: PendingExtensionUiRequest<T>, response: ExtensionUiResponse, value?: T) {
    if (!pending.cleanup()) return;
    pending.resolve(arguments.length >= 3 ? value as T : pending.parseResponse(response));
    this.broadcast(pending.streamKey, { type: 'agent:ui-response', sessionId: pending.request.sessionId, data: { id: pending.request.id, response } });
  }

  private cancelExtensionUiRequests(projectPath: string, sessionId?: string, options: { allWhenSessionMissing?: boolean } = {}) {
    const allWhenSessionMissing = options.allWhenSessionMissing ?? true;
    for (const pending of [...this.pendingExtensionUiRequests.values()]) {
      if (pending.projectPath !== projectPath) continue;
      if (sessionId) {
        if (pending.request.sessionId !== sessionId) continue;
      } else if (!allWhenSessionMissing && pending.request.sessionId !== undefined) {
        continue;
      }
      this.settleExtensionUiRequest(pending, { cancelled: true }, pending.defaultValue);
    }
  }

  private normalizeExtensionUiResponse(request: ExtensionUiRequest, response: ExtensionUiResponse): ExtensionUiResponse {
    if (response.cancelled) return { cancelled: true };
    if (request.method === 'confirm') {
      if (typeof response.confirmed !== 'boolean') throw new Error('Missing confirmation response');
      return { confirmed: response.confirmed };
    }
    if (request.method === 'select') {
      if (typeof response.value !== 'string') throw new Error('Missing selected option');
      if (!request.options?.includes(response.value)) throw new Error('Selected option is not available');
      return { value: response.value };
    }
    if (typeof response.value !== 'string') throw new Error('Missing input response');
    return { value: response.value };
  }

  private webUiContext(session: object, projectPath: string, sessionId?: string) {
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
      select: (title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }) => this.createExtensionUiRequest(
        session,
        projectPath,
        sessionId,
        { method: 'select', title, options: options.map((option) => String(option)) },
        opts,
        undefined,
        (response) => response.cancelled ? undefined : response.value,
      ),
      confirm: (title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }) => this.createExtensionUiRequest(
        session,
        projectPath,
        sessionId,
        { method: 'confirm', title, message },
        opts,
        false,
        (response) => response.cancelled ? false : response.confirmed === true,
      ),
      input: (title: string, placeholder?: string, opts?: { signal?: AbortSignal; timeout?: number }) => this.createExtensionUiRequest(
        session,
        projectPath,
        sessionId,
        { method: 'input', title, placeholder },
        opts,
        undefined,
        (response) => response.cancelled ? undefined : response.value,
      ),
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
      editor: (title: string, prefill?: string, opts?: { signal?: AbortSignal; timeout?: number }) => this.createExtensionUiRequest(
        session,
        projectPath,
        sessionId,
        { method: 'editor', title, prefill },
        opts,
        undefined,
        (response) => response.cancelled ? undefined : response.value,
      ),
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

  private agentStatus(session: any, branch?: string, running = false): AgentStatus {
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
      running,
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

  private builtinCommands(includeSessionCommands: boolean): CommandInfo[] {
    return includeSessionCommands
      ? [{
        name: 'compact',
        description: 'Manually compact the session context',
        source: 'builtin',
        argumentHint: 'custom instructions',
      }]
      : [];
  }

  private extensionCommands(session: any, hasAgentCommand: boolean): CommandInfo[] {
    const commands = typeof session?.extensionRunner?.getRegisteredCommands === 'function'
      ? session.extensionRunner.getRegisteredCommands()
      : [];
    return commands
      .filter((command: any) => !WEB_BUILTIN_COMMAND_NAMES.has(String(command.invocationName ?? command.name)))
      .map((command: any) => {
        const name = command.invocationName ?? command.name;
        return this.commandInfo(name, command.description, 'extension', command.sourceInfo, {
          hasArgumentCompletions: typeof command.getArgumentCompletions === 'function' || (hasAgentCommand && String(name) === 'agent'),
        });
      });
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

  private async agentCommandCompletions(projectPath: string, prefix: string): Promise<CommandCompletion[]> {
    const normalized = prefix.trim().toLowerCase();
    const location = await this.agentProfileLocation();
    const completions: CommandCompletion[] = [
      { value: 'none', label: 'No agent', description: 'Clear selected main agent' },
      ...(await this.loadAgentProfilesFromDir(location.agentsDir, location.source)).map((agent) => ({
        value: agent.id,
        label: `${agent.id} · ${agent.source}`,
        description: agent.description,
      })),
    ];
    if (!normalized) return completions.slice(0, 25);
    return completions.filter((completion) => [completion.value, completion.label, completion.description]
      .filter((item): item is string => Boolean(item))
      .some((item) => item.toLowerCase().includes(normalized))).slice(0, 25);
  }

  private async agentProfileLocation(): Promise<{ agentsDir: string; stateDir: string; source: AgentProfileSource }> {
    const suiteDir = process.env.PI_AGENT_SUITE_DIR
      ? path.resolve(this.expandHomePath(process.env.PI_AGENT_SUITE_DIR))
      : path.join(getAgentDir(), 'agent-suite');
    const suiteAgentsDir = path.join(suiteDir, 'agent-selection', 'agents');
    if (await this.isDirectory(suiteAgentsDir)) {
      return {
        agentsDir: suiteAgentsDir,
        stateDir: path.join(suiteDir, 'agent-selection', 'state'),
        source: 'suite',
      };
    }
    return {
      agentsDir: path.join(getAgentDir(), 'agents'),
      stateDir: path.join(getAgentDir(), 'agent-selection', 'state'),
      source: 'legacy',
    };
  }

  private async activeAgentId(projectPath: string, location: { stateDir: string }): Promise<string | null> {
    try {
      const statePath = path.join(location.stateDir, `${createHash('sha256').update(path.resolve(projectPath)).digest('hex')}.json`);
      const state = JSON.parse(await readFile(statePath, 'utf8')) as { cwd?: unknown; activeAgentId?: unknown };
      if (typeof state.cwd === 'string' && path.resolve(state.cwd) !== path.resolve(projectPath)) return null;
      return typeof state.activeAgentId === 'string' ? state.activeAgentId : null;
    } catch {
      return null;
    }
  }

  private async loadAgentProfilesFromDir(dir: string, source: AgentProfileSource): Promise<AgentListItem[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const agents = await Promise.all(entries
      .filter((entry) => entry.name.endsWith('.md') && (entry.isFile() || entry.isSymbolicLink()))
      .map((entry) => this.agentProfileFromFile(path.join(dir, entry.name), source)));
    return agents
      .filter((agent): agent is AgentListItem => Boolean(agent))
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }

  private async agentProfileFromFile(filePath: string, source: AgentProfileSource): Promise<AgentListItem | undefined> {
    try {
      const id = path.basename(filePath, '.md').trim();
      if (!id) return undefined;
      const { frontmatter } = parseFrontmatter<Record<string, unknown>>(await readFile(filePath, 'utf8'));
      const type = this.agentProfileType(frontmatter.type);
      if (type === 'subagent') return undefined;
      const description = this.frontmatterString(frontmatter.description);
      const model = this.frontmatterModel(frontmatter.model);
      const tools = this.frontmatterStringArray(frontmatter.tools);
      const agents = this.frontmatterStringArray(frontmatter.agents);
      return {
        value: id,
        id,
        label: id,
        ...(description ? { description } : {}),
        type,
        source,
        ...(model.id ? { model: model.id } : {}),
        ...(model.thinking ? { thinking: model.thinking } : {}),
        ...(tools?.length ? { tools } : {}),
        ...(agents?.length ? { agents } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private agentProfileType(value: unknown): AgentProfileType {
    if (value === undefined || value === null) return 'main';
    if (typeof value !== 'string') throw new Error('Invalid agent type');
    const type = value.trim();
    if (type === 'main' || type === 'subagent' || type === 'both') return type;
    throw new Error('Invalid agent type');
  }

  private async isDirectory(filePath: string) {
    try {
      return (await stat(filePath)).isDirectory();
    } catch {
      return false;
    }
  }

  private frontmatterString(value: unknown) {
    return typeof value === 'string' ? value.trim() || undefined : undefined;
  }

  private frontmatterStringArray(value: unknown) {
    const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,]/) : [];
    const strings = values.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean);
    return strings.length ? [...new Set(strings)] : undefined;
  }

  private frontmatterModel(value: unknown): { id?: string; thinking?: string } {
    if (typeof value === 'string') return this.frontmatterString(value) ? { id: this.frontmatterString(value) } : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const model = value as { id?: unknown; thinking?: unknown };
    const id = this.frontmatterString(model.id);
    const thinking = this.frontmatterString(model.thinking);
    return {
      ...(id ? { id } : {}),
      ...(thinking ? { thinking } : {}),
    };
  }

  private expandHomePath(filePath: string) {
    return filePath === '~' || filePath.startsWith(`~${path.sep}`) || filePath.startsWith('~/')
      ? path.join(homedir(), filePath.slice(2))
      : filePath;
  }

  private hasAgentExtensionCommand(session: any) {
    if (typeof session?.extensionRunner?.getCommand === 'function' && session.extensionRunner.getCommand('agent')) return true;
    const commands = typeof session?.extensionRunner?.getRegisteredCommands === 'function'
      ? session.extensionRunner.getRegisteredCommands()
      : [];
    return commands.some((command: any) => String(command.invocationName ?? command.name) === 'agent');
  }

  private shouldApplySuiteAgentSelection(body: PromptBody, extensionCommand: boolean, queuedStreamingPrompt: boolean, requestedStreamingBehavior: StreamingBehavior | undefined) {
    return Object.prototype.hasOwnProperty.call(body, 'agent') && !extensionCommand && !queuedStreamingPrompt && !requestedStreamingBehavior;
  }

  private async applySuiteAgentSelection(session: any, value: string | undefined) {
    if (!this.hasAgentExtensionCommand(session)) return;
    if (typeof session?.prompt !== 'function') throw new Error('Loaded pi SDK session does not expose prompt()');
    await session.prompt(`/agent ${this.agentCommandArgument(value)}`, { source: 'rpc' });
  }

  private agentCommandArgument(value: string | undefined) {
    const requested = value?.trim() ?? '';
    if (!requested || ['none', 'default', 'reset', 'off'].includes(requested.toLowerCase())) return 'none';
    if (/[\r\n]/.test(requested)) throw new Error('Invalid agent id');
    return requested;
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
    return (await this.lockRuntimeSessionWithState(projectPath, sessionId, filePath))?.release;
  }

  private async lockRuntimeSessionWithState(projectPath: string, sessionId: string, filePath?: string): Promise<RuntimeSessionLock | undefined> {
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
    const wasActive = [...keys].some((key) => this.activeRuntimeSessions.has(key));
    for (const key of keys) this.activeRuntimeSessions.set(key, (this.activeRuntimeSessions.get(key) ?? 0) + 1);
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      for (const key of keys) {
        const count = this.activeRuntimeSessions.get(key) ?? 0;
        if (count <= 1) this.activeRuntimeSessions.delete(key);
        else this.activeRuntimeSessions.set(key, count - 1);
      }
    };
    return { release, wasActive };
  }

  private async markSessionActiveWithState(projectPath: string, sessionId?: string): Promise<RuntimeSessionLock> {
    if (!sessionId) return { release: () => undefined, wasActive: false };
    const lock = await this.lockRuntimeSessionWithState(projectPath, sessionId);
    if (!lock) throw new Error('Session is being deleted.');
    return lock;
  }

  private async markSessionActive(projectPath: string, sessionId?: string) {
    return (await this.markSessionActiveWithState(projectPath, sessionId)).release;
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
        return Boolean(this.extensionAsyncTasks.get(candidate)?.size || value.isStreaming || value.isBashRunning || value.isCompacting || value.isRetrying || value.state?.isStreaming || value.agent?.state?.isStreaming);
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
        if (message.type === 'ping') sendWebSocketJson(socket, { type: 'pong' });
      } catch {
        sendWebSocketJson(socket, { type: 'error', message: 'Invalid websocket message' });
      }
    });
  });

  app.get('/ws/projects/:projectId/notifications', { websocket: true }, (connection: any, request: any) => {
    const socket: WebSocket = connection.socket ?? connection;
    try {
      const project = registry.get(request.params.projectId);
      bridge.subscribeNotifications(project.id, socket);
    } catch {
      sendWebSocketJson(socket, { type: 'error', message: 'Unknown project' });
      return socket.close?.();
    }
    socket.on('message', (data: { toString(): string }) => {
      try {
        const message = JSON.parse(data.toString()) as { type?: string };
        if (message.type === 'ping') sendWebSocketJson(socket, { type: 'pong' });
      } catch {
        sendWebSocketJson(socket, { type: 'error', message: 'Invalid websocket message' });
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

  app.get<{ Params: { projectId: string }; Querystring: { sessionId?: string } }>('/api/projects/:projectId/agent/agents', async (request, reply) => {
    try {
      const project = registry.get(request.params.projectId);
      return await bridge.agents(project.path, request.query.sessionId);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not load agents' });
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

  app.get<{ Params: { projectId: string }; Querystring: { sessionId?: string } }>('/api/projects/:projectId/agent/ui-requests', async (request, reply) => {
    try {
      const project = registry.get(request.params.projectId);
      return { requests: bridge.extensionUiRequests(project.path, request.query.sessionId) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not load UI requests' });
    }
  });

  app.post<{ Params: { projectId: string; requestId: string }; Body: ExtensionUiReplyBody }>('/api/projects/:projectId/agent/ui-requests/:requestId/reply', async (request, reply) => {
    try {
      const project = registry.get(request.params.projectId);
      return { request: bridge.respondExtensionUiRequest(project.path, request.params.requestId, request.body ?? {}) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not reply to UI request' });
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
    if (request.body.streamingBehavior && request.body.streamingBehavior !== 'steer' && request.body.streamingBehavior !== 'followUp') return reply.code(400).send({ error: 'Invalid streaming behavior' });
    if (request.body.streamingBehavior && (request.body.treeTargetId || request.body.treeSummary || 'branchFromId' in request.body)) return reply.code(400).send({ error: 'Streaming behavior cannot be combined with tree navigation or branching' });
    try {
      const project = registry.get(request.params.projectId);
      if (request.body.treeTargetId && request.body.sessionId && await bridge.isSessionActive(project.path, request.body.sessionId)) return reply.code(409).send({ error: AGENT_ALREADY_PROCESSING_MESSAGE });
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
      let preflightSettled = false;
      let resolvePreflight: () => void = () => undefined;
      let rejectPreflight: (error: Error) => void = () => undefined;
      const preflight = new Promise<void>((resolve, reject) => {
        resolvePreflight = resolve;
        rejectPreflight = reject;
      });
      const settlePreflight = (success: boolean, error?: unknown) => {
        if (preflightSettled) return;
        preflightSettled = true;
        if (success) resolvePreflight();
        else rejectPreflight(error instanceof Error ? error : new Error('Prompt failed'));
      };
      const promptTask = bridge.prompt(project.path, promptBody, streamTarget, { startEvent: !request.body.treeTargetId, preflightResult: settlePreflight })
        .finally(() => clearProjectFileCaches(project.id));
      promptTask.catch((error) => settlePreflight(false, error));
      if (request.body.awaitCompletion) {
        void preflight.catch(() => undefined);
        await promptTask;
        return { ok: true };
      }
      await preflight;
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Prompt failed';
      return reply.code(isAgentAlreadyProcessingMessage(message) ? 409 : 400).send({ error: message });
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
      const message = error instanceof Error ? error.message : 'Tree navigation failed';
      return reply.code(isAgentAlreadyProcessingMessage(message) ? 409 : 400).send({ error: message });
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

function sendWebSocketJson(socket: WebSocket, message: Record<string, unknown>) {
  if (socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // Ignore write races with websocket close.
  }
}

function streamKey(projectId: string, sessionId?: string) {
  return `${projectId}:${sessionId ?? 'active'}`;
}

function primaryStreamKey(key: string | string[]) {
  return Array.isArray(key) ? key[0] ?? '' : key;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function');
}

function slashCommandName(prompt: string) {
  const match = prompt.trim().match(/^\/([^\s/]+)/);
  return match?.[1];
}

function uniqueAttachmentPaths(attachments: string[] | undefined) {
  if (attachments !== undefined && !Array.isArray(attachments)) throw new Error('Attachments must be an array.');
  if ((attachments?.length ?? 0) > MAX_PROMPT_ATTACHMENT_PATHS) throw new Error(`Too many attachments; maximum is ${MAX_PROMPT_ATTACHMENT_PATHS}.`);
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const attachment of attachments ?? []) {
    if (typeof attachment !== 'string') throw new Error('Attachment path must be a string.');
    const filePath = attachment.trim();
    if (!filePath) continue;
    if (filePath !== attachment || /[\0-\x1f\x7f-\x9f\u2028\u2029]/.test(filePath)) throw new Error('Attachment path contains invalid characters.');
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    paths.push(filePath);
  }
  return paths;
}

type AttachmentImageData = { mimeType: string; data: Uint8Array; inputBytes: number };

async function readSupportedImageAttachment(projectPath: string, realProjectPath: string, filePath: string, currentTotalInputBytes: number): Promise<AttachmentImageData | undefined> {
  const { file, fileStat } = await openAttachmentFileWithin(projectPath, realProjectPath, filePath);
  try {
    if (fileStat.size <= 0 || fileStat.size > MAX_PROMPT_IMAGE_INPUT_BYTES) return undefined;
    const sniff = await readFileRange(file, 0, Math.min(IMAGE_TYPE_SNIFF_BYTES, fileStat.size));
    const mimeType = detectSupportedImageMimeType(sniff);
    if (!mimeType || currentTotalInputBytes + fileStat.size > MAX_PROMPT_IMAGE_TOTAL_INPUT_BYTES) return undefined;
    if (mimeType === 'image/png') {
      const animated = await hasAnimatedPngControlChunk(file, fileStat.size);
      if (animated !== false) return undefined;
    }
    return { mimeType, data: await readFileBytes(file, fileStat.size), inputBytes: fileStat.size };
  } finally {
    await file.close().catch(() => undefined);
  }
}

async function openAttachmentFileWithin(projectPath: string, realProjectPath: string, filePath: string) {
  const target = resolveWithin(projectPath, filePath);
  const realTarget = await realpath(target);
  if (!isPathWithin(realProjectPath, realTarget)) throw new Error('Path escapes workspace');
  const file = await open(realTarget, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let verified = false;
  try {
    await assertOpenAttachmentHandleWithin(realProjectPath, file, realTarget);
    const fileStat = await file.stat();
    if (!fileStat.isFile()) throw new Error('Attachment path is not a file');
    verified = true;
    return { file, fileStat };
  } finally {
    if (!verified) await file.close().catch(() => undefined);
  }
}

async function assertOpenAttachmentHandleWithin(realProjectPath: string, file: FileHandle, realTarget: string) {
  if (process.platform === 'linux') {
    const handlePath = await realpath(`/proc/self/fd/${file.fd}`);
    if (!isPathWithin(realProjectPath, handlePath)) throw new Error('Path escapes workspace');
    return;
  }

  const currentRealTarget = await realpath(realTarget);
  if (!isPathWithin(realProjectPath, currentRealTarget)) throw new Error('Path escapes workspace');
  const [handleStat, pathStat] = await Promise.all([file.stat(), stat(currentRealTarget)]);
  if (!sameFileIdentity(handleStat, pathStat)) throw new Error('Path changed while opening');
}

function sameFileIdentity(left: Stats, right: Stats) {
  return left.dev === right.dev && left.ino === right.ino;
}

function isPathWithin(root: string, target: string) {
  const relative = path.relative(root, target);
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function readFileRange(file: FileHandle, position: number, length: number) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

async function readFileBytes(file: FileHandle, size: number) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await file.read(buffer, offset, size - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

async function hasAnimatedPngControlChunk(file: FileHandle, fileSize: number): Promise<boolean | undefined> {
  let offset = PNG_SIGNATURE.length;
  for (let chunks = 0; chunks < MAX_PNG_ANIMATION_SCAN_CHUNKS && offset + 8 <= fileSize; chunks += 1) {
    const header = await readFileRange(file, offset, 8);
    if (header.length < 8) return undefined;
    const chunkLength = readUint32BE(header, 0);
    if (startsWithAscii(header, 4, 'acTL')) return true;
    if (startsWithAscii(header, 4, 'IDAT')) return false;
    const nextOffset = offset + 8 + chunkLength + 4;
    if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset || nextOffset > fileSize) return undefined;
    offset = nextOffset;
  }
  return undefined;
}

function detectSupportedImageMimeType(buffer: Uint8Array) {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return buffer[3] === 0xf7 ? undefined : 'image/jpeg';
  if (startsWith(buffer, PNG_SIGNATURE)) return isPng(buffer) ? 'image/png' : undefined;
  if (startsWithAscii(buffer, 0, 'GIF')) return 'image/gif';
  if (startsWithAscii(buffer, 0, 'RIFF') && startsWithAscii(buffer, 8, 'WEBP')) return 'image/webp';
  return undefined;
}

function isPng(buffer: Uint8Array) {
  return buffer.length >= 16 && readUint32BE(buffer, PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, 'IHDR');
}

function readUint32BE(buffer: Uint8Array, offset: number) {
  return ((buffer[offset] ?? 0) * 0x1000000)
    + ((buffer[offset + 1] ?? 0) << 16)
    + ((buffer[offset + 2] ?? 0) << 8)
    + (buffer[offset + 3] ?? 0);
}

function startsWith(buffer: Uint8Array, bytes: number[]) {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Uint8Array, offset: number, text: string) {
  if (buffer.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (buffer[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function agentEventType(event: unknown) {
  return event && typeof event === 'object' && typeof (event as { type?: unknown }).type === 'string' ? (event as { type: string }).type : undefined;
}

function agentEventWillRetry(event: unknown) {
  return event && typeof event === 'object' && (event as { willRetry?: unknown }).willRetry === true;
}

function isCommandActivityStartEvent(type: string | undefined) {
  return type === 'agent_start' || type === 'compaction_start' || type === 'auto_retry_start' || type === 'message_update' || type === 'tool_execution_start';
}

function isAgentAlreadyProcessingMessage(message: string) {
  return /agent is already processing/i.test(message);
}

function projectIdFromStreamKey(key: string) {
  const index = key.indexOf(':');
  return index === -1 ? undefined : key.slice(0, index);
}

function isWorkspaceNotificationEvent(event: AgentEvent) {
  if (['agent:start', 'agent:finish', 'agent:error', 'agent:notice', 'agent:ui-request', 'bash:start', 'bash:finish', 'bash:error', 'error'].includes(event.type)) return true;
  if (event.type !== 'agent:event' || !event.data || typeof event.data !== 'object') return false;
  const type = (event.data as { type?: unknown }).type;
  if (typeof type !== 'string') return false;
  return ['notice', 'auto_retry_start', 'auto_retry_end', 'compaction_start', 'compaction_end', 'extension_ui_request'].includes(type)
    || /approval|permission|confirm|input|select|notify|review/i.test(type);
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
