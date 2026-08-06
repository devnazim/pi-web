import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workspaceDeleteIdentityChanged, workspaceDeleteRequiresManualRecovery } from './workspaceDeletion';

test('workspace identity changes require closing and refreshing the deletion dialog', () => {
  const errors = [
    'The Git worktree identity changed while deletion was preparing. Nothing was deleted; refresh the workspace list and retry.',
    'The stale Git worktree identity changed while deletion was preparing. Nothing was deleted.',
    'The Git worktree identity changed during deletion isolation. Nothing was deleted; workspace files were preserved for recovery.',
  ];
  for (const error of errors) {
    assert.equal(workspaceDeleteIdentityChanged(error), true);
    assert.equal(workspaceDeleteRequiresManualRecovery(error), true);
  }
});

test('workspace deletion keeps ordinary local-file conflicts retryable through explicit force', () => {
  assert.equal(workspaceDeleteRequiresManualRecovery('Workspace contains uncommitted changes, untracked files, or ignored local files.'), false);
  assert.equal(workspaceDeleteIdentityChanged('Workspace contains uncommitted changes.'), false);
});
