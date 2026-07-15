import type { FastifyInstance } from 'fastify';
import { exec, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import * as pty from 'node-pty';
import { clearProjectFileCaches } from './files.js';
import type { ProjectRegistry } from './projects.js';
import { resolveWithin } from './util.js';

const MAX_COMMAND_LENGTH = 4000;
const MAX_TERMINAL_INPUT_LENGTH = 64 * 1024;
const MAX_TERMINAL_REPLAY_LENGTH = 1024 * 1024;
const MAX_TERMINAL_PENDING_DATA_LENGTH = 128 * 1024;
const MAX_TERMINAL_METADATA_LENGTH = 2048;
const TERMINAL_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_TERMINAL_ID = 'default';
const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
const MIN_TERMINAL_COLS = 20;
const MIN_TERMINAL_ROWS = 5;
const MAX_TERMINAL_COLS = 500;
const MAX_TERMINAL_ROWS = 200;
const TERM_PROGRAM = 'pi-web';

type Disposable = { dispose(): void };

type WebSocket = {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: 'close' | 'message', listener: (...args: any[]) => void): void;
};

type TerminalClientMessage = {
  type?: string;
  data?: unknown;
  cols?: unknown;
  rows?: unknown;
  cwd?: unknown;
  title?: unknown;
};

type TerminalSession = {
  key: string;
  id: string;
  projectId: string;
  cwd: string;
  shell: string;
  shellName: string;
  title?: string;
  terminal: pty.IPty;
  sockets: Set<WebSocket>;
  replay: string;
  pendingData: string;
  cols: number;
  rows: number;
  idleTimer?: NodeJS.Timeout;
  dataFlush?: NodeJS.Immediate;
  disposed?: boolean;
  dataDisposable?: Disposable;
  exitDisposable?: Disposable;
};

