import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedRangeAroundIndex, branchForEntry, isInternalSessionEntry } from './sessionLoading';

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

test('recognizes pi internal entries without hiding ordinary conversation metadata', () => {
  assert.equal(isInternalSessionEntry({ type: 'message', message: { role: 'system' } }), true);
  assert.equal(isInternalSessionEntry({ type: 'usage' }), true);
  assert.equal(isInternalSessionEntry({ type: 'context_edit' }), true);
  for (const role of ['user', 'assistant', 'toolResult', 'bashExecution']) {
    assert.equal(isInternalSessionEntry({ type: 'message', message: { role } }), false);
  }
  for (const type of ['custom_message', 'model_change', 'compaction', 'branch_summary']) {
    assert.equal(isInternalSessionEntry({ type }), false);
  }
});

test('retains ancestry through hidden prompt patches and usage entries', () => {
  const entries = [
    { id: 'system', parentId: null, type: 'message', message: { role: 'system' } },
    { id: 'user', parentId: 'system', type: 'message', message: { role: 'user' } },
    { id: 'patch', parentId: 'user', type: 'message', message: { role: 'system' } },
    { id: 'usage', parentId: 'patch', type: 'usage', kind: 'future_usage_kind' },
    { id: 'answer', parentId: 'usage', type: 'message', message: { role: 'assistant' } },
    { id: 'other', parentId: 'patch', type: 'message', message: { role: 'user' } },
  ];
  const branch = branchForEntry(entries, 'answer');
  assert.deepEqual(branch.map(({ id }) => id), ['system', 'user', 'patch', 'usage', 'answer']);
  assert.deepEqual(branch.filter((entry) => !isInternalSessionEntry(entry)).map(({ id }) => id), ['user', 'answer']);
  assert.deepEqual(branchForEntry(entries, 'other').filter((entry) => !isInternalSessionEntry(entry)).map(({ id }) => id), ['user', 'other']);
  assert.deepEqual(branchForEntry(entries, 'usage').filter((entry) => !isInternalSessionEntry(entry)).map(({ id }) => id), ['user']);
  assert.equal(entries.length, 6);
});

test('hides context edits without hiding or replacing raw conversation history', () => {
  const entries = [
    { id: 'user', parentId: null, type: 'message', message: { role: 'user', content: 'Hello' } },
    { id: 'answer', parentId: 'user', type: 'message', message: { role: 'assistant', content: 'Original answer' } },
    { id: 'omit', parentId: 'answer', type: 'context_edit', targetId: 'user', replacement: null },
    { id: 'replace', parentId: 'omit', type: 'context_edit', targetId: 'answer', replacement: { content: 'Revised answer' } },
  ];
  const branch = branchForEntry(entries, 'replace');
  assert.deepEqual(branch.map(({ id }) => id), ['user', 'answer', 'omit', 'replace']);
  assert.deepEqual(branch.filter((entry) => !isInternalSessionEntry(entry)), entries.slice(0, 2));
  assert.equal(entries[1].message?.content, 'Original answer');
  assert.equal(entries.length, 4);
});

test('keeps search rendering bounded around early, middle, and late matches', () => {
  assert.deepEqual(boundedRangeAroundIndex(3_463, 0, 160), { start: 0, end: 160 });
  assert.deepEqual(boundedRangeAroundIndex(3_463, 1_700, 160), { start: 1_620, end: 1_780 });
  assert.deepEqual(boundedRangeAroundIndex(3_463, 3_462, 160), { start: 3_303, end: 3_463 });
});
