const TERMINAL_MIN_VISIBLE_ROWS = 9;

type TerminalLayoutMetrics = {
  panelHeight: number;
  hostHeight: number;
  xtermPaddingTop: number;
  xtermPaddingBottom: number;
  screenHeight: number;
  renderedRows: number;
};

export function terminalPanelMinimumHeight(metrics: TerminalLayoutMetrics) {
  const cellHeight = metrics.screenHeight / metrics.renderedRows;
  return Math.ceil(
    metrics.panelHeight
      - metrics.hostHeight
      + metrics.xtermPaddingTop
      + metrics.xtermPaddingBottom
      + cellHeight * TERMINAL_MIN_VISIBLE_ROWS,
  );
}
