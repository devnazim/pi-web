import { X } from 'lucide-solid';
import { createEffect, onCleanup, onMount } from 'solid-js';
import type { Terminal as XTermTerminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './terminal-font.css';

export type ExtensionCustomUiRequest = { id: string; sessionId?: string; generation: number };
export type ExtensionCustomUiEvent = {
  type: 'agent:ui-custom-ready' | 'agent:ui-custom-data';
  sessionId?: string;
  data: { id: string; epoch: number; seq?: number; ansi?: string };
};
export type ExtensionCustomUiSender = (message: Record<string, unknown>) => boolean;
export type ExtensionCustomUiSubscribe = (listener: (event: ExtensionCustomUiEvent) => void) => () => void;

type TerminalRuntime = { Terminal: typeof import('@xterm/xterm').Terminal; FitAddon: typeof import('@xterm/addon-fit').FitAddon };
type Disposable = { dispose(): void };

const FONT_FAMILY = '"Pi GeistMono Nerd Font Mono", "GeistMono Nerd Font Mono", "JetBrains Mono", "Noto Color Emoji", monospace';
const FONT_MEASURE_FAMILY = 'Pi GeistMono Nerd Font Mono';
const FONT_SIZE = 14;
const LINE_HEIGHT = 1.25;
let runtimePromise: Promise<TerminalRuntime> | undefined;

export default function ExtensionCustomUiTerminal(props: {
  request: ExtensionCustomUiRequest;
  sender?: ExtensionCustomUiSender;
  subscribe: ExtensionCustomUiSubscribe;
  themeMode: 'light' | 'dark';
}) {
  let host: HTMLDivElement | undefined;
  let terminal: XTermTerminal | undefined;
  let fit: import('@xterm/addon-fit').FitAddon | undefined;
  let epoch: number | undefined;
  let expectedSeq = 1;
  let inputDisposable: Disposable | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let resizeFrame: number | undefined;
  let disposed = false;

  const send = (message: Record<string, unknown>, requestId = props.request.id) => props.sender?.({ ...message, id: requestId }) ?? false;
  const attach = () => {
    epoch = undefined;
    expectedSeq = 1;
    if (!terminal || !props.sender) return;
    send({ type: 'agent:ui-custom-attach', cols: terminal.cols, rows: terminal.rows });
  };
  const resize = (forceRefresh = false) => {
    if (!terminal || !fit || !host?.isConnected) return;
    try {
      fit.fit();
      if (forceRefresh && terminal.rows > 0) {
        terminal.clearTextureAtlas();
        terminal.refresh(0, terminal.rows - 1);
      }
      if (epoch !== undefined) send({ type: 'agent:ui-custom-resize', epoch, cols: terminal.cols, rows: terminal.rows });
    } catch {
      // Layout can disappear while the surrounding custom UI is closing.
    }
  };
  const scheduleResize = () => {
    if (resizeFrame !== undefined) return;
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = undefined;
      resize();
    });
  };

  const unsubscribe = props.subscribe((event) => {
    if (event.data.id !== props.request.id || !terminal) return;
    if (event.type === 'agent:ui-custom-ready') {
      epoch = event.data.epoch;
      expectedSeq = 1;
      terminal.reset();
      terminal.focus();
      scheduleResize();
      return;
    }
    if (event.data.epoch !== epoch || typeof event.data.seq !== 'number' || typeof event.data.ansi !== 'string') return;
    if (event.data.seq !== expectedSeq) {
      epoch = undefined;
      attach();
      return;
    }
    expectedSeq += 1;
    const ackEpoch = epoch;
    const ackSeq = event.data.seq;
    const requestId = event.data.id;
    terminal.write(event.data.ansi, () => send({ type: 'agent:ui-custom-ack', epoch: ackEpoch, seq: ackSeq }, requestId));
  });

  createEffect(() => {
    props.themeMode;
    if (!terminal) return;
    terminal.options.theme = terminalTheme(props.themeMode);
    terminal.refresh(0, terminal.rows - 1);
  });

  createEffect(() => {
    props.sender;
    props.request.id;
    props.request.generation;
    attach();
  });

  onMount(() => {
    if (!host) return;
    host.textContent = 'Loading extension UI…';
    void loadRuntime().then(({ Terminal, FitAddon }) => {
      if (disposed || !host) return;
      host.replaceChildren();
      terminal = new Terminal({
        allowTransparency: true,
        cursorBlink: false,
        customGlyphs: true,
        fontFamily: FONT_FAMILY,
        fontSize: FONT_SIZE,
        fontWeight: 400,
        fontWeightBold: 600,
        letterSpacing: 0,
        lineHeight: LINE_HEIGHT,
        rescaleOverlappingGlyphs: true,
        scrollback: 1000,
        theme: terminalTheme(props.themeMode),
      });
      fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(host);
      inputDisposable = terminal.onData((data) => {
        if (epoch !== undefined) send({ type: 'agent:ui-custom-input', epoch, data });
      });
      resizeObserver = new ResizeObserver(scheduleResize);
      resizeObserver.observe(host);
      resize();
      attach();
      terminal.focus();
      const activeTerminal = terminal;
      void document.fonts.load(`${FONT_SIZE}px "${FONT_MEASURE_FAMILY}"`)
        .then(() => {
          if (disposed || terminal !== activeTerminal) return;
          resize(true);
        })
        .catch(() => undefined);
    }).catch((error) => {
      if (disposed || !host) return;
      send({ type: 'agent:ui-custom-abandon' });
      host.textContent = error instanceof Error ? error.message : 'Could not load extension UI';
    });
  });

  onCleanup(() => {
    disposed = true;
    unsubscribe();
    if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame);
    resizeObserver?.disconnect();
    inputDisposable?.dispose();
    terminal?.dispose();
    terminal = undefined;
  });

  return (
    <section class="extension-custom-ui" aria-label="Extension interface">
      <div class="extension-custom-ui-toolbar">
        <span>Extension interface</span>
        <button class="ghost" type="button" title="Cancel" aria-label="Cancel extension interface" onClick={() => {
          if (epoch === undefined) send({ type: 'agent:ui-custom-abandon' });
          else send({ type: 'agent:ui-custom-cancel', epoch });
          terminal?.focus();
        }}><X class="size-4" /></button>
      </div>
      <div ref={host} class="extension-custom-ui-terminal" />
    </section>
  );
}

function loadRuntime() {
  runtimePromise ??= Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
    .then(([{ Terminal }, { FitAddon }]) => ({ Terminal, FitAddon }))
    .catch((error) => {
      runtimePromise = undefined;
      throw error;
    });
  return runtimePromise;
}

function terminalTheme(mode: 'light' | 'dark') {
  return mode === 'dark'
    ? { background: '#141414', foreground: '#e7e5e4', cursor: '#facc15', selectionBackground: '#52525b80' }
    : { background: '#ffffff', foreground: '#1c1917', cursor: '#ca8a04', selectionBackground: '#a1a1aa66' };
}