export async function registerTerminalRoutes(app: FastifyInstance, registry: ProjectRegistry, options: { isClosing?: () => boolean } = {}) {
  const terminalSessions = new Map<string, TerminalSession>();
  const commandChildren = new Set<ChildProcess>();
  const commandProcessSessions = new Set<number>();
  let closing = false;
  const commandGroupSweepTimer = process.platform === 'win32' ? undefined : setInterval(() => {
    for (const sessionId of commandProcessSessions) {
      if (!processGroupExists(sessionId) && !processGroupsForSessions([sessionId]).length) commandProcessSessions.delete(sessionId);
    }
  }, 1_000);
  commandGroupSweepTimer?.unref();

  app.addHook('preClose', async () => {
    closing = true;
    const terminalProcessSessions = process.platform === 'win32'
      ? []
      : [...terminalSessions.values()].map((session) => session.terminal.pid).filter((pid) => pid > 0);
    const processSessionIds = [...new Set([...commandProcessSessions, ...terminalProcessSessions])];
    const processGroupIds = [...new Set([...processSessionIds, ...processGroupsForSessions(processSessionIds)])];
    for (const session of terminalSessions.values()) disposeTerminalSession(terminalSessions, session, true);
    if (commandGroupSweepTimer) clearInterval(commandGroupSweepTimer);
    for (const processGroupId of processGroupIds) signalProcessGroup(processGroupId, 'SIGTERM');
    for (const child of commandChildren) if (process.platform === 'win32') signalCommandChild(child, 'SIGTERM');
    await waitForCommandProcesses(processGroupIds, commandChildren, 1_000);
    const remainingProcessGroupIds = [...new Set([...processGroupIds, ...processGroupsForSessions(processSessionIds)])];
    for (const processGroupId of remainingProcessGroupIds) if (processGroupExists(processGroupId)) signalProcessGroup(processGroupId, 'SIGKILL');
    for (const child of commandChildren) if (process.platform === 'win32') signalCommandChild(child, 'SIGKILL');
    await waitForCommandProcesses(remainingProcessGroupIds, commandChildren, 250);
    commandProcessSessions.clear();
    commandChildren.clear();
  });

  app.post<{ Params: { projectId: string }; Body: { command?: string; cwd?: string } }>('/api/projects/:projectId/terminal', async (request, reply) => {
    if (closing || options.isClosing?.()) return reply.code(503).send({ error: 'pi-web is shutting down.' });
    const command = request.body?.command?.trim();
    if (!command) return reply.code(400).send({ error: 'Missing command' });
    if (command.length > MAX_COMMAND_LENGTH) return reply.code(400).send({ error: 'Command is too long' });

    try {
      const project = registry.get(request.params.projectId);
      const cwd = resolveWithin(project.path, request.body?.cwd ?? '.');
      const options = {
        cwd,
        shell: resolveShell(),
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
        env: process.env,
        detached: process.platform !== 'win32',
      };

      try {
        const { stdout, stderr } = await executeTrackedCommand(commandChildren, commandProcessSessions, command, options);
        return { stdout, stderr, exitCode: 0, cwd };
      } catch (error) {
        const failed = error as Error & { stdout?: string; stderr?: string; code?: number | string; signal?: string };
        return {
          stdout: failed.stdout ?? '',
          stderr: failed.stderr ?? failed.message,
          exitCode: typeof failed.code === 'number' ? failed.code : 1,
          signal: failed.signal,
          cwd,
        };
      } finally {
        clearProjectFileCaches(project.id);
      }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Command failed' });
    }
  });

  app.get<{ Params: { projectId: string }; Querystring: { projectPath?: string; cwd?: string; cols?: string; rows?: string; terminalId?: string } }>('/ws/projects/:projectId/terminal', { websocket: true }, (connection: any, request) => {
    const socket: WebSocket = connection.socket ?? connection;
    if (closing || options.isClosing?.()) {
      sendTerminalMessage(socket, { type: 'error', message: 'pi-web is shutting down.' });
      socket.close();
      return;
    }

    try {
      const project = registry.getOrAdd(request.params.projectId, request.query.projectPath, { hidden: true });
      const cwd = resolveWithin(project.path, request.query.cwd ?? '.');
      const shell = resolveShell();
      const terminalId = normalizeTerminalId(request.query.terminalId);
      const key = terminalSessionKey(project.id, cwd, terminalId);
      const cols = terminalDimension(request.query.cols, DEFAULT_TERMINAL_COLS, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS);
      const rows = terminalDimension(request.query.rows, DEFAULT_TERMINAL_ROWS, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS);
      let session = terminalSessions.get(key);
      if (!session) {
        session = createTerminalSession(terminalSessions, key, terminalId, project.id, cwd, shell, cols, rows);
        terminalSessions.set(key, session);
      }
      attachTerminalSocket(terminalSessions, session, socket, cols, rows);
    } catch (error) {
      sendTerminalMessage(socket, { type: 'error', message: error instanceof Error ? error.message : 'Could not start terminal' });
      socket.close();
    }
  });
}

function createTerminalSession(sessions: Map<string, TerminalSession>, key: string, id: string, projectId: string, cwd: string, shell: string, cols: number, rows: number): TerminalSession {
  const terminal = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cwd,
    cols,
    rows,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: process.env.FORCE_COLOR ?? '1',
      TERM_PROGRAM,
      PWD: cwd,
    },
  });
  const session: TerminalSession = {
    key,
    id,
    projectId,
    cwd,
    shell,
    shellName: basename(shell),
    terminal,
    sockets: new Set(),
    replay: '',
    pendingData: '',
    cols,
    rows,
  };

  session.dataDisposable = terminal.onData((data) => queueTerminalData(session, data));
  session.exitDisposable = terminal.onExit(({ exitCode, signal }) => {
    flushTerminalData(session);
    broadcastTerminalMessage(session, { type: 'exit', exitCode, signal });
    for (const socket of session.sockets) socket.close();
    disposeTerminalSession(sessions, session, false);
  });

  return session;
}

