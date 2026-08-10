import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSessionShareUrl, decodeProjectPath, encodeProjectPath } from './sessionShare';

test('encodes and decodes project paths used by shared session URLs', () => {
  for (const projectPath of ['/srv/projects/café', '~/work/pi-web', 'C:\\Users\\dev\\pi-web']) {
    assert.equal(decodeProjectPath(encodeProjectPath(projectPath)), projectPath);
  }
  assert.equal(decodeProjectPath(encodeProjectPath('relative/path')), undefined);
  assert.equal(decodeProjectPath('not base64!'), undefined);
});

test('builds a same-server deep link for the selected project, workspace, and opaque pi session id', () => {
  const projectPath = '/srv/projects/pi-web';
  const workspacePath = '/home/dev/.pi-web/worktrees/pi-web/review';
  const sessionId = 'opaque/session+query?#%/雪';
  const shared = new URL(buildSessionShareUrl('https://host.example/pi-web/?theme=dark#transcript', {
    projectPath,
    workspacePath,
    sessionId,
  }));

  assert.equal(shared.origin, 'https://host.example');
  assert.equal(shared.pathname, '/pi-web/');
  assert.equal(shared.searchParams.get('theme'), 'dark');
  assert.equal(decodeProjectPath(shared.searchParams.get('project')!), projectPath);
  assert.equal(decodeProjectPath(shared.searchParams.get('workspace')!), workspacePath);
  assert.equal(shared.searchParams.get('session'), sessionId);
  assert.equal(shared.hash, '#transcript');
});

test('removes stale workspace and session parameters when the target does not include them', () => {
  const shared = new URL(buildSessionShareUrl('https://host.example/?project=old&workspace=old&session=old', {
    projectPath: '/srv/projects/pi-web',
  }));

  assert.equal(decodeProjectPath(shared.searchParams.get('project')!), '/srv/projects/pi-web');
  assert.equal(shared.searchParams.has('workspace'), false);
  assert.equal(shared.searchParams.has('session'), false);
});

test('preserves the current project parameter until the active project resolves', () => {
  const project = encodeProjectPath('/srv/projects/existing');
  const shared = new URL(buildSessionShareUrl(`https://host.example/?project=${project}&workspace=old&session=old`, {
    workspacePath: '/srv/projects/unresolved-workspace',
  }));

  assert.equal(shared.searchParams.get('project'), project);
  assert.equal(shared.searchParams.has('workspace'), false);
  assert.equal(shared.searchParams.has('session'), false);
});
