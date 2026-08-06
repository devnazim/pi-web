export type TerminalShortcutEvent = Pick<KeyboardEvent, 'type' | 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>;
export type TerminalCopyAction = 'copy' | 'copy-and-clear';

export function terminalCopyAction(event: TerminalShortcutEvent, hasSelection: boolean, isMac: boolean): TerminalCopyAction | undefined {
  if (event.type !== 'keydown' || event.altKey || event.key.toLowerCase() !== 'c') return undefined;
  if (isMac) return event.metaKey && !event.ctrlKey ? 'copy' : undefined;
  if (event.ctrlKey && event.shiftKey) return 'copy';
  return event.ctrlKey && hasSelection ? 'copy-and-clear' : undefined;
}