function attachTerminalSocket(sessions: Map<string, TerminalSession>, session: TerminalSession, socket: WebSocket, cols: number, rows: number) {
  clearTerminalIdleTimer(session);
  flushTerminalData(session);
  session.sockets.add(socket);
  resizeTerminalSession(session, cols, rows);
  sendTerminalMessage(socket, { type: 'ready', cwd: session.cwd, title: session.title, shell: session.shell, shellName: session.shellName, terminalId: session.id, persistent: true });
  if (session.replay) sendTerminalMessage(socket, { type: 'data', data: session.replay, replay: true });

  socket.on('message', (data: { toString(): string }) => {
    if (session.disposed) return;
    let message: TerminalClientMessage;
    try {
      message = JSON.parse(data.toString()) as TerminalClientMessage;
    } catch {
      sendTerminalMessage(socket, { type: 'error', message: 'Invalid terminal message' });
      return;
    }

    if (message.type === 'input') {
      if (typeof message.data !== 'string') return;
      if (message.data.length > MAX_TERMINAL_INPUT_LENGTH) {
        sendTerminalMessage(socket, { type: 'error', message: 'Terminal input is too large' });
        return;
      }
      clearProjectFileCaches(session.projectId);
      session.terminal.write(message.data);
      return;
    }

    if (message.type === 'resize') {
      resizeTerminalSession(
        session,
        terminalDimension(message.cols, DEFAULT_TERMINAL_COLS, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS),
        terminalDimension(message.rows, DEFAULT_TERMINAL_ROWS, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS),
      );
      return;
    }

    if (message.type === 'clear') {
      if (session.dataFlush) {
        clearImmediate(session.dataFlush);
        session.dataFlush = undefined;
      }
      session.pendingData = '';
      session.replay = '';
      broadcastTerminalMessage(session, { type: 'clear' });
      return;
    }

    if (message.type === 'metadata') {
      updateTerminalMetadata(session, message);
      return;
    }

    if (message.type === 'ping') sendTerminalMessage(socket, { type: 'pong' });
  });

  socket.on('close', () => {
    session.sockets.delete(socket);
    if (!session.disposed && !session.sockets.size) scheduleTerminalIdleCleanup(sessions, session);
  });
}

function queueTerminalData(session: TerminalSession, data: string) {
  if (session.disposed) return;
  session.replay = trimTerminalReplay(session.replay + data);
  session.pendingData += data;
  if (session.pendingData.length >= MAX_TERMINAL_PENDING_DATA_LENGTH) {
    flushTerminalData(session);
    return;
  }
  if (session.dataFlush) return;
  session.dataFlush = setImmediate(() => {
    session.dataFlush = undefined;
    flushTerminalData(session);
  });
  session.dataFlush.unref();
}

function flushTerminalData(session: TerminalSession) {
  if (session.dataFlush) {
    clearImmediate(session.dataFlush);
    session.dataFlush = undefined;
  }
  if (session.disposed || !session.pendingData) return;
  const data = session.pendingData;
  session.pendingData = '';
  clearProjectFileCaches(session.projectId);
  broadcastTerminalMessage(session, { type: 'data', data });
}

function updateTerminalMetadata(session: TerminalSession, message: TerminalClientMessage) {
  const title = normalizeTerminalMetadata(message.title);
  const cwd = normalizeTerminalMetadata(message.cwd);
  const update: { cwd?: string; title?: string } = {};
  if (title && title !== session.title) {
    session.title = title;
    update.title = title;
  }
  if (cwd && cwd !== session.cwd) {
    session.cwd = cwd;
    update.cwd = cwd;
  }
  if (update.cwd || update.title) broadcastTerminalMessage(session, { type: 'metadata', ...update });
}

function resizeTerminalSession(session: TerminalSession, cols: number, rows: number) {
  if (session.disposed || (session.cols === cols && session.rows === rows)) return;
  try {
    session.terminal.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
  } catch {
    broadcastTerminalMessage(session, { type: 'error', message: 'Could not resize terminal' });
  }
}

function broadcastTerminalMessage(session: TerminalSession, message: Record<string, unknown>) {
  for (const socket of session.sockets) sendTerminalMessage(socket, message);
}

function scheduleTerminalIdleCleanup(sessions: Map<string, TerminalSession>, session: TerminalSession) {
  clearTerminalIdleTimer(session);
  session.idleTimer = setTimeout(() => {
    if (!session.sockets.size) disposeTerminalSession(sessions, session, true);
  }, TERMINAL_IDLE_TTL_MS);
  session.idleTimer.unref();
}

