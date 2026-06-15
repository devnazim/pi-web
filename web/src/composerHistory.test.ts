import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  COMPOSER_HISTORY_LIMIT,
  canStartComposerHistoryNavigation,
  cloneUploadAssets,
  composerHistoryModeForDraft,
  composerHistoryStorageKey,
  prependComposerHistory,
  readComposerHistory,
  writeComposerHistory,
  type ComposerHistoryItem,
  type ComposerHistoryStorage,
} from './composerHistory';

class MemoryStorage implements ComposerHistoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe('composer history', () => {
  test('detects normal and shell navigation start states', () => {
    assert.equal(composerHistoryModeForDraft(''), 'normal');
    assert.equal(composerHistoryModeForDraft('!'), 'shell');
    assert.equal(composerHistoryModeForDraft('!!'), 'shell');
    assert.equal(composerHistoryModeForDraft('hello'), undefined);

    assert.equal(canStartComposerHistoryNavigation('normal', '', 0), true);
    assert.equal(canStartComposerHistoryNavigation('normal', 'draft', 0), false);
    assert.equal(canStartComposerHistoryNavigation('shell', '!', 1), true);
    assert.equal(canStartComposerHistoryNavigation('shell', '!!', 2), true);
    assert.equal(canStartComposerHistoryNavigation('shell', '!', 0), false);
    assert.equal(canStartComposerHistoryNavigation('shell', '! git status', 1), false);
  });

  test('prepends, trims, deduplicates, limits, and keeps only durable uploads', () => {
    const empty: ComposerHistoryItem[] = [];
    assert.equal(prependComposerHistory(empty, { text: '   ', uploads: [] }), empty);

    const first = prependComposerHistory([], {
      text: '  hello  ',
      uploads: [
        { path: ' src/a.ts ', filename: 'a.ts' },
        { path: '.pi-web/uploads/sessions/session-c2Vzcw/image.png', filename: 'session.png' },
        { path: '.pi-web/uploads/123e4567-e89b-42d3-a456-426614174000/legacy.png', filename: 'legacy.png' },
        { path: '.pi-web/uploads/project/logo.png', filename: 'logo.png', bytes: 42 },
      ],
    });

    assert.deepEqual(first, [
      {
        text: 'hello',
        uploads: [
          { path: '.pi-web/uploads/project/logo.png', filename: 'logo.png', bytes: 42 },
        ],
      },
    ]);

    assert.equal(prependComposerHistory(first, { text: 'hello', uploads: first[0].uploads }), first);

    const many = Array.from({ length: COMPOSER_HISTORY_LIMIT + 1 }, (_, index) => ({ text: `old ${index}`, uploads: [] }));
    const limited = prependComposerHistory(many, { text: 'new', uploads: [] });
    assert.equal(limited.length, COMPOSER_HISTORY_LIMIT);
    assert.equal(limited[0].text, 'new');
    assert.equal(limited.at(-1)?.text, 'old 98');
  });

  test('clones uploads', () => {
    const uploads = [{ path: 'src/a.ts', filename: 'a.ts' }];
    const cloned = cloneUploadAssets(uploads);
    assert.notEqual(cloned, uploads);
    assert.notEqual(cloned[0], uploads[0]);
    cloned[0].path = 'src/b.ts';
    assert.equal(uploads[0].path, 'src/a.ts');
  });

  test('persists normal and shell history separately', () => {
    const storage = new MemoryStorage();

    writeComposerHistory('project-1', 'normal', [{ text: 'normal prompt', uploads: [{ path: 'src/a.ts' }] }], storage);
    writeComposerHistory('project-1', 'shell', [{ text: '!git status', uploads: [] }], storage);

    assert.deepEqual(readComposerHistory('project-1', 'normal', storage), [
      { text: 'normal prompt', uploads: [] },
    ]);
    assert.deepEqual(readComposerHistory('project-1', 'shell', storage), [{ text: '!git status', uploads: [] }]);
  });

  test('sanitizes stored history', () => {
    const storage = new MemoryStorage();
    storage.setItem(composerHistoryStorageKey('project-1', 'normal'), JSON.stringify([
      null,
      { text: 1, uploads: [] },
      {
        text: '  keep  ',
        uploads: [
          { path: ' .pi-web/uploads/project/logo.png ', filename: 'logo.png', bytes: 123 },
          { path: '   ', filename: 'blank.png' },
          { path: '.pi-web/uploads/sessions/session-c2Vzcw/session.png', filename: 'session.png' },
        ],
      },
      { text: '', uploads: [{ path: 'src/context.md', filename: 7, bytes: 'bad' }] },
      { text: '   ', uploads: [] },
    ]));

    assert.deepEqual(readComposerHistory('project-1', 'normal', storage), [
      { text: 'keep', uploads: [{ path: '.pi-web/uploads/project/logo.png', filename: 'logo.png', bytes: 123 }] },
    ]);
  });
});
