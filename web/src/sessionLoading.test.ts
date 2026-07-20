import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedRangeAroundIndex, branchForEntry } from './sessionLoading';

const entries = [
  { id: 'root', parentId: null },
  { id: 'left', parentId: 'root' },
  { id: 'right', parentId: 'root' },
  { id: 'leaf', parentId: 'left' },
];

test('reconstructs the selected session branch from flat entries', () => {
  assert.deepEqual(branchForEntry(entries, 'leaf').map(({ id }) => id), ['root', 'left', 'leaf']);
  assert.deepEqual(branchForEntry(entries, 'right').map(({ id }) => id), ['root', 'right']);
  assert.deepEqual(branchForEntry(entries, null), []);
});

test('stops safely when session ancestry is missing or cyclic', () => {
  assert.deepEqual(branchForEntry(entries, 'missing'), []);
  assert.deepEqual(branchForEntry([
    { id: 'first', parentId: 'second' },
    { id: 'second', parentId: 'first' },
  ], 'first').map(({ id }) => id), ['second', 'first']);
});

test('keeps search rendering bounded around early, middle, and late matches', () => {
  assert.deepEqual(boundedRangeAroundIndex(3_463, 0, 160), { start: 0, end: 160 });
  assert.deepEqual(boundedRangeAroundIndex(3_463, 1_700, 160), { start: 1_620, end: 1_780 });
  assert.deepEqual(boundedRangeAroundIndex(3_463, 3_462, 160), { start: 3_303, end: 3_463 });
});
