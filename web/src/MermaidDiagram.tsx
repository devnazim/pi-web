import { Check, CodeXml, Copy, LoaderCircle, Maximize2, X, ZoomIn, ZoomOut } from 'lucide-solid';
import { Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import { writeClipboardText } from './clipboard';
import { renderMermaidSvg, type MermaidThemeMode } from './mermaidRenderer';

type MermaidDiagramProps = {
  code: string;
};

type MermaidSize = {
  width: number;
  height: number;
};

const MERMAID_VIEWER_MIN_ZOOM = 0.02;
const MERMAID_VIEWER_MAX_ZOOM = 4;

let mermaidViewerId = 0;

export default function MermaidDiagram(props: MermaidDiagramProps) {
  const [themeMode, setThemeMode] = createSignal<MermaidThemeMode>(documentThemeMode());
  const [svg, setSvg] = createSignal('');
  const [error, setError] = createSignal('');
  const [showSource, setShowSource] = createSignal(false);
  const [viewerOpen, setViewerOpen] = createSignal(false);
  const [inlineDiagramHeight, setInlineDiagramHeight] = createSignal(160);
  const [copied, setCopied] = createSignal(false);
  let inlineBodyRef: HTMLDivElement | undefined;
  let renderSequence = 0;
  let copyResetTimer: number | undefined;

  onMount(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setThemeMode(documentThemeMode()));
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    const code = props.code;
    const theme = themeMode();
    const sequence = ++renderSequence;
    setError('');

    void renderMermaidSvg(code, theme)
      .then((renderedSvg) => {
        if (sequence === renderSequence) setSvg(renderedSvg);
      })
      .catch((cause) => {
        if (sequence === renderSequence) setError(mermaidErrorSummary(cause));
      });
  });

  onCleanup(() => {
    renderSequence++;
    if (copyResetTimer !== undefined) window.clearTimeout(copyResetTimer);
  });

  function openViewer() {
    if (inlineBodyRef) setInlineDiagramHeight(inlineBodyRef.offsetHeight);
    setViewerOpen(true);
  }

  async function copySource() {
    try {
      await writeClipboardText(props.code);
      setCopied(true);
      if (copyResetTimer !== undefined) window.clearTimeout(copyResetTimer);
      copyResetTimer = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      <div class="markdown-code-frame markdown-mermaid-frame">
        <div class="markdown-code-header">
          <span class="markdown-code-lang">Mermaid diagram</span>
          <div class="markdown-code-actions">
            <Show when={svg()}>
              <button type="button" class="markdown-code-copy" onClick={openViewer} aria-label="Open diagram viewer">
                <Maximize2 class="size-3.5" />
                <span>View</span>
              </button>
            </Show>
            <Show when={!error()}>
              <button type="button" class="markdown-code-copy" onClick={() => setShowSource((visible) => !visible)} aria-pressed={showSource()} aria-label={showSource() ? 'Show rendered diagram' : 'Show Mermaid source'}>
                <CodeXml class="size-3.5" />
                <span>{showSource() ? 'Diagram' : 'Source'}</span>
              </button>
            </Show>
            <button type="button" class="markdown-code-copy" onClick={() => void copySource()} aria-label="Copy Mermaid source">
              <Show when={copied()} fallback={<Copy class="size-3.5" />}><Check class="size-3.5" /></Show>
              <span>{copied() ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        </div>

        <div ref={inlineBodyRef}>
          <Show when={!viewerOpen()} fallback={<div class="markdown-mermaid-placeholder" style={{ height: `${inlineDiagramHeight()}px` }} aria-hidden="true" />}>
            <Show
              when={error()}
              fallback={
                <Show
                  when={showSource()}
                  fallback={
                    <Show when={svg()} fallback={<div class="markdown-mermaid-status" role="status"><LoaderCircle class="size-4 animate-spin" /><span>Rendering diagram…</span></div>}>
                      {(renderedSvg) => <div class="markdown-mermaid-svg" innerHTML={renderedSvg()} />}
                    </Show>
                  }
                >
                  <MermaidSource code={props.code} />
                </Show>
              }
            >
              {(message) => (
                <>
                  <div class="markdown-mermaid-error" role="alert"><strong>Diagram could not be rendered.</strong><span>{message()}</span></div>
                  <MermaidSource code={props.code} />
                </>
              )}
            </Show>
          </Show>
        </div>
      </div>

      <Show when={viewerOpen()}>
        <MermaidViewer
          code={props.code}
          svg={svg()}
          error={error()}
          copied={copied()}
          onCopy={() => void copySource()}
          onClose={() => setViewerOpen(false)}
        />
      </Show>
    </>
  );
}

function MermaidViewer(props: { code: string; svg: string; error: string; copied: boolean; onCopy: () => void; onClose: () => void }) {
  const titleId = `pi-mermaid-viewer-title-${++mermaidViewerId}`;
  const [showSource, setShowSource] = createSignal(false);
  const [zoom, setZoom] = createSignal(1);
  const [diagramSize, setDiagramSize] = createSignal<MermaidSize>({ width: 1, height: 1 });
  const [dragging, setDragging] = createSignal(false);
  let dialogRef: HTMLDivElement | undefined;
  let viewportRef: HTMLDivElement | undefined;
  let diagramRef: HTMLDivElement | undefined;
  let zoomFrame: number | undefined;
  let storedScroll = { left: 0, top: 0 };
  let pan: { pointerId: number; clientX: number; clientY: number; scrollLeft: number; scrollTop: number } | undefined;

  onMount(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef?.focus();
    onCleanup(() => {
      document.body.style.overflow = previousBodyOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    });
  });

  onCleanup(() => {
    if (zoomFrame !== undefined) window.cancelAnimationFrame(zoomFrame);
  });

  createEffect(() => {
    props.svg;
    if (diagramRef) measureDiagram(diagramRef);
  });

  function measureDiagram(element: HTMLDivElement) {
    diagramRef = element;
    queueMicrotask(() => {
      if (diagramRef !== element) return;
      const renderedSvg = element.querySelector('svg');
      const viewBox = renderedSvg?.viewBox.baseVal;
      const width = viewBox?.width || renderedSvg?.width.baseVal.value || 1;
      const height = viewBox?.height || renderedSvg?.height.baseVal.value || 1;
      setDiagramSize({ width: Math.max(1, width), height: Math.max(1, height) });
    });
  }

  function scheduleScroll(left: number, top: number) {
    if (zoomFrame !== undefined) window.cancelAnimationFrame(zoomFrame);
    zoomFrame = window.requestAnimationFrame(() => {
      zoomFrame = undefined;
      if (!viewportRef) return;
      viewportRef.scrollLeft = Math.max(0, left);
      viewportRef.scrollTop = Math.max(0, top);
    });
  }

  function changeZoom(nextZoom: number, clientX?: number, clientY?: number) {
    const viewport = viewportRef;
    const diagram = diagramRef;
    const currentZoom = zoom();
    const next = clampZoom(nextZoom);
    if (!viewport || !diagram || next === currentZoom) {
      setZoom(next);
      return;
    }

    const viewportBounds = viewport.getBoundingClientRect();
    const diagramBounds = diagram.getBoundingClientRect();
    const focalX = clientX ?? viewportBounds.left + viewport.clientWidth / 2;
    const focalY = clientY ?? viewportBounds.top + viewport.clientHeight / 2;
    const diagramX = (focalX - diagramBounds.left) / currentZoom;
    const diagramY = (focalY - diagramBounds.top) / currentZoom;
    setZoom(next);

    if (zoomFrame !== undefined) window.cancelAnimationFrame(zoomFrame);
    zoomFrame = window.requestAnimationFrame(() => {
      zoomFrame = undefined;
      if (!viewportRef || diagramRef !== diagram) return;
      const nextBounds = diagram.getBoundingClientRect();
      viewportRef.scrollLeft += nextBounds.left + diagramX * next - focalX;
      viewportRef.scrollTop += nextBounds.top + diagramY * next - focalY;
    });
  }

  function fitDiagram() {
    const viewport = viewportRef;
    const canvas = diagramRef?.parentElement;
    const size = diagramSize();
    if (!viewport || !canvas || !size.width || !size.height) return;
    const canvasStyle = window.getComputedStyle(canvas);
    const horizontalPadding = Number.parseFloat(canvasStyle.paddingLeft) + Number.parseFloat(canvasStyle.paddingRight);
    const verticalPadding = Number.parseFloat(canvasStyle.paddingTop) + Number.parseFloat(canvasStyle.paddingBottom);
    const availableWidth = Math.max(1, viewport.clientWidth - horizontalPadding);
    const availableHeight = Math.max(1, viewport.clientHeight - verticalPadding);
    setZoom(clampZoom(Math.min(availableWidth / size.width, availableHeight / size.height)));
    scheduleScroll(0, 0);
  }

  function toggleSource() {
    const sourceVisible = showSource();
    if (!sourceVisible && viewportRef) storedScroll = { left: viewportRef.scrollLeft, top: viewportRef.scrollTop };
    setShowSource(!sourceVisible);
    if (sourceVisible) scheduleScroll(storedScroll.left, storedScroll.top);
  }

  function handleWheel(event: WheelEvent) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    changeZoom(zoom() * (event.deltaY < 0 ? 1.15 : 1 / 1.15), event.clientX, event.clientY);
  }

  function handlePointerDown(event: PointerEvent) {
    if (event.button !== 0 || !viewportRef) return;
    const bounds = viewportRef.getBoundingClientRect();
    if (event.clientX - bounds.left >= viewportRef.clientWidth || event.clientY - bounds.top >= viewportRef.clientHeight) return;
    event.preventDefault();
    viewportRef.focus();
    pan = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: viewportRef.scrollLeft,
      scrollTop: viewportRef.scrollTop,
    };
    viewportRef.setPointerCapture(event.pointerId);
    setDragging(true);
  }

  function handlePointerMove(event: PointerEvent) {
    if (!pan || pan.pointerId !== event.pointerId || !viewportRef) return;
    viewportRef.scrollLeft = pan.scrollLeft - (event.clientX - pan.clientX);
    viewportRef.scrollTop = pan.scrollTop - (event.clientY - pan.clientY);
  }

  function stopPanning(event: PointerEvent) {
    if (!pan || pan.pointerId !== event.pointerId) return;
    pan = undefined;
    setDragging(false);
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (event.key === 'Tab') {
      trapDialogFocus(event, dialogRef);
      return;
    }
    if (showSource() || event.altKey) return;
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      changeZoom(zoom() * 1.25);
    } else if (event.key === '-') {
      event.preventDefault();
      changeZoom(zoom() / 1.25);
    } else if (event.key === '0') {
      event.preventDefault();
      changeZoom(1);
    }
  }

  const scaledWidth = () => Math.max(1, diagramSize().width * zoom());
  const scaledHeight = () => Math.max(1, diagramSize().height * zoom());

  return (
    <Portal>
      <div class="asset-preview-backdrop mermaid-viewer-backdrop" onMouseDown={props.onClose}>
        <div
          ref={dialogRef}
          class="mermaid-viewer-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          onKeyDown={handleKeyDown}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div class="mermaid-viewer-header">
            <div class="min-w-0 flex-1">
              <div class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Diagram viewer</div>
              <h2 id={titleId} class="truncate text-sm font-medium">Mermaid diagram</h2>
            </div>
            <div class="mermaid-viewer-header-actions">
              <Show when={!props.error}>
                <button type="button" class="markdown-code-copy" onClick={toggleSource} aria-pressed={showSource()} aria-label={showSource() ? 'Show diagram in viewer' : 'Show Mermaid source in viewer'}>
                  <CodeXml class="size-3.5" />
                  <span>{showSource() ? 'Diagram' : 'Source'}</span>
                </button>
              </Show>
              <button type="button" class="markdown-code-copy" onClick={props.onCopy} aria-label="Copy Mermaid source">
                <Show when={props.copied} fallback={<Copy class="size-3.5" />}><Check class="size-3.5" /></Show>
                <span>{props.copied ? 'Copied' : 'Copy'}</span>
              </button>
              <button type="button" class="project-modal-close shrink-0" aria-label="Close diagram viewer" onClick={props.onClose}><X class="size-4" /></button>
            </div>
          </div>

          <div class="mermaid-viewer-body">
            <Show when={props.error} fallback={
              <Show when={showSource()} fallback={
                <Show when={props.svg} fallback={<div class="markdown-mermaid-status h-full" role="status"><LoaderCircle class="size-4 animate-spin" /><span>Rendering diagram…</span></div>}>
                  {(renderedSvg) => (
                    <div
                      ref={viewportRef}
                      class="mermaid-viewer-viewport"
                      classList={{ 'mermaid-viewer-viewport-dragging': dragging() }}
                      tabIndex={0}
                      aria-label="Zoomable Mermaid diagram"
                      onWheel={handleWheel}
                      onPointerDown={handlePointerDown}
                      onPointerMove={handlePointerMove}
                      onPointerUp={stopPanning}
                      onPointerCancel={stopPanning}
                      onLostPointerCapture={stopPanning}
                    >
                      <div class="mermaid-viewer-canvas">
                        <div
                          ref={measureDiagram}
                          class="mermaid-viewer-svg"
                          style={{ width: `${scaledWidth()}px`, height: `${scaledHeight()}px` }}
                          innerHTML={renderedSvg()}
                        />
                      </div>
                    </div>
                  )}
                </Show>
              }>
                <MermaidSource code={props.code} class="mermaid-viewer-source" tabIndex={0} ariaLabel="Mermaid diagram source" />
              </Show>
            }>
              {(message) => (
                <div class="mermaid-viewer-error">
                  <div class="markdown-mermaid-error" role="alert"><strong>Diagram could not be rendered.</strong><span>{message()}</span></div>
                  <MermaidSource code={props.code} class="mermaid-viewer-source" tabIndex={0} ariaLabel="Mermaid diagram source" />
                </div>
              )}
            </Show>
          </div>

          <div class="mermaid-viewer-footer">
            <Show when={!showSource() && !props.error && props.svg}>
              <span class="mermaid-viewer-hint">Drag to pan · Ctrl/⌘ + wheel to zoom</span>
              <div class="mermaid-viewer-zoom-controls" aria-label="Diagram zoom controls">
                <button type="button" class="mermaid-viewer-zoom-button" aria-label="Zoom out" onClick={() => changeZoom(zoom() / 1.25)}><ZoomOut class="size-4" /></button>
                <button type="button" class="mermaid-viewer-zoom-value" title="Reset to 100%" onClick={() => changeZoom(1)}>{Math.round(zoom() * 100)}%</button>
                <button type="button" class="mermaid-viewer-zoom-button" aria-label="Zoom in" onClick={() => changeZoom(zoom() * 1.25)}><ZoomIn class="size-4" /></button>
                <button type="button" class="mermaid-viewer-fit-button" onClick={fitDiagram}>Fit</button>
                <button type="button" class="mermaid-viewer-fit-button" onClick={() => changeZoom(1)}>100%</button>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  );
}

function MermaidSource(props: { code: string; class?: string; tabIndex?: number; ariaLabel?: string }) {
  return <pre class={`markdown-code-block markdown-mermaid-source ${props.class ?? ''}`} tabIndex={props.tabIndex} aria-label={props.ariaLabel}><code>{props.code}</code></pre>;
}

function trapDialogFocus(event: KeyboardEvent, dialog: HTMLElement | undefined) {
  if (!dialog) return;
  const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
  if (!focusable.length) {
    event.preventDefault();
    dialog.focus();
    return;
  }

  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  if (document.activeElement === dialog || !dialog.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function clampZoom(zoom: number) {
  return Math.min(MERMAID_VIEWER_MAX_ZOOM, Math.max(MERMAID_VIEWER_MIN_ZOOM, Math.round(zoom * 1000) / 1000));
}

function documentThemeMode(): MermaidThemeMode {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.dataset.theme === 'dark' || document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function mermaidErrorSummary(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause || 'Unknown Mermaid error');
  const firstLine = message.split(/\r?\n/).find((line) => line.trim())?.trim() || 'Unknown Mermaid error';
  return firstLine.length > 240 ? `${firstLine.slice(0, 237)}…` : firstLine;
}
