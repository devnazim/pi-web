import assert from 'node:assert/strict';
import test from 'node:test';
import { activePathAfterRemoval, closestDraftTextSearchRange, fileAncestorDirectories, pathIsAtOrBelow, remapPathRoot, shouldRefreshFileSearchTarget } from './fileWorkspace';

test('fileAncestorDirectories includes the root and each containing directory', () => {
  assert.deepEqual(fileAncestorDirectories('src/components/App.tsx'), ['', 'src', 'src/components']);
  assert.deepEqual(fileAncestorDirectories('README.md'), ['']);
});

test('path prefix helpers respect path segment boundaries', () => {
  assert.equal(pathIsAtOrBelow('src/App.tsx', 'src'), true);
  assert.equal(pathIsAtOrBelow('source/App.tsx', 'src'), false);
  assert.equal(remapPathRoot('src/components/App.tsx', 'src', 'web'), 'web/components/App.tsx');
  assert.equal(remapPathRoot('source/App.tsx', 'src', 'web'), 'source/App.tsx');
});

test('activePathAfterRemoval prefers the next tab and otherwise the previous tab', () => {
  const paths = ['a.ts', 'b.ts', 'c.ts'];
  assert.equal(activePathAfterRemoval(paths, 'b.ts', (path) => path === 'b.ts'), 'c.ts');
  assert.equal(activePathAfterRemoval(paths, 'c.ts', (path) => path === 'c.ts'), 'b.ts');
  assert.equal(activePathAfterRemoval(paths, 'a.ts', (path) => path === 'a.ts'), 'b.ts');
  assert.equal(activePathAfterRemoval(paths, 'b.ts', (path) => path === 'a.ts'), 'b.ts');
  assert.equal(activePathAfterRemoval(['a.ts'], 'a.ts', () => true), undefined);
});

test('activePathAfterRemoval handles removing a directory worth of tabs', () => {
  const paths = ['src/a.ts', 'src/b.ts', 'README.md'];
  assert.equal(activePathAfterRemoval(paths, 'src/a.ts', (path) => pathIsAtOrBelow(path, 'src')), 'README.md');
});

test('search navigation refreshes clean or missing tabs but preserves dirty drafts', () => {
  assert.equal(shouldRefreshFileSearchTarget(undefined), true);
  assert.equal(shouldRefreshFileSearchTarget({ loaded: false }), true);
  assert.equal(shouldRefreshFileSearchTarget({ loaded: true, savedContent: 'same', draftContent: 'same' }), true);
  assert.equal(shouldRefreshFileSearchTarget({ loaded: true, savedContent: 'saved', draftContent: 'edited' }), false);
});

test('closestDraftTextSearchRange relocates an on-disk match in an edited draft', () => {
  const content = ['inserted', 'before NEEDLEized', 'other NEEDLE'].join('\n');
  assert.deepEqual(closestDraftTextSearchRange(content, 'needle', 1, 8, { caseSensitive: false, wholeWord: false }), { line: 2, startColumn: 8, endColumn: 14 });
  assert.deepEqual(closestDraftTextSearchRange(content, 'needle', 2, 8, { caseSensitive: false, wholeWord: true }), { line: 3, startColumn: 7, endColumn: 13 });
  assert.equal(closestDraftTextSearchRange(content, 'needle', 1, 1, { caseSensitive: true, wholeWord: false }), undefined);
  assert.equal(closestDraftTextSearchRange(content, 'missing', 1, 1, { caseSensitive: false, wholeWord: false }), undefined);

  const dense = 'x'.repeat(15_000);
  assert.deepEqual(closestDraftTextSearchRange(dense, 'x', 1, 9_001, { caseSensitive: true, wholeWord: false }), { line: 1, startColumn: 9_001, endColumn: 9_002 });
});
