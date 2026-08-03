import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReviewFileTree } from './reviewFileTree';

test('buildReviewFileTree groups changed files into sorted directories', () => {
  const files = [
    { path: 'web/src/main.tsx', status: 'M' },
    { path: 'README.md', status: 'M' },
    { path: 'src/server/files.ts', status: 'M' },
    { path: 'web/package.json', status: 'M' },
  ];

  assert.deepEqual(buildReviewFileTree(files), [
    {
      type: 'directory',
      name: 'src',
      path: 'src',
      children: [{
        type: 'directory',
        name: 'server',
        path: 'src/server',
        children: [{ type: 'file', name: 'files.ts', path: 'src/server/files.ts', file: files[2] }],
      }],
    },
    {
      type: 'directory',
      name: 'web',
      path: 'web',
      children: [
        {
          type: 'directory',
          name: 'src',
          path: 'web/src',
          children: [{ type: 'file', name: 'main.tsx', path: 'web/src/main.tsx', file: files[0] }],
        },
        { type: 'file', name: 'package.json', path: 'web/package.json', file: files[3] },
      ],
    },
    { type: 'file', name: 'README.md', path: 'README.md', file: files[1] },
  ]);
});

test('buildReviewFileTree keeps a renamed file at its current path', () => {
  const file = { path: 'src/new-name.ts', oldPath: 'src/old-name.ts' };
  assert.deepEqual(buildReviewFileTree([file]), [{
    type: 'directory',
    name: 'src',
    path: 'src',
    children: [{ type: 'file', name: 'new-name.ts', path: 'src/new-name.ts', file }],
  }]);
});
