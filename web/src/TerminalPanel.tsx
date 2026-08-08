import { SquareTerminal, X } from 'lucide-solid';
import { createEffect, createMemo, createSignal, For, onCleanup } from 'solid-js';
import type { Terminal as XTermTerminal } from '@xterm/xterm';
import { appWebSocketUrl } from './appUrl';
import { terminalCopyAction } from './terminalShortcuts';
import { isTerminalGeneratedReply, terminalQueriesExpectingReplies, terminalReplyMatchesQuery } from './terminalReplay';
import './terminal-font.css';

type TerminalProject = { id: string; path: string };
type ResolvedThemeMode = 'light' | 'dark';
type TerminalStatus = 'connecting' | 'restoring' | 'connected' | 'disconnected' | 'error';
type TerminalServerMessage = { type?: string; data?: string; dataOffset?: number; replay?: boolean; responseQuery?: string; cols?: number; rows?: number; resizeId?: number; hydrated?: boolean; cwd?: string; title?: string; shell?: string; shellName?: string; terminalId?: string; message?: string; exitCode?: number; signal?: number };
type TerminalRuntime = { Terminal: typeof import('@xterm/xterm').Terminal; FitAddon: typeof import('@xterm/addon-fit').FitAddon };
type Disposable = { dispose(): void };
type TerminalModifier = 'ctrl' | 'alt' | 'shift';
type TerminalSpecialKey = 'escape' | 'tab' | 'enter' | 'backspace' | 'delete' | 'up' | 'down' | 'right' | 'left' | 'home' | 'end' | 'pageUp' | 'pageDown';
type TerminalModifiers = { ctrl: boolean; alt: boolean; shift: boolean };
type TerminalMobileShortcut = { label: string; title: string; data: string } | { label: string; title: string; key: TerminalSpecialKey } | { label: string; title: string; text: string };

const TERMINAL_MOBILE_SHORTCUTS: TerminalMobileShortcut[] = [
  { label: 'esc', title: 'Escape', key: 'escape' },
  { label: 'tab', title: 'Tab', key: 'tab' },
  { label: '⇧tab', title: 'Shift + Tab', data: '\x1b[Z' },
  { label: '↵', title: 'Enter', key: 'enter' },
  { label: '⌫', title: 'Backspace', key: 'backspace' },
  { label: 'del', title: 'Delete', key: 'delete' },
  { label: '←', title: 'Left arrow', key: 'left' },
  { label: '↓', title: 'Down arrow', key: 'down' },
  { label: '↑', title: 'Up arrow', key: 'up' },
  { label: '→', title: 'Right arrow', key: 'right' },
  { label: 'home', title: 'Home', key: 'home' },
  { label: 'end', title: 'End', key: 'end' },
  { label: 'pgup', title: 'Page Up', key: 'pageUp' },
  { label: 'pgdn', title: 'Page Down', key: 'pageDown' },
  { label: '^C', title: 'Ctrl + C', data: '\x03' },
  { label: '^D', title: 'Ctrl + D', data: '\x04' },
  { label: '^Z', title: 'Ctrl + Z', data: '\x1a' },
  { label: '^L', title: 'Ctrl + L', data: '\x0c' },
  { label: '^A', title: 'Ctrl + A', data: '\x01' },
  { label: '^E', title: 'Ctrl + E', data: '\x05' },
  { label: '^U', title: 'Ctrl + U', data: '\x15' },
  { label: '^W', title: 'Ctrl + W', data: '\x17' },
  { label: '^R', title: 'Ctrl + R', data: '\x12' },
  { label: '^I', title: 'Ctrl + I / Tab', data: '\x09' },
  { label: '^Q', title: 'Ctrl + Q / resume output', data: '\x11' },
  { label: '/', title: 'Slash', text: '/' },
  { label: '|', title: 'Pipe', text: '|' },
  { label: '~', title: 'Tilde', text: '~' },
  { label: '-', title: 'Dash', text: '-' },
  { label: '_', title: 'Underscore', text: '_' },
];

