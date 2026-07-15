import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDuplicateWorkspaceNotificationEvent, resetWorkspaceNotificationEventDeduplication } from './workspaceNotifications';

test('deduplicates repeated workspace notification events within the handoff window', () => {
  const recent = new Map<string, number>();
  const event = { type: 'agent:finish', sessionId: 'session-1' };

  assert.equal(isDuplicateWorkspaceNotificationEvent(recent, 'workspace-1', event, 1_000), false);
  assert.equal(isDuplicateWorkspaceNotificationEvent(recent, 'workspace-1', event, 1_100), true);
  assert.equal(isDuplicateWorkspaceNotificationEvent(recent, 'workspace-1', event, 7_000), false);
});

test('allows another completion after a new activity starts', () => {
  const recent = new Map<string, number>();
  const event = { type: 'agent:finish', sessionId: 'session-1' };

  assert.equal(isDuplicateWorkspaceNotificationEvent(recent, 'workspace-1', event, 1_000), false);
  resetWorkspaceNotificationEventDeduplication(recent, 'workspace-1', 'session-1');
  assert.equal(isDuplicateWorkspaceNotificationEvent(recent, 'workspace-1', event, 1_100), false);
});

test('uses operation ids to distinguish fast consecutive runs without observing their starts', () => {
  const recent = new Map<string, number>();

  assert.equal(isDuplicateWorkspaceNotificationEvent(recent, 'workspace-1', { type: 'agent:finish', sessionId: 'session-1', operationId: 'operation-1' }, 1_000), false);
  assert.equal(isDuplicateWorkspaceNotificationEvent(recent, 'workspace-1', { type: 'agent:finish', sessionId: 'session-1', operationId: 'operation-1' }, 1_100), true);
  assert.equal(isDuplicateWorkspaceNotificationEvent(recent, 'workspace-1', { type: 'agent:finish', sessionId: 'session-1', operationId: 'operation-2' }, 1_200), false);
});

test('does not merge notifications from different sessions or event payloads', () => {
  const recent = new Map<string, number>();

  assert.equal(isDuplicateWorkspaceNotificationEvent(recent, 'workspace-1', { type: 'agent:finish', sessionId: 'session-1' }, 1_000), false);
  assert.equal(isDuplicateWorkspaceNotificationEvent(recent, 'workspace-1', { type: 'agent:finish', sessionId: 'session-2' }, 1_100), false);
  assert.equal(isDuplicateWorkspaceNotificationEvent(recent, 'workspace-1', { type: 'agent:notice', sessionId: 'session-1', message: 'first' }, 1_200), false);
  assert.equal(isDuplicateWorkspaceNotificationEvent(recent, 'workspace-1', { type: 'agent:notice', sessionId: 'session-1', message: 'second' }, 1_300), false);
});

test('does not deduplicate identical non-terminal extension notices', () => {
  const recent = new Map<string, number>();
  const event = { type: 'agent:notice', sessionId: 'session-1', message: 'Still waiting' };

  assert.equal(isDuplicateWorkspaceNotificationEvent(recent, 'workspace-1', event, 1_000), false);
  assert.equal(isDuplicateWorkspaceNotificationEvent(recent, 'workspace-1', event, 1_100), false);
});
