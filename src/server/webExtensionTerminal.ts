export type WebExtensionTerminalWriter = (data: string) => void;

export class WebExtensionTerminal {
  private inputHandler?: (data: string) => void;
  private resizeHandler?: () => void;
  private writer?: WebExtensionTerminalWriter;
  private started = false;
  private _columns = 80;
  private _rows = 24;

  get columns() {
    return this._columns;
  }

  get rows() {
    return this._rows;
  }

  get kittyProtocolActive() {
    return false;
  }

  start(onInput: (data: string) => void, onResize: () => void) {
    this.inputHandler = onInput;
    this.resizeHandler = onResize;
    this.started = true;
    this.write('\x1b[?2004h\x1b[>4;2m');
  }

  stop() {
    if (this.started) this.write('\x1b[?2004l\x1b[>4;0m');
    this.started = false;
    this.inputHandler = undefined;
    this.resizeHandler = undefined;
    this.writer = undefined;
  }

  async drainInput() {}

  write(data: string) {
    this.writer?.(data);
  }

  moveBy(lines: number) {
    if (lines > 0) this.write(`\x1b[${lines}B`);
    else if (lines < 0) this.write(`\x1b[${-lines}A`);
  }

  hideCursor() {
    this.write('\x1b[?25l');
  }

  showCursor() {
    this.write('\x1b[?25h');
  }

  clearLine() {
    this.write('\x1b[K');
  }

  clearFromCursor() {
    this.write('\x1b[J');
  }

  clearScreen() {
    this.write('\x1b[2J\x1b[H');
  }

  setTitle(title: string) {
    this.write(`\x1b]0;${title.replace(/[\x00-\x1f\x7f]/g, '')}\x07`);
  }

  setProgress(active: boolean) {
    this.write(active ? '\x1b]9;4;1;0\x07' : '\x1b]9;4;0\x07');
  }

  attach(writer: WebExtensionTerminalWriter) {
    this.writer = writer;
    if (this.started) this.write('\x1b[?2004h\x1b[>4;2m');
  }

  detach(writer?: WebExtensionTerminalWriter) {
    if (!writer || this.writer === writer) this.writer = undefined;
  }

  receiveInput(data: string) {
    this.inputHandler?.(data);
  }

  resize(columns: number, rows: number) {
    const nextColumns = Math.max(20, Math.min(500, Math.floor(columns)));
    const nextRows = Math.max(4, Math.min(200, Math.floor(rows)));
    if (nextColumns === this._columns && nextRows === this._rows) return;
    this._columns = nextColumns;
    this._rows = nextRows;
    this.resizeHandler?.();
  }
}