const TERMINAL_FONT_FAMILY = '"Pi GeistMono Nerd Font Mono", "GeistMono Nerd Font Mono", "Geist Mono", "JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "JetBrains Mono", "Noto Color Emoji", monospace';
const TERMINAL_MEASURE_FONT_FAMILY = 'Pi GeistMono Nerd Font Mono';
const TERMINAL_FONT_SIZE = 14;
const TERMINAL_LINE_HEIGHT = 1.25;
const TERMINAL_LETTER_SPACING = 0;
const MAX_TERMINAL_QUEUED_INPUT_LENGTH = 64 * 1024;
const MAX_TERMINAL_METADATA_LENGTH = 2048;
const TERMINAL_HEARTBEAT_MS = 30_000;
const TERMINAL_HEARTBEAT_TIMEOUT_MS = 30_000;
const TERMINAL_RESIZE_SEND_DELAY_MS = 80;
const TERMINAL_RESIZE_SETTLE_DELAY_MS = 180;
const MIN_TERMINAL_COLS = 20;
const MIN_TERMINAL_ROWS = 5;
const MAX_TERMINAL_COLS = 500;
const MAX_TERMINAL_ROWS = 200;
const TERMINAL_RECONNECT_BASE_DELAY_MS = 750;
const TERMINAL_RECONNECT_MAX_DELAY_MS = 8_000;
const TERMINAL_RECONNECT_STABLE_MS = 10_000;
const TERMINAL_REPLACED_CLOSE_CODE = 4001;
const TERMINAL_STALE_CONNECTION_CLOSE_CODE = 4002;
const TERMINAL_PROTOCOL = '2';
const TERMINAL_SHIFT_CHARACTERS: Record<string, string> = {
  '`': '~',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
  '-': '_',
  '=': '+',
  '[': '{',
  ']': '}',
  '\\': '|',
  ';': ':',
  "'": '"',
  ',': '<',
  '.': '>',
  '/': '?',
};
let terminalRuntimePromise: Promise<TerminalRuntime> | undefined;
let terminalPrimaryClipboardText = '';
let terminalConnectionGeneration = 0;
const terminalClientId = globalThis.crypto?.randomUUID?.() ?? `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export default function TerminalPanel(props: { project: TerminalProject; themeMode: ResolvedThemeMode; onFilesystemActivity?: () => void; onClose: () => void }) {
  let terminalElement: HTMLDivElement | undefined;
  let terminal: XTermTerminal | undefined;
  let terminalSocket: WebSocket | undefined;
  let sendInputRef: ((data: string) => void) | undefined;
  let mobileShortcutPointer: { id: number; x: number; y: number; moved: boolean } | undefined;
  let autoReconnectAttempts = 0;
  let pendingProjectId = props.project.id;
  let pendingGeneratedInput = '';
  let pendingInput = '';
  let pendingMetadata: { cwd?: string; title?: string } = {};
  const [status, setStatus] = createSignal<TerminalStatus>('connecting');
  const [shellName, setShellName] = createSignal('terminal');
  const [cwd, setCwd] = createSignal(props.project.path);
  const [reconnectKey, setReconnectKey] = createSignal(0);
  const [ctrlSticky, setCtrlSticky] = createSignal(false);
  const [altSticky, setAltSticky] = createSignal(false);
  const [shiftSticky, setShiftSticky] = createSignal(false);
  const statusText = createMemo(() => {
    if (status() === 'connected') return 'Connected';
    if (status() === 'connecting') return 'Connecting';
    if (status() === 'restoring') return 'Restoring';
    if (status() === 'error') return 'Error';
    return 'Disconnected';
  });
  const statusClass = createMemo(() => status() === 'connected' ? 'terminal-status-connected' : status() === 'error' ? 'terminal-status-error' : '');
  const focusTerminal = () => {
    terminal?.focus();
    queueMicrotask(() => terminal?.focus());
  };
  const resetMobileModifiers = () => {
    setCtrlSticky(false);
    setAltSticky(false);
    setShiftSticky(false);
  };
  const sendMobileInput = (data: string) => {
    sendInputRef?.(data);
    resetMobileModifiers();
    focusTerminal();
  };
  const sendMobileKey = (key: TerminalSpecialKey) => {
    sendInputRef?.(terminalSpecialKeySequence(key, { ctrl: ctrlSticky(), alt: altSticky(), shift: shiftSticky() }));
    resetMobileModifiers();
    focusTerminal();
  };
  const sendMobileText = (text: string) => {
    sendInputRef?.(terminalTextSequence(text, { ctrl: ctrlSticky(), alt: altSticky(), shift: shiftSticky() }));
    resetMobileModifiers();
    focusTerminal();
  };
  const toggleMobileModifier = (modifier: TerminalModifier) => {
    if (modifier === 'ctrl') setCtrlSticky((value) => !value);
    else if (modifier === 'alt') setAltSticky((value) => !value);
    else setShiftSticky((value) => !value);
    focusTerminal();
  };
  const clearTerminal = () => {
    if (status() !== 'connected') return;
    sendTerminalClientMessage(terminalSocket, { type: 'clear' });
    focusTerminal();
  };
  const reconnectTerminal = () => {
    if (status() === 'connecting' || status() === 'restoring') return;
    autoReconnectAttempts = 0;
    setStatus('connecting');
    setReconnectKey((key) => key + 1);
  };
  const startMobileShortcutPointer = (event: PointerEvent) => {
    event.preventDefault();
    mobileShortcutPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  };
  const moveMobileShortcutPointer = (event: PointerEvent) => {
    if (!mobileShortcutPointer || mobileShortcutPointer.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - mobileShortcutPointer.x, event.clientY - mobileShortcutPointer.y) > 8) mobileShortcutPointer.moved = true;
  };
  const cancelMobileShortcutPointer = (event: PointerEvent) => {
    if (mobileShortcutPointer?.id === event.pointerId) mobileShortcutPointer = undefined;
  };
  const finishMobileShortcutPointer = (event: PointerEvent, action: () => void) => {
    const pointer = mobileShortcutPointer;
    if (pointer?.id === event.pointerId) mobileShortcutPointer = undefined;
    if (!pointer || pointer.id !== event.pointerId || pointer.moved) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement | null)?.blur();
    action();
  };

  createEffect(() => {
    props.themeMode;
    const xterm = terminal;
    if (!xterm) return;
    queueMicrotask(() => {
      if (terminal !== xterm) return;
      xterm.options.theme = terminalTheme();
      xterm.refresh(0, xterm.rows - 1);
    });
  });

  createEffect(() => {
    const projectId = props.project.id;
    const projectPath = props.project.path;
    reconnectKey();
    if (!terminalElement) return;
    if (pendingProjectId !== projectId) {
      pendingProjectId = projectId;
      pendingGeneratedInput = '';
      pendingInput = '';
      pendingMetadata = {};
    }

    let disposed = false;
    let xterm: XTermTerminal | undefined;
    let socket: WebSocket | undefined;
    let inputDisposable: Disposable | undefined;
    let titleDisposable: Disposable | undefined;
    let osc7Disposable: Disposable | undefined;
    let osc52Disposable: Disposable | undefined;
    let osc633Disposable: Disposable | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let resizeTimer: number | undefined;
    let resizeFrame: number | undefined;
    let resizeSettledTimer: number | undefined;
    let resizeMessageTimer: number | undefined;
    let reconnectTimer: number | undefined;
    let reconnectAttemptResetTimer: number | undefined;
    let heartbeatTimer: number | undefined;
    let heartbeatTimeoutTimer: number | undefined;
    let resumeHeartbeat: (() => void) | undefined;
    let terminalExited = false;
    let serverReady = false;
    let replaySideEffectSuppression = 0;
    const expectedReplayReplies: { query: string }[] = [];
    let resizeTerminal: ((immediate?: boolean, forceRefresh?: boolean) => void) | undefined;
    let scheduleResizeTerminal: (() => void) | undefined;

    setStatus('connecting');
    setShellName('terminal');
    setCwd(projectPath);
    terminalElement.textContent = 'Loading terminal…';

    void loadTerminalRuntime()
      .then(({ Terminal, FitAddon }) => {
        if (disposed || !terminalElement) return;
        terminalElement.replaceChildren();

        xterm = new Terminal({
          allowTransparency: true,
          cursorBlink: false,
          cursorInactiveStyle: 'block',
          cursorStyle: 'block',
          customGlyphs: true,
          drawBoldTextInBrightColors: true,
          fontFamily: TERMINAL_FONT_FAMILY,
          fontSize: TERMINAL_FONT_SIZE,
          fontWeight: 400,
          fontWeightBold: 600,
          letterSpacing: TERMINAL_LETTER_SPACING,
          lineHeight: TERMINAL_LINE_HEIGHT,
          macOptionClickForcesSelection: true,
          rescaleOverlappingGlyphs: true,
          scrollback: 6000,
          theme: terminalTheme(),
        });
        const fitAddon = new FitAddon();
        xterm.loadAddon(fitAddon);
        xterm.open(terminalElement);
        terminal = xterm;

        const sendTerminalMetadata = (metadata: { cwd?: string; title?: string }) => {
          if (status() === 'connected' && sendTerminalClientMessage(socket, { type: 'metadata', ...metadata })) return;
          pendingMetadata = { ...pendingMetadata, ...metadata };
        };
        const updateTerminalTitle = (value: string) => {
          const title = normalizeTerminalMetadata(value);
          if (!title || title === shellName()) return;
          setShellName(title);
          sendTerminalMetadata({ title });
        };
        const updateTerminalCwd = (value: string) => {
          const nextCwd = normalizeTerminalMetadata(value);
          if (!nextCwd || nextCwd === cwd()) return;
          setCwd(nextCwd);
          sendTerminalMetadata({ cwd: nextCwd });
        };
        const sendTerminalInput = (data: string) => {
          props.onFilesystemActivity?.();
          if (status() === 'connected' && sendTerminalClientMessage(socket, { type: 'input', data })) return;
          pendingInput = trimTerminalQueuedInput(pendingInput + data);
        };
        const sendTerminalGeneratedInput = (data: string) => {
          if (status() === 'connected' && sendTerminalClientMessage(socket, { type: 'input', data })) return;
          pendingGeneratedInput = trimTerminalQueuedInput(pendingGeneratedInput + data);
        };
        let deferredAckOffset = 0;
        let lastHydrationProgressAt = 0;
        let rendererOperations = Promise.resolve();
        const enqueueRendererOperation = (operation: () => void | Promise<void>) => {
          rendererOperations = rendererOperations.then(async () => {
            if (disposed || terminal !== xterm || terminalSocket !== socket || !xterm) return;
            await operation();
          }).catch(() => undefined);
          return rendererOperations;
        };
        const writeTerminalData = (data: string, replay = false, dataOffset?: number, responseQuery?: string, cols?: number, rows?: number) => {
          void enqueueRendererOperation(() => new Promise<void>((resolve) => {
            if (!xterm) {
              resolve();
              return;
            }
            if (replay && Number.isSafeInteger(cols) && Number.isSafeInteger(rows)) {
              const replayCols = Math.max(MIN_TERMINAL_COLS, Math.min(MAX_TERMINAL_COLS, cols!));
              const replayRows = Math.max(MIN_TERMINAL_ROWS, Math.min(MAX_TERMINAL_ROWS, rows!));
              if (xterm.cols !== replayCols || xterm.rows !== replayRows) xterm.resize(replayCols, replayRows);
            }
            // Historical queries stay inert, except a query that was incomplete when this client attached.
            const expectedReplies = replay && responseQuery
              ? terminalQueriesExpectingReplies(responseQuery).map((query) => ({ query }))
              : [];
            expectedReplayReplies.push(...expectedReplies);
            if (replay) {
              replaySideEffectSuppression += 1;
              const now = Date.now();
              if (status() === 'restoring' && now - lastHydrationProgressAt >= 2_000 && sendTerminalClientMessage(socket, { type: 'hydrate-progress' })) lastHydrationProgressAt = now;
            }
            xterm.write(data, () => {
              if (replay) {
                replaySideEffectSuppression = Math.max(0, replaySideEffectSuppression - 1);
                const now = Date.now();
                if (status() === 'restoring' && now - lastHydrationProgressAt >= 2_000 && sendTerminalClientMessage(socket, { type: 'hydrate-progress' })) lastHydrationProgressAt = now;
              }
              for (const expectedReply of expectedReplies) {
                const index = expectedReplayReplies.indexOf(expectedReply);
                if (index >= 0) expectedReplayReplies.splice(index, 1);
              }
              if (Number.isSafeInteger(dataOffset)) {
                if (status() === 'connected') sendTerminalClientMessage(socket, { type: 'ack', dataOffset });
                else deferredAckOffset = Math.max(deferredAckOffset, dataOffset!);
              }
              resolve();
            });
          }));
        };
        const writeTerminalLine = (data: string) => {
          void enqueueRendererOperation(() => new Promise<void>((resolve) => xterm?.writeln(data, resolve)));
        };
        const clearTerminalDisplay = () => {
          void enqueueRendererOperation(() => new Promise<void>((resolve) => {
            if (!xterm) {
              resolve();
              return;
            }
            xterm.write('', () => {
              xterm?.clear();
              resolve();
            });
          }));
        };
        sendInputRef = sendTerminalInput;
        titleDisposable = xterm.onTitleChange(updateTerminalTitle);
        osc7Disposable = xterm.parser.registerOscHandler(7, (data) => {
          const nextCwd = terminalCwdFromOsc7(data);
          if (nextCwd) updateTerminalCwd(nextCwd);
          return true;
        });
        osc52Disposable = xterm.parser.registerOscHandler(52, (data) => {
          if (replaySideEffectSuppression === 0) {
            const clipboard = terminalClipboardTextFromOsc52(data);
            if (clipboard) void writeTerminalClipboardText(clipboard.selection, clipboard.text);
          }
          return true;
        });
        osc633Disposable = xterm.parser.registerOscHandler(633, (data) => {
          const nextCwd = terminalCwdFromOsc633(data);
          if (nextCwd) updateTerminalCwd(nextCwd);
          return true;
        });
        xterm.attachCustomKeyEventHandler((event) => handleTerminalKeyEvent(event, xterm!));

        let lastConfirmedCols = xterm.cols;
        let lastConfirmedRows = xterm.rows;
        let lastResizeSentAt = 0;
        let nextResizeId = 0;
        let restoreSnapshotComplete = false;
        let resizeInFlight: { id: number; hydration: boolean; forceRefresh: boolean } | undefined;
        let pendingResize: { cols: number; rows: number; forceRefresh: boolean } | undefined;
        const refreshTerminal = () => {
          if (!xterm || xterm.rows <= 0) return;
          xterm.clearTextureAtlas();
          xterm.refresh(0, xterm.rows - 1);
        };
        const sendPendingResize = (immediate = false) => {
          if (!socket || socket.readyState !== WebSocket.OPEN || resizeInFlight || !pendingResize) return;
          const hydration = status() === 'restoring';
          if ((hydration && !restoreSnapshotComplete) || (!hydration && status() !== 'connected')) return;
          if (!hydration && pendingResize.cols === lastConfirmedCols && pendingResize.rows === lastConfirmedRows) {
            const forceRefresh = pendingResize.forceRefresh;
            pendingResize = undefined;
            if (forceRefresh) void enqueueRendererOperation(refreshTerminal);
            return;
          }
          if (resizeMessageTimer !== undefined) {
            if (!immediate) return;
            window.clearTimeout(resizeMessageTimer);
            resizeMessageTimer = undefined;
          }

          const sendResize = () => {
            resizeMessageTimer = undefined;
            if (!pendingResize || resizeInFlight || !socket || socket.readyState !== WebSocket.OPEN) return;
            const resize = pendingResize;
            const resizeId = ++nextResizeId;
            if (sendTerminalClientMessage(socket, { type: hydration ? 'hydrate' : 'resize', resizeId, cols: resize.cols, rows: resize.rows })) {
              pendingResize = undefined;
              resizeInFlight = { id: resizeId, hydration, forceRefresh: resize.forceRefresh };
              lastResizeSentAt = Date.now();
            }
          };

          const delay = hydration || immediate ? 0 : Math.max(0, TERMINAL_RESIZE_SEND_DELAY_MS - (Date.now() - lastResizeSentAt));
          if (delay === 0) sendResize();
          else resizeMessageTimer = window.setTimeout(sendResize, delay);
        };
        resizeTerminal = (immediate = false, forceRefresh = false) => {
          if (!xterm || !terminalElement || !terminalElement.isConnected) return;
          const bounds = terminalElement.getBoundingClientRect();
          if (bounds.width <= 0 || bounds.height <= 0) return;
          try {
            const proposed = fitAddon.proposeDimensions();
            if (!proposed) return;
            const cols = Math.max(MIN_TERMINAL_COLS, Math.min(MAX_TERMINAL_COLS, proposed.cols));
            const rows = Math.max(MIN_TERMINAL_ROWS, Math.min(MAX_TERMINAL_ROWS, proposed.rows));
            if (!socket) {
              if (xterm.cols !== cols || xterm.rows !== rows) xterm.resize(cols, rows);
              lastConfirmedCols = cols;
              lastConfirmedRows = rows;
              if (forceRefresh) refreshTerminal();
              return;
            }
            pendingResize = { cols, rows, forceRefresh: forceRefresh || pendingResize?.forceRefresh === true };
            sendPendingResize(immediate);
          } catch {
            // Measurement can fail while fonts/layout are still settling.
          }
        };
        scheduleResizeTerminal = () => {
          if (resizeFrame === undefined) {
            resizeFrame = window.requestAnimationFrame(() => {
              resizeFrame = undefined;
              resizeTerminal?.();
            });
          }
          if (resizeSettledTimer !== undefined) window.clearTimeout(resizeSettledTimer);
          resizeSettledTimer = window.setTimeout(() => {
            resizeSettledTimer = undefined;
            resizeTerminal?.(true, true);
          }, TERMINAL_RESIZE_SETTLE_DELAY_MS);
        };

        void document.fonts.load(`${TERMINAL_FONT_SIZE}px "${TERMINAL_MEASURE_FONT_FAMILY}"`)
          .then(() => {
            if (terminal !== xterm || !resizeTerminal || !xterm) return;
            resizeTerminal(true, true);
          })
          .catch(() => undefined);

        resizeTerminal();
        const connectionGeneration = ++terminalConnectionGeneration;
        const params = new URLSearchParams({
          projectPath,
          cols: String(xterm.cols),
          rows: String(xterm.rows),
          terminalId: 'main',
          protocol: TERMINAL_PROTOCOL,
          clientId: terminalClientId,
          generation: String(connectionGeneration),
        });
        const clearHeartbeatTimeout = () => {
          if (heartbeatTimeoutTimer === undefined) return;
          window.clearTimeout(heartbeatTimeoutTimer);
          heartbeatTimeoutTimer = undefined;
        };
        const clearHeartbeatTimers = () => {
          if (heartbeatTimer !== undefined) {
            window.clearInterval(heartbeatTimer);
            heartbeatTimer = undefined;
          }
          clearHeartbeatTimeout();
        };
        const closeTerminalSocket = () => {
          if (!socket || socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) return;
          try {
            socket.close();
          } catch {
            // Ignore close races.
          }
        };
        const sendTerminalHeartbeat = () => {
          if (document.visibilityState === 'hidden' || heartbeatTimeoutTimer !== undefined) return;
          const currentSocket = socket;
          if (!currentSocket || currentSocket.readyState !== WebSocket.OPEN) return;
          if (!sendTerminalClientMessage(currentSocket, { type: 'ping' })) {
            closeTerminalSocket();
            return;
          }
          heartbeatTimeoutTimer = window.setTimeout(() => {
            heartbeatTimeoutTimer = undefined;
            if (terminalSocket === currentSocket && currentSocket.readyState === WebSocket.OPEN) closeTerminalSocket();
          }, TERMINAL_HEARTBEAT_TIMEOUT_MS);
        };
        const startTerminalHeartbeat = () => {
          clearHeartbeatTimers();
          sendTerminalHeartbeat();
          heartbeatTimer = window.setInterval(sendTerminalHeartbeat, TERMINAL_HEARTBEAT_MS);
        };

        socket = new WebSocket(appWebSocketUrl(`/ws/projects/${projectId}/terminal?${params}`));
        terminalSocket = socket;
        resumeHeartbeat = () => {
          if (document.visibilityState === 'hidden') {
            clearHeartbeatTimeout();
            return;
          }
          clearHeartbeatTimeout();
          sendTerminalHeartbeat();
        };
        document.addEventListener('visibilitychange', resumeHeartbeat);
        window.addEventListener('focus', resumeHeartbeat);

        inputDisposable = xterm.onData((data) => {
          if (replaySideEffectSuppression > 0 && isTerminalGeneratedReply(data)) {
            const expectedReplyIndex = expectedReplayReplies.findIndex(({ query }) => terminalReplyMatchesQuery(query, data));
            if (expectedReplyIndex < 0) return;
            expectedReplayReplies.splice(expectedReplyIndex, 1);
            sendTerminalGeneratedInput(data);
            return;
          }
          if (status() === 'restoring' && isTerminalGeneratedReply(data)) {
            sendTerminalGeneratedInput(data);
            return;
          }
          const modifiers = { ctrl: ctrlSticky(), alt: altSticky(), shift: shiftSticky() };
          const modifiedData = terminalModifiedInputSequence(data, modifiers);
          if (modifiedData !== undefined) {
            sendTerminalInput(modifiedData);
            resetMobileModifiers();
            return;
          }
          if (modifiers.ctrl || modifiers.alt || modifiers.shift) resetMobileModifiers();
          sendTerminalInput(data);
        });

        socket.addEventListener('open', () => {
          if (terminalSocket !== socket) return;
          startTerminalHeartbeat();
        });
        const requestTerminalHydration = () => {
          if (!serverReady || status() !== 'restoring') return;
          void enqueueRendererOperation(() => {
            if (!xterm || status() !== 'restoring') return;
            restoreSnapshotComplete = true;
            resizeTerminal?.(true, true);
            pendingResize ??= { cols: xterm.cols, rows: xterm.rows, forceRefresh: true };
            sendPendingResize(true);
          });
        };

        socket.addEventListener('message', (event) => {
          if (terminalSocket !== socket || !xterm) return;
          let message: TerminalServerMessage;
          try {
            message = JSON.parse(event.data) as TerminalServerMessage;
          } catch {
            return;
          }
          if (message.type === 'pong') {
            clearHeartbeatTimeout();
            return;
          }

          if (message.type === 'ready') {
            serverReady = true;
            setStatus('restoring');
            setShellName(normalizeTerminalMetadata(message.title ?? '') || message.shellName || message.shell || 'terminal');
            setCwd(normalizeTerminalMetadata(message.cwd ?? '') || projectPath);
          } else if (message.type === 'replay-complete') {
            requestTerminalHydration();
          } else if (message.type === 'resized' && Number.isSafeInteger(message.resizeId) && Number.isSafeInteger(message.cols) && Number.isSafeInteger(message.rows)) {
            const request = resizeInFlight;
            if (!request || request.id !== message.resizeId) return;
            const acceptedCols = Math.max(MIN_TERMINAL_COLS, Math.min(MAX_TERMINAL_COLS, message.cols!));
            const acceptedRows = Math.max(MIN_TERMINAL_ROWS, Math.min(MAX_TERMINAL_ROWS, message.rows!));
            void enqueueRendererOperation(() => {
              if (!xterm) return;
              if (xterm.cols !== acceptedCols || xterm.rows !== acceptedRows) xterm.resize(acceptedCols, acceptedRows);
              if (request.forceRefresh) refreshTerminal();
            }).then(() => {
              if (disposed || terminalExited || terminalSocket !== socket || terminal !== xterm || resizeInFlight !== request) return;
              lastConfirmedCols = acceptedCols;
              lastConfirmedRows = acceptedRows;
              resizeInFlight = undefined;
              if (request.hydration && message.hydrated === true && status() === 'restoring') {
                setStatus('connected');
                if (reconnectAttemptResetTimer !== undefined) window.clearTimeout(reconnectAttemptResetTimer);
                reconnectAttemptResetTimer = window.setTimeout(() => {
                  reconnectAttemptResetTimer = undefined;
                  if (!disposed && terminalSocket === socket) autoReconnectAttempts = 0;
                }, TERMINAL_RECONNECT_STABLE_MS);
                if (deferredAckOffset > 0 && sendTerminalClientMessage(socket, { type: 'ack', dataOffset: deferredAckOffset })) deferredAckOffset = 0;
                if (pendingGeneratedInput && sendTerminalClientMessage(socket, { type: 'input', data: pendingGeneratedInput })) pendingGeneratedInput = '';
                if (pendingInput && sendTerminalClientMessage(socket, { type: 'input', data: pendingInput })) pendingInput = '';
                if ((pendingMetadata.cwd || pendingMetadata.title) && sendTerminalClientMessage(socket, { type: 'metadata', ...pendingMetadata })) pendingMetadata = {};
                xterm?.focus();
              }
              sendPendingResize(true);
            });
          } else if (message.type === 'metadata') {
            const title = normalizeTerminalMetadata(message.title ?? '');
            const nextCwd = normalizeTerminalMetadata(message.cwd ?? '');
            if (title) setShellName(title);
            if (nextCwd) setCwd(nextCwd);
          } else if (message.type === 'data' && typeof message.data === 'string') {
            props.onFilesystemActivity?.();
            writeTerminalData(message.data, message.replay === true, message.dataOffset, message.responseQuery, message.cols, message.rows);
          } else if (message.type === 'error') {
            serverReady = false;
            setStatus('error');
            writeTerminalLine(`\r\n\x1b[31m${message.message ?? 'Terminal error'}\x1b[0m`);
          } else if (message.type === 'clear') {
            clearTerminalDisplay();
          } else if (message.type === 'exit') {
            terminalExited = true;
            serverReady = false;
            props.onFilesystemActivity?.();
            setStatus('disconnected');
            writeTerminalLine(`\r\n\x1b[2mTerminal exited${typeof message.exitCode === 'number' ? ` with code ${message.exitCode}` : ''}.\x1b[0m`);
          }
        });
        socket.addEventListener('close', (event) => {
          if (terminalSocket !== socket) return;
          serverReady = false;
          clearHeartbeatTimers();
          if (resizeMessageTimer !== undefined) {
            window.clearTimeout(resizeMessageTimer);
            resizeMessageTimer = undefined;
          }
          if (reconnectAttemptResetTimer !== undefined) {
            window.clearTimeout(reconnectAttemptResetTimer);
            reconnectAttemptResetTimer = undefined;
          }
          setStatus(status() === 'error' ? 'error' : 'disconnected');
          if (disposed || terminalExited) return;
          if (event.code === TERMINAL_REPLACED_CLOSE_CODE) {
            writeTerminalLine('\r\n\x1b[2mTerminal opened in another window. Reconnect to take control.\x1b[0m');
            return;
          }
          if (event.code === TERMINAL_STALE_CONNECTION_CLOSE_CODE) return;

          const delay = Math.min(TERMINAL_RECONNECT_MAX_DELAY_MS, TERMINAL_RECONNECT_BASE_DELAY_MS * (2 ** Math.min(autoReconnectAttempts, 5)));
          autoReconnectAttempts += 1;
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = undefined;
            if (disposed || terminalExited || terminalSocket !== socket) return;
            setStatus('connecting');
            setReconnectKey((key) => key + 1);
          }, delay + Math.round(delay * 0.2 * Math.random()));
        });
        socket.addEventListener('error', () => {
          if (terminalSocket !== socket) return;
          serverReady = false;
          setStatus('error');
          closeTerminalSocket();
        });

        resizeObserver = new ResizeObserver(() => scheduleResizeTerminal?.());
        resizeObserver.observe(terminalElement);
        window.addEventListener('resize', scheduleResizeTerminal);
        window.visualViewport?.addEventListener('resize', scheduleResizeTerminal);
        queueMicrotask(() => scheduleResizeTerminal?.());
        resizeTimer = window.setTimeout(() => scheduleResizeTerminal?.(), 100);
      })
      .catch(() => {
        if (disposed || !terminalElement) return;
        setStatus('error');
        terminalElement.textContent = 'Could not load terminal.';
      });

    onCleanup(() => {
      disposed = true;
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
      if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame);
      if (resizeSettledTimer !== undefined) window.clearTimeout(resizeSettledTimer);
      if (resizeMessageTimer !== undefined) window.clearTimeout(resizeMessageTimer);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (reconnectAttemptResetTimer !== undefined) window.clearTimeout(reconnectAttemptResetTimer);
      if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
      if (heartbeatTimeoutTimer !== undefined) window.clearTimeout(heartbeatTimeoutTimer);
      if (resumeHeartbeat) {
        document.removeEventListener('visibilitychange', resumeHeartbeat);
        window.removeEventListener('focus', resumeHeartbeat);
      }
      if (scheduleResizeTerminal) {
        window.removeEventListener('resize', scheduleResizeTerminal);
        window.visualViewport?.removeEventListener('resize', scheduleResizeTerminal);
      }
      resizeObserver?.disconnect();
      inputDisposable?.dispose();
      titleDisposable?.dispose();
      osc7Disposable?.dispose();
      osc52Disposable?.dispose();
      osc633Disposable?.dispose();
      if (terminalSocket === socket) terminalSocket = undefined;
      socket?.close();
      if (terminal === xterm) terminal = undefined;
      xterm?.dispose();
      terminalElement?.replaceChildren();
      sendInputRef = undefined;
    });
  });

  return (
    <section class="terminal-panel">
      <div class="terminal-toolbar">
        <div class="terminal-toolbar-desktop">
          <div class="terminal-title">
            <SquareTerminal class="size-3.5" />
            <span class="truncate">{shellName()}</span>
            <span class={`terminal-status ${statusClass()}`}>{statusText()}</span>
          </div>
          <div class="flex items-center gap-1.5">
            <button
              class="ghost h-7 px-2 text-xs"
              type="button"
              disabled={status() !== 'connected'}
              onClick={clearTerminal}
            >Clear</button>
            <button class="button-secondary h-7 px-2 text-xs" type="button" disabled={status() === 'connecting' || status() === 'restoring'} onClick={reconnectTerminal}>Reconnect</button>
            <button class="ghost" type="button" title="Close terminal" aria-label="Close terminal" onClick={props.onClose}><X class="size-4" /></button>
          </div>
        </div>
        <div class="terminal-toolbar-mobile">
          <div class="terminal-toolbar-row">
            <div class="terminal-title">
              <SquareTerminal class="size-3.5" />
              <span class="truncate">{shellName()}</span>
            </div>
            <button class="ghost shrink-0" type="button" title="Close terminal" aria-label="Close terminal" onClick={props.onClose}><X class="size-4" /></button>
          </div>
          <div class="terminal-toolbar-row">
            <span class={`terminal-status ${statusClass()}`}>{statusText()}</span>
            <button class="ghost h-7 px-2 text-xs" type="button" disabled={status() !== 'connected'} onClick={clearTerminal}>Clear</button>
            <button class="button-secondary h-7 px-2 text-xs" type="button" disabled={status() === 'connecting' || status() === 'restoring'} onClick={reconnectTerminal}>Reconnect</button>
          </div>
          <div class="terminal-toolbar-row terminal-mobile-keys">
            <button class={`ghost terminal-mobile-key ${ctrlSticky() ? 'terminal-key-active' : ''}`} type="button" tabIndex={-1} title="Ctrl modifier" aria-label="Ctrl modifier" onPointerDown={startMobileShortcutPointer} onPointerMove={moveMobileShortcutPointer} onPointerCancel={cancelMobileShortcutPointer} onPointerUp={(event) => finishMobileShortcutPointer(event, () => toggleMobileModifier('ctrl'))}>ctrl</button>
            <button class={`ghost terminal-mobile-key ${altSticky() ? 'terminal-key-active' : ''}`} type="button" tabIndex={-1} title="Alt modifier" aria-label="Alt modifier" onPointerDown={startMobileShortcutPointer} onPointerMove={moveMobileShortcutPointer} onPointerCancel={cancelMobileShortcutPointer} onPointerUp={(event) => finishMobileShortcutPointer(event, () => toggleMobileModifier('alt'))}>alt</button>
            <button class={`ghost terminal-mobile-key ${shiftSticky() ? 'terminal-key-active' : ''}`} type="button" tabIndex={-1} title="Shift modifier" aria-label="Shift modifier" onPointerDown={startMobileShortcutPointer} onPointerMove={moveMobileShortcutPointer} onPointerCancel={cancelMobileShortcutPointer} onPointerUp={(event) => finishMobileShortcutPointer(event, () => toggleMobileModifier('shift'))}>shift</button>
            <For each={TERMINAL_MOBILE_SHORTCUTS}>{(shortcut) => (
              <button
                class="ghost terminal-mobile-key"
                type="button"
                tabIndex={-1}
                title={shortcut.title}
                aria-label={shortcut.title}
                onPointerDown={startMobileShortcutPointer}
                onPointerMove={moveMobileShortcutPointer}
                onPointerCancel={cancelMobileShortcutPointer}
                onPointerUp={(event) => finishMobileShortcutPointer(event, () => {
                  if ('data' in shortcut) sendMobileInput(shortcut.data);
                  else if ('key' in shortcut) sendMobileKey(shortcut.key);
                  else sendMobileText(shortcut.text);
                })}
              >{shortcut.label}</button>
            )}</For>
          </div>
        </div>
      </div>
      <div ref={terminalElement} class="terminal-host" onMouseDown={() => terminal?.focus()} />
    </section>
  );
}

function handleTerminalKeyEvent(event: KeyboardEvent, terminal: XTermTerminal) {
  if (event.type !== 'keydown') return true;
  const key = event.key.toLowerCase();
  const hasSelection = terminal.hasSelection();
  const copyAction = terminalCopyAction(event, hasSelection, navigator.platform.toLowerCase().includes('mac'));

  if (copyAction) {
    event.preventDefault();
    if (hasSelection) {
      void copyTerminalSelection(terminal.getSelection());
      if (copyAction === 'copy-and-clear') terminal.clearSelection();
    }
    return false;
  }

  if (!event.altKey && key === 's' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    return false;
  }

  return true;
}

function terminalModifiedInputSequence(data: string, modifiers: TerminalModifiers) {
  if (!modifiers.ctrl && !modifiers.alt && !modifiers.shift) return undefined;
  const specialKey = terminalSpecialKeyFromInputSequence(data);
  if (specialKey) return terminalSpecialKeySequence(specialKey, modifiers);
  if (data.length !== 1) return undefined;
  return terminalTextSequence(terminalShiftText(data, modifiers.shift), modifiers);
}

function terminalTextSequence(text: string, modifiers: TerminalModifiers) {
  const ctrlSequence = modifiers.ctrl ? terminalControlSequenceForKey(text) : undefined;
  if (ctrlSequence) return modifiers.alt ? `\x1b${ctrlSequence}` : ctrlSequence;
  return modifiers.alt ? `\x1b${text}` : text;
}

function terminalShiftText(text: string, shift: boolean) {
  if (!shift || text.length !== 1) return text;
  return /[a-z]/.test(text) ? text.toUpperCase() : TERMINAL_SHIFT_CHARACTERS[text] ?? text;
}

function terminalSpecialKeyFromInputSequence(data: string): TerminalSpecialKey | undefined {
  if (data === '\x1b') return 'escape';
  if (data === '\t') return 'tab';
  if (data === '\r' || data === '\n') return 'enter';
  if (data === '\x7f' || data === '\b') return 'backspace';
  if (data === '\x1b[3~') return 'delete';
  if (data === '\x1b[A' || data === '\x1bOA') return 'up';
  if (data === '\x1b[B' || data === '\x1bOB') return 'down';
  if (data === '\x1b[C' || data === '\x1bOC') return 'right';
  if (data === '\x1b[D' || data === '\x1bOD') return 'left';
  if (data === '\x1b[H' || data === '\x1bOH') return 'home';
  if (data === '\x1b[F' || data === '\x1bOF') return 'end';
  if (data === '\x1b[5~') return 'pageUp';
  if (data === '\x1b[6~') return 'pageDown';
  if (data === '\x1b[Z') return 'tab';
  return undefined;
}

function terminalControlSequenceForKey(key: string) {
  if (key === 'Enter') return '\r';
  if (key === 'Tab') return '\t';
  if (key === 'Backspace') return '\x08';
  if (key === 'Escape') return '\x1b';
  if (key === ' ' || key === '@') return '\x00';
  if (key === '[' || key === '{') return '\x1b';
  if (key === '\\' || key === '|') return '\x1c';
  if (key === ']' || key === '}') return '\x1d';
  if (key === '^') return '\x1e';
  if (key === '_') return '\x1f';
  if (key === '?' || key === '/') return '\x7f';

  if (key.length !== 1) return undefined;
  const code = key.toLowerCase().charCodeAt(0);
  return code >= 97 && code <= 122 ? String.fromCharCode(code - 96) : undefined;
}

function terminalSpecialKeySequence(key: TerminalSpecialKey, modifiers: TerminalModifiers) {
  if (key === 'escape') return '\x1b';
  if (key === 'tab') {
    if (modifiers.shift) return '\x1b[Z';
    return modifiers.alt ? '\x1b\t' : '\t';
  }
  if (key === 'enter') return modifiers.alt ? '\x1b\r' : '\r';
  if (key === 'backspace') return modifiers.alt ? '\x1b\x7f' : modifiers.ctrl ? '\x08' : '\x7f';
  if (key === 'delete') return terminalTildeKey(3, modifiers);
  if (key === 'up') return terminalCsiKey('A', modifiers);
  if (key === 'down') return terminalCsiKey('B', modifiers);
  if (key === 'right') return terminalCsiKey('C', modifiers);
  if (key === 'left') return terminalCsiKey('D', modifiers);
  if (key === 'home') return terminalHomeEndKey('H', modifiers);
  if (key === 'end') return terminalHomeEndKey('F', modifiers);
  if (key === 'pageUp') return terminalTildeKey(5, modifiers);
  return terminalTildeKey(6, modifiers);
}

function terminalModifierCode(modifiers: TerminalModifiers) {
  let code = 1;
  if (modifiers.shift) code += 1;
  if (modifiers.alt) code += 2;
  if (modifiers.ctrl) code += 4;
  return code === 1 ? undefined : code;
}

function terminalCsiKey(finalByte: string, modifiers: TerminalModifiers) {
  const modifierCode = terminalModifierCode(modifiers);
  return modifierCode ? `\x1b[1;${modifierCode}${finalByte}` : `\x1b[${finalByte}`;
}

function terminalHomeEndKey(finalByte: string, modifiers: TerminalModifiers) {
  const modifierCode = terminalModifierCode(modifiers);
  return modifierCode ? `\x1b[1;${modifierCode}${finalByte}` : `\x1b[${finalByte}`;
}

function terminalTildeKey(number: number, modifiers: TerminalModifiers) {
  const modifierCode = terminalModifierCode(modifiers);
  return modifierCode ? `\x1b[${number};${modifierCode}~` : `\x1b[${number}~`;
}

async function copyTerminalSelection(text: string) {
  if (await writeClipboardText(text)) return;
  copyTextWithHiddenTextarea(text);
}

type TerminalClipboardSelection = 'c' | 'p';

function terminalClipboardTextFromOsc52(data: string): { selection: TerminalClipboardSelection; text: string } | undefined {
  const separatorIndex = data.indexOf(';');
  if (separatorIndex < 0) return undefined;

  const selection = terminalClipboardSelection(data.slice(0, separatorIndex));
  const payload = data.slice(separatorIndex + 1);
  if (!selection || payload === '?') return undefined;

  const text = decodeTerminalClipboardBase64(payload);
  return text === undefined ? undefined : { selection, text };
}

function terminalClipboardSelection(value: string): TerminalClipboardSelection | undefined {
  if (value === '' || value === 'c') return 'c';
  return value === 'p' ? 'p' : undefined;
}

function decodeTerminalClipboardBase64(value: string) {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

async function writeTerminalClipboardText(selection: TerminalClipboardSelection, text: string) {
  if (selection === 'p') {
    terminalPrimaryClipboardText = text;
    return;
  }
  if (await writeClipboardText(text)) return;
  copyTextWithHiddenTextarea(text);
}

async function writeClipboardText(text: string) {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function copyTextWithHiddenTextarea(text: string) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
  } catch {
    // Clipboard access can be denied by the browser.
  } finally {
    textarea.remove();
  }
}

function terminalCwdFromOsc7(data: string) {
  if (!data.startsWith('file://')) return undefined;
  try {
    const url = new URL(data);
    if (url.protocol !== 'file:') return undefined;
    const pathname = decodeURIComponent(url.pathname);
    return /^\/[a-zA-Z]:\//.test(pathname) ? pathname.slice(1) : pathname;
  } catch {
    return undefined;
  }
}

function terminalCwdFromOsc633(data: string) {
  if (!data.startsWith('P;')) return undefined;
  const cwdProperty = data.slice(2).split(';').find((property) => property.startsWith('Cwd='));
  if (!cwdProperty) return undefined;
  const value = cwdProperty.slice(4);
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeTerminalMetadata(value: string) {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return normalized ? normalized.slice(0, MAX_TERMINAL_METADATA_LENGTH) : undefined;
}

function trimTerminalQueuedInput(value: string) {
  return value.length > MAX_TERMINAL_QUEUED_INPUT_LENGTH ? value.slice(0, MAX_TERMINAL_QUEUED_INPUT_LENGTH) : value;
}

function sendTerminalClientMessage(socket: WebSocket | undefined, message: Record<string, unknown>) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function loadTerminalRuntime() {
  terminalRuntimePromise ??= Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/xterm/css/xterm.css'),
  ])
    .then(([xterm, fitAddon]) => ({ Terminal: xterm.Terminal, FitAddon: fitAddon.FitAddon }))
    .catch((error) => {
      terminalRuntimePromise = undefined;
      throw error;
    });
  return terminalRuntimePromise;
}

function terminalTheme() {
  const rootStyle = getComputedStyle(document.documentElement);
  const oklch = (name: string, fallback: string, alpha?: string) => {
    const value = rootStyle.getPropertyValue(name).trim() || fallback;
    return `oklch(${value}${alpha ? ` / ${alpha}` : ''})`;
  };
  const cssColor = (name: string, fallback: string) => rootStyle.getPropertyValue(name).trim() || fallback;
  return {
    // Reverse-video cells use this as their foreground, so transparent black is not safe here.
    background: oklch('--background', '0.16 0 0'),
    foreground: oklch('--foreground', '0.92 0 0'),
    cursor: cssColor('--terminal-cursor-color', '#d4d4d4'),
    cursorAccent: cssColor('--terminal-cursor-accent-color', '#1f1f1f'),
    selectionBackground: oklch('--primary', '0.488 0.243 264.376', '0.25'),
  };
}
