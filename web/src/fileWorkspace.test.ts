import assert from 'node:assert/strict';
import test from 'node:test';
import { activePathAfterRemoval, fileAncestorDirectories, pathIsAtOrBelow, remapPathRoot } from './fileWorkspace';

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
