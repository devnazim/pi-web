import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasPersistedUserMessage, markSessionActivityStarted, pendingUserMessagesAfterTerminalRefresh, shouldRefreshCompletedSession, unresolvedPendingUserMessages } from './chatHandoff';

test('keeps the optimistic prompt when a different branch gains a user message', () => {
  assert.equal(hasPersistedUserMessage([
    { id: 'existing', text: 'Earlier prompt' },
    { id: 'other-branch', text: 'Unrelated newer prompt' },
  ], ['existing'], 'Submitted prompt'), false);
});

test('recognizes the submitted prompt only in a new persisted user entry', () => {
  assert.equal(hasPersistedUserMessage([
    { id: 'existing', text: 'Submitted prompt' },
  ], ['existing'], 'Submitted prompt'), false);

  assert.equal(hasPersistedUserMessage([
    { id: 'existing', text: 'Earlier prompt' },
    { id: 'submitted', text: 'Submitted\n\nprompt' },
  ], ['existing'], 'Submitted prompt'), true);
});

test('accepts a transformed prompt only after the server accepts the submission', () => {
  const messages = [
    { id: 'existing', text: 'Earlier prompt' },
    { id: 'transformed', text: 'Expanded prompt template content' },
  ];

  assert.equal(hasPersistedUserMessage(messages, ['existing'], '/template args'), false);
  assert.equal(hasPersistedUserMessage(messages, ['existing'], '/template args', true), true);
  assert.equal(hasPersistedUserMessage(messages, ['existing', 'transformed'], '/template args', true), false);
});

test('reconciles overlapping prompts against distinct persisted entries in order', () => {
  const pending = [
    { id: 1, previousUserEntryIds: ['existing'], text: 'First prompt', accepted: true },
    { id: 2, previousUserEntryIds: ['existing'], text: '/template second', accepted: true },
  ];

  assert.deepEqual(unresolvedPendingUserMessages([
    { id: 'existing', text: 'Earlier prompt' },
  ], pending).map(({ id }) => id), [1, 2]);

  assert.deepEqual(unresolvedPendingUserMessages([
    { id: 'existing', text: 'Earlier prompt' },
    { id: 'first', text: 'First prompt' },
  ], pending).map(({ id }) => id), [2]);

  assert.deepEqual(unresolvedPendingUserMessages([
    { id: 'existing', text: 'Earlier prompt' },
    { id: 'first', text: 'First prompt' },
    { id: 'second', text: 'Expanded second template' },
  ], pending).map(({ id }) => id), []);
});

test('does not reconcile later prompts before an earlier transformed prompt is accepted', () => {
  const pending = [
    { id: 1, previousUserEntryIds: ['existing'], text: '/template first', accepted: false },
    { id: 2, previousUserEntryIds: ['existing'], text: '/template second', accepted: true },
  ];
  const firstOnly = [
    { id: 'existing', text: 'Earlier prompt' },
    { id: 'first', text: 'Expanded first template' },
  ];

  assert.deepEqual(unresolvedPendingUserMessages(firstOnly, pending).map(({ id }) => id), [1, 2]);
  assert.deepEqual(unresolvedPendingUserMessages(firstOnly, [
    { ...pending[0], accepted: true },
    pending[1],
  ]).map(({ id }) => id), [2]);
});

test('drops an accepted steering prompt discarded before the terminal refresh', () => {
  const pending = [
    { id: 1, previousUserEntryIds: ['existing'], text: 'First prompt', accepted: true },
    { id: 2, previousUserEntryIds: ['existing'], text: 'Canceled steering prompt', accepted: true },
  ];

  assert.deepEqual(pendingUserMessagesAfterTerminalRefresh([
    { id: 'existing', text: 'Earlier prompt' },
    { id: 'first', text: 'First prompt' },
  ], pending), []);
});

test('keeps an in-flight unaccepted prompt after an unrelated terminal refresh', () => {
  const pending = [
    { id: 1, previousUserEntryIds: ['existing'], text: 'Still submitting', accepted: false },
  ];

  assert.deepEqual(pendingUserMessagesAfterTerminalRefresh([
    { id: 'existing', text: 'Earlier prompt' },
  ], pending).map(({ id }) => id), [1]);
});

test('recognizes persisted attachment suffixes added by Pi', () => {
  assert.equal(hasPersistedUserMessage([
    { id: 'file-prompt', text: 'Review this\n\nAttached files in the workspace:\n- src/main.ts' },
  ], [], 'Review this'), true);

  assert.equal(hasPersistedUserMessage([
    { id: 'image-prompt', text: 'Describe this [image]' },
  ], [], 'Describe this'), true);
});

test('coalesces both sockets by operation without suppressing a later run', () => {
  const completed = new Set<string>();

  assert.equal(shouldRefreshCompletedSession(completed, 'workspace-1', 'session-1', 'operation-1'), true);
  assert.equal(shouldRefreshCompletedSession(completed, 'workspace-1', 'session-1', 'operation-1'), false);

  markSessionActivityStarted(completed, 'workspace-1', 'session-1');
  assert.equal(shouldRefreshCompletedSession(completed, 'workspace-1', 'session-1', 'operation-1'), false);
  assert.equal(shouldRefreshCompletedSession(completed, 'workspace-1', 'session-1', 'operation-2'), true);
});

test('resets legacy completion coalescing when a new run starts', () => {
  const completed = new Set<string>();

  assert.equal(shouldRefreshCompletedSession(completed, 'workspace-1', 'session-1'), true);
  assert.equal(shouldRefreshCompletedSession(completed, 'workspace-1', 'session-1'), false);
  markSessionActivityStarted(completed, 'workspace-1', 'session-1');
  assert.equal(shouldRefreshCompletedSession(completed, 'workspace-1', 'session-1'), true);
});
