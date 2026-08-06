import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { COMPOSER_UPLOAD_ACCEPT, composerClipboardUploadFiles, handleComposerFilePaste, isSupportedComposerUploadFile } from './clipboard';

function clipboardData(items: Array<{ kind: string; getAsFile: () => File | null }> = [], files: File[] = []) {
  return { items, files } as unknown as Pick<DataTransfer, 'files' | 'items'>;
}

function pasteEvent(data: Pick<DataTransfer, 'files' | 'items'> | null) {
  let prevented = false;
  return {
    event: {
      clipboardData: data,
      preventDefault: () => { prevented = true; },
    } as Pick<ClipboardEvent, 'clipboardData' | 'preventDefault'>,
    prevented: () => prevented,
  };
}

describe('composer clipboard uploads', () => {
  test('leaves text-only clipboard contents alone', () => {
    const result = composerClipboardUploadFiles(clipboardData([
      { kind: 'string', getAsFile: () => null },
    ]));

    assert.deepEqual(result, { files: [], detectedCount: 0, rejectedCount: 0 });
  });

  test('uses clipboard files without duplicating their matching items', () => {
    const image = new File(['image'], 'screenshot.png', { type: 'image/png' });
    const result = composerClipboardUploadFiles(clipboardData([
      { kind: 'file', getAsFile: () => image },
      { kind: 'string', getAsFile: () => null },
    ], [image]));

    assert.equal(result.files.length, 1);
    assert.equal(result.files[0], image);
    assert.equal(result.detectedCount, 1);
    assert.equal(result.rejectedCount, 0);
  });

  test('falls back to file items when the clipboard file list is empty', () => {
    const document = new File(['notes'], 'notes.md', { type: 'text/markdown' });
    const result = composerClipboardUploadFiles(clipboardData([
      { kind: 'file', getAsFile: () => document },
    ]));

    assert.deepEqual(result.files, [document]);
    assert.equal(result.detectedCount, 1);
    assert.equal(result.rejectedCount, 0);
  });

  test('gives unnamed pasted images an extension-aware filename', () => {
    const image = new File(['image'], '', { type: 'image/png', lastModified: 123 });
    const result = composerClipboardUploadFiles(clipboardData([], [image]));

    assert.equal(result.files.length, 1);
    assert.match(result.files[0].name, /^pasted-image-\d+\.png$/);
    assert.equal(result.files[0].type, 'image/png');
    assert.equal(result.files[0].lastModified, 123);
    assert.equal(result.rejectedCount, 0);
  });

  test('reports unsupported clipboard files', () => {
    const archive = new File(['archive'], 'source.zip', { type: 'application/zip' });
    const result = composerClipboardUploadFiles(clipboardData([
      { kind: 'file', getAsFile: () => archive },
    ], [archive]));

    assert.deepEqual(result.files, []);
    assert.equal(result.detectedCount, 1);
    assert.equal(result.rejectedCount, 1);
  });

  test('reports file items that cannot be read', () => {
    const result = composerClipboardUploadFiles(clipboardData([
      { kind: 'file', getAsFile: () => null },
    ]));

    assert.deepEqual(result.files, []);
    assert.equal(result.detectedCount, 1);
    assert.equal(result.rejectedCount, 1);
  });

  test('matches the composer picker file types', () => {
    assert.equal(COMPOSER_UPLOAD_ACCEPT, 'image/*,video/*,.txt,.md,.pdf,.json,.jsonc,application/json');
    for (const file of [
      new File([], 'image', { type: 'image/webp' }),
      new File([], 'clip', { type: 'video/mp4' }),
      new File([], 'notes.txt'),
      new File([], 'notes.md'),
      new File([], 'document.pdf'),
      new File([], 'data.json'),
      new File([], 'data.jsonc'),
    ]) assert.equal(isSupportedComposerUploadFile(file), true, file.name);
    assert.equal(isSupportedComposerUploadFile(new File([], 'source.zip', { type: 'application/zip' })), false);
    assert.equal(isSupportedComposerUploadFile(new File([], 'build.log', { type: 'text/plain' })), false);
    assert.equal(isSupportedComposerUploadFile(new File([], 'document.bin', { type: 'application/pdf' })), false);
    assert.equal(isSupportedComposerUploadFile(new File([], '', { type: 'application/json' })), true);
  });

  test('preserves native text paste behavior', () => {
    const paste = pasteEvent(clipboardData([{ kind: 'string', getAsFile: () => null }]));
    const files: File[][] = [];
    const errors: string[] = [];

    assert.equal(handleComposerFilePaste(paste.event, { busy: false, onFiles: (items) => files.push(items), onError: (message) => errors.push(message) }), false);
    assert.equal(paste.prevented(), false);
    assert.deepEqual(files, []);
    assert.deepEqual(errors, []);
  });

  test('suppresses mixed clipboard text and sends supported files to the upload callback', () => {
    const image = new File(['image'], 'screenshot.png', { type: 'image/png' });
    const paste = pasteEvent(clipboardData([
      { kind: 'file', getAsFile: () => image },
      { kind: 'string', getAsFile: () => null },
    ], [image]));
    const files: File[][] = [];

    assert.equal(handleComposerFilePaste(paste.event, { busy: false, onFiles: (items) => files.push(items), onError: assert.fail }), true);
    assert.equal(paste.prevented(), true);
    assert.deepEqual(files, [[image]]);
  });

  test('suppresses file paste and reports when an upload is already running', () => {
    const image = new File(['image'], 'screenshot.png', { type: 'image/png' });
    const paste = pasteEvent(clipboardData([], [image]));
    const errors: string[] = [];

    assert.equal(handleComposerFilePaste(paste.event, { busy: true, onFiles: () => assert.fail('Unexpected upload'), onError: (message) => errors.push(message) }), true);
    assert.equal(paste.prevented(), true);
    assert.deepEqual(errors, ['Wait for the current upload to finish before pasting more files.']);
  });

  test('suppresses unsupported file paste and reports it without uploading', () => {
    const archive = new File(['archive'], 'source.zip', { type: 'application/zip' });
    const paste = pasteEvent(clipboardData([], [archive]));
    const errors: string[] = [];

    assert.equal(handleComposerFilePaste(paste.event, { busy: false, onFiles: () => assert.fail('Unexpected upload'), onError: (message) => errors.push(message) }), true);
    assert.equal(paste.prevented(), true);
    assert.deepEqual(errors, ['This clipboard file type is not supported.']);
  });
});
