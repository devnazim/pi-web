import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectReviewAnchor, reviewSelectionLineRange } from './reviewSelection';

test('uses the current line for an empty selection', () => {
  assert.deepEqual(reviewSelectionLineRange({ startLineNumber: 7, startColumn: 4, endLineNumber: 7, endColumn: 4 }), { startLine: 7, endLine: 7 });
});

test('includes the last line when the selection ends within it', () => {
  assert.deepEqual(reviewSelectionLineRange({ startLineNumber: 3, startColumn: 2, endLineNumber: 6, endColumn: 8 }), { startLine: 3, endLine: 6 });
});

test('excludes the last line when a multiline selection ends at column one', () => {
  assert.deepEqual(reviewSelectionLineRange({ startLineNumber: 3, startColumn: 2, endLineNumber: 6, endColumn: 1 }), { startLine: 3, endLine: 5 });
});

test('projects an anchor onto the selected diff baseline', () => {
  const anchor = { startLine: 2, endLine: 2, selectedText: 'target', contextBefore: ['before'], contextAfter: ['after'] };
  assert.deepEqual(projectReviewAnchor(anchor, 'intro\nbefore\ntarget\nafter\n'), { startLine: 3, endLine: 3 });
});

test('does not project an anchor when context is ambiguous or changed', () => {
  const anchor = { startLine: 9, endLine: 9, selectedText: 'target', contextBefore: ['before'], contextAfter: ['after'] };
  assert.equal(projectReviewAnchor(anchor, 'before\ntarget\nafter\nbefore\ntarget\nafter\n'), undefined);
  assert.equal(projectReviewAnchor(anchor, 'other\ntarget\ncontext\n'), undefined);
});

test('requires matching context at the same line when crossing baselines', () => {
  const anchor = { startLine: 2, endLine: 2, selectedText: 'target', contextBefore: ['before'], contextAfter: ['after'] };
  assert.deepEqual(projectReviewAnchor(anchor, 'changed\ntarget\ncontext\n'), { startLine: 2, endLine: 2 });
  assert.equal(projectReviewAnchor(anchor, 'changed\ntarget\ncontext\n', true), undefined);
  assert.deepEqual(projectReviewAnchor(anchor, 'before\ntarget\nafter\n', true), { startLine: 2, endLine: 2 });
});
