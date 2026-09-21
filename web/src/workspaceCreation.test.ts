import assert from 'node:assert/strict';
import { test } from 'node:test';
import { suggestWorkspaceBranch, workspaceCreationInput } from './workspaceCreation';

test('workspace branch suggestions are readable and omit unsupported punctuation', () => {
  assert.equal(suggestWorkspaceBranch(' Authentication flow! '), 'feat/authentication-flow');
  assert.equal(suggestWorkspaceBranch(''), '');
  assert.equal(suggestWorkspaceBranch('...'), '');
  assert.ok(suggestWorkspaceBranch('a'.repeat(200)).length <= 85);
});

test('new workspace payload preserves an explicit branch and selected starting point', () => {
  assert.deepEqual(workspaceCreationInput({ name: ' Authentication ', branch: 'feature/AUTH-123', startPoint: 'origin/main', mode: 'new' }), {
    name: 'Authentication', branch: 'feature/AUTH-123', startPoint: 'origin/main', mode: 'new',
  });
});

test('existing workspace payload never includes a starting point', () => {
  assert.deepEqual(workspaceCreationInput({ name: '', branch: 'main', startPoint: 'another-branch', mode: 'existing' }), {
    name: undefined, branch: 'main', mode: 'existing',
  });
  assert.deepEqual(workspaceCreationInput({ name: 'Bug fix', branch: 'fix/bug', startPoint: '', mode: 'existing' }), {
    name: 'Bug fix', branch: 'fix/bug', mode: 'existing',
  });
});

test('new workspace form requires a name, branch, and starting point', () => {
  const valid = { name: 'Auth', branch: 'feat/auth', startPoint: 'main', mode: 'new' as const };
  assert.throws(() => workspaceCreationInput({ ...valid, name: ' ' }), /workspace name/);
  assert.throws(() => workspaceCreationInput({ ...valid, branch: '' }), /branch/);
  assert.throws(() => workspaceCreationInput({ ...valid, startPoint: '' }), /starting point/);
});
