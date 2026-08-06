import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queryKeyTargetsWorkspace, reconcileWorkspaceSockets, WorkspaceSocketRegistry, withSuspendedWorkspaceSockets } from './workspaceSockets';

test('workspace deletion waits for every target socket to close before starting', async () => {
  const registry = new WorkspaceSocketRegistry();
  const events: string[] = [];
  let finishAgent: () => void = () => undefined;
  let finishFiles: () => void = () => undefined;
  const agentGate = new Promise<void>((resolve) => { finishAgent = resolve; });
  const filesGate = new Promise<void>((resolve) => { finishFiles = resolve; });
  registry.track('workspace-a', async () => { events.push('close-agent'); await agentGate; });
  registry.track('workspace-a-sibling', async () => { events.push('close-files'); await filesGate; });
  registry.track('workspace-b', async () => { events.push('close-other'); });

  const deletion = withSuspendedWorkspaceSockets(
    ['workspace-a', 'workspace-a-sibling'],
    (workspaceId, suspended) => events.push(`${suspended ? 'suspend' : 'resume'}-${workspaceId}`),
    (workspaceId) => registry.close(workspaceId),
    async () => { events.push('delete'); },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ['suspend-workspace-a', 'suspend-workspace-a-sibling', 'close-agent', 'close-files']);

  finishAgent();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(events.includes('delete'), false);
  finishFiles();
  await deletion;
  assert.deepEqual(events, [
    'suspend-workspace-a',
    'suspend-workspace-a-sibling',
    'close-agent',
    'close-files',
    'delete',
    'resume-workspace-a',
    'resume-workspace-a-sibling',
  ]);
});

test('notification socket reconciliation disconnects only changed workspace IDs', async () => {
  const cleanups = new Map<string, () => Promise<void>>();
  const events: string[] = [];
  const connect = (workspaceId: string) => {
    events.push(`connect-${workspaceId}`);
    return async () => { events.push(`close-${workspaceId}`); };
  };

  reconcileWorkspaceSockets(cleanups, ['workspace-a', 'workspace-b'], connect);
  const workspaceBCleanup = cleanups.get('workspace-b');
  reconcileWorkspaceSockets(cleanups, ['workspace-b'], connect);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cleanups.get('workspace-b'), workspaceBCleanup);
  assert.deepEqual(events, ['connect-workspace-a', 'connect-workspace-b', 'close-workspace-a']);

  reconcileWorkspaceSockets(cleanups, ['workspace-a', 'workspace-b'], connect);
  assert.equal(cleanups.get('workspace-b'), workspaceBCleanup);
  assert.deepEqual(events, ['connect-workspace-a', 'connect-workspace-b', 'close-workspace-a', 'connect-workspace-a']);
});

test('workspace query cleanup matches affected IDs across every query family', () => {
  const affected = new Set(['workspace-a', 'workspace-b']);
  for (const queryKey of [
    ['sessions', 'workspace-a'],
    ['agent-status', 'workspace-b', 'session'],
    ['file-preview', 'workspace-a', 'README.md'],
    ['commands', 'workspace-b'],
    ['review-threads', 'workspace-a'],
  ]) assert.equal(queryKeyTargetsWorkspace(queryKey, affected), true);
  assert.equal(queryKeyTargetsWorkspace(['sessions', 'workspace-c'], affected), false);
  assert.equal(queryKeyTargetsWorkspace(['workspaces', 'root-project'], affected), false);
});

test('failed workspace deletion resumes its socket connections', async () => {
  const events: string[] = [];
  await assert.rejects(
    withSuspendedWorkspaceSockets(
      ['workspace-a'],
      (_workspaceId, suspended) => events.push(suspended ? 'suspend' : 'resume'),
      async () => { events.push('close'); },
      async () => { events.push('delete'); throw new Error('delete failed'); },
    ),
    /delete failed/,
  );
  assert.deepEqual(events, ['suspend', 'close', 'delete', 'resume']);
});
