import assert from 'node:assert/strict';
import test from 'node:test';
import { isTerminalApplePlatform, terminalCopyAction, terminalPasteAction, type TerminalShortcutEvent } from './terminalShortcuts';

function keyEvent(overrides: Partial<TerminalShortcutEvent> = {}): TerminalShortcutEvent {
  return {
    type: 'keydown',
    key: 'c',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

test('recognizes macOS and iOS as Apple shortcut platforms', () => {
  assert.equal(isTerminalApplePlatform('MacIntel'), true);
  assert.equal(isTerminalApplePlatform('iPhone'), true);
  assert.equal(isTerminalApplePlatform('iPad'), true);
  assert.equal(isTerminalApplePlatform('Linux x86_64'), false);
});

test('plain Ctrl+C copies and clears a non-mac terminal selection, then passes through without one', () => {
  const event = keyEvent({ ctrlKey: true });
  assert.equal(terminalCopyAction(event, true, false), 'copy-and-clear');
  assert.equal(terminalCopyAction(event, false, false), undefined);
});

test('Ctrl+Shift+C remains a non-mac copy shortcut independent of selection', () => {
  const event = keyEvent({ ctrlKey: true, shiftKey: true });
  assert.equal(terminalCopyAction(event, true, false), 'copy');
  assert.equal(terminalCopyAction(event, false, false), 'copy');
});

test('macOS uses Cmd+C for copy and keeps Ctrl+C as terminal input', () => {
  assert.equal(terminalCopyAction(keyEvent({ metaKey: true }), true, true), 'copy');
  assert.equal(terminalCopyAction(keyEvent({ metaKey: true }), false, true), 'copy');
  assert.equal(terminalCopyAction(keyEvent({ ctrlKey: true }), true, true), undefined);
  assert.equal(terminalCopyAction(keyEvent({ ctrlKey: true, metaKey: true }), true, true), undefined);
});

test('copy shortcuts ignore Alt-modified, keyup, and unrelated key events', () => {
  assert.equal(terminalCopyAction(keyEvent({ ctrlKey: true, altKey: true }), true, false), undefined);
  assert.equal(terminalCopyAction(keyEvent({ ctrlKey: true, type: 'keyup' }), true, false), undefined);
  assert.equal(terminalCopyAction(keyEvent({ ctrlKey: true, key: 'x' }), true, false), undefined);
});

test('plain Ctrl+V is a non-mac paste shortcut instead of terminal quoted insert', () => {
  assert.equal(terminalPasteAction(keyEvent({ key: 'v', ctrlKey: true }), false), true);
  assert.equal(terminalPasteAction(keyEvent({ key: 'v', ctrlKey: true, shiftKey: true }), false), false);
  assert.equal(terminalPasteAction(keyEvent({ key: 'v', ctrlKey: true, altKey: true }), false), false);
  assert.equal(terminalPasteAction(keyEvent({ key: 'v', ctrlKey: true, type: 'keyup' }), false), false);
});

test('macOS leaves Cmd+V to the browser and keeps Ctrl+V as terminal input', () => {
  assert.equal(terminalPasteAction(keyEvent({ key: 'v', metaKey: true }), true), false);
  assert.equal(terminalPasteAction(keyEvent({ key: 'v', ctrlKey: true }), true), false);
  assert.equal(terminalPasteAction(keyEvent({ key: 'v', ctrlKey: true, metaKey: true }), true), false);
});