function clearTerminalIdleTimer(session: TerminalSession) {
  if (!session.idleTimer) return;
  clearTimeout(session.idleTimer);
  session.idleTimer = undefined;
}

function disposeTerminalSession(sessions: Map<string, TerminalSession>, session: TerminalSession, kill: boolean) {
  if (session.disposed) return;
  session.disposed = true;
  clearTerminalIdleTimer(session);
  if (session.dataFlush) {
    clearImmediate(session.dataFlush);
    session.dataFlush = undefined;
  }
  session.pendingData = '';
  session.dataDisposable?.dispose();
  session.exitDisposable?.dispose();
  session.dataDisposable = undefined;
  session.exitDisposable = undefined;
  sessions.delete(session.key);
  if (!kill) return;
  if (process.platform !== 'win32' && session.terminal.pid > 0) signalProcessGroup(session.terminal.pid, 'SIGTERM');
  try {
    session.terminal.kill();
  } catch {
    // The process may already be gone.
  }
}

function signalCommandChild(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* Child already exited. */ }
  }
}

export function processGroupsForSessions(sessionIds: number[]) {
  if (process.platform === 'win32' || !sessionIds.length) return [];
  const targets = new Set(sessionIds);
  try {
    const output = execFileSync('ps', ['-eo', 'pgid=,sid='], { encoding: 'utf8', timeout: 1_000 });
    const processGroups = new Set<number>();
    for (const line of output.split('\n')) {
      const [processGroupId, sessionId] = line.trim().split(/\s+/).map(Number);
      if (processGroupId > 0 && targets.has(sessionId)) processGroups.add(processGroupId);
    }
    return [...processGroups];
  } catch {
    return [];
  }
}

export function processGroupExists(processGroupId: number) {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals) {
  if (process.platform === 'win32') return;
  try { process.kill(-processGroupId, signal); } catch { /* The process group may already be gone. */ }
}

async function waitForCommandProcesses(processGroupIds: number[], children: Set<ChildProcess>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const groupsRunning = processGroupIds.some(processGroupExists);
    const childrenRunning = process.platform === 'win32' && [...children].some((child) => child.exitCode === null && child.signalCode === null);
    if (!groupsRunning && !childrenRunning) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function executeTrackedCommand(children: Set<ChildProcess>, processSessions: Set<number>, command: string, options: Parameters<typeof exec>[1]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = exec(command, options, (error, stdout, stderr) => {
      children.delete(child);
      if (error) {
        Object.assign(error, { stdout: String(stdout), stderr: String(stderr) });
        reject(error);
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    children.add(child);
    if (process.platform !== 'win32' && child.pid) processSessions.add(child.pid);
    child.once('exit', () => children.delete(child));
  });
}

function resolveShell() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
  if (process.env.SHELL) return process.env.SHELL;
  if (existsSync('/bin/bash')) return '/bin/bash';
  return '/bin/sh';
}

function normalizeTerminalId(value: unknown) {
  if (typeof value !== 'string') return DEFAULT_TERMINAL_ID;
  const normalized = value.trim().replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80);
  return normalized || DEFAULT_TERMINAL_ID;
}

function terminalSessionKey(projectId: string, cwd: string, terminalId: string) {
  return `${projectId}:${terminalId}:${cwd}`;
}

function terminalDimension(value: unknown, fallback: number, min: number, max: number) {
  const number = typeof value === 'string' || typeof value === 'number' ? Number(value) : fallback;
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function normalizeTerminalMetadata(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return normalized ? normalized.slice(0, MAX_TERMINAL_METADATA_LENGTH) : undefined;
}

function trimTerminalReplay(value: string) {
  return value.length > MAX_TERMINAL_REPLAY_LENGTH ? value.slice(-MAX_TERMINAL_REPLAY_LENGTH) : value;
}

function sendTerminalMessage(socket: WebSocket, message: Record<string, unknown>) {
  if (socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // Ignore write races with websocket close.
  }
}
