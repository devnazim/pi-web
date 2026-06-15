export type UploadAsset = { path: string; filename?: string; bytes?: number };
export type ComposerHistoryMode = 'normal' | 'shell';
export type ComposerHistoryItem = { text: string; uploads: UploadAsset[] };
export type ComposerHistoryStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const COMPOSER_HISTORY_LIMIT = 100;

const COMPOSER_HISTORY_KEY = 'pi-web-composer-history';
const COMPOSER_SHELL_HISTORY_KEY = 'pi-web-composer-shell-history';
const WORKSPACE_UPLOADS_ROOT = '.pi-web/uploads/';

export function composerHistoryModeForDraft(value: string): ComposerHistoryMode | undefined {
  if (!value) return 'normal';
  return value === '!' || value === '!!' ? 'shell' : undefined;
}

export function canStartComposerHistoryNavigation(mode: ComposerHistoryMode, value: string, cursor: number) {
  if (mode === 'normal') return !value && cursor === 0;
  return (value === '!' || value === '!!') && cursor === value.length;
}

export function cloneUploadAssets(items: UploadAsset[]) {
  return items.map((item) => ({ ...item }));
}

export function prependComposerHistory(history: ComposerHistoryItem[], item: ComposerHistoryItem) {
  const entry = { text: item.text.trim(), uploads: durableComposerHistoryUploads(item.uploads) };
  if (!entry.text && !entry.uploads.length) return history;
  const previous = history[0];
  if (previous && composerHistoryItemsEqual(previous, entry)) return history;
  return [entry, ...history].slice(0, COMPOSER_HISTORY_LIMIT);
}

export function composerHistoryStorageKey(projectId: string, mode: ComposerHistoryMode) {
  const key = mode === 'shell' ? COMPOSER_SHELL_HISTORY_KEY : COMPOSER_HISTORY_KEY;
  return `${key}:${projectId}`;
}

export function readComposerHistory(projectId: string, mode: ComposerHistoryMode, storage = defaultComposerHistoryStorage()): ComposerHistoryItem[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(composerHistoryStorageKey(projectId, mode)) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): ComposerHistoryItem[] => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      if (typeof record.text !== 'string') return [];
      const uploads = Array.isArray(record.uploads) ? record.uploads.flatMap((upload): UploadAsset[] => {
        if (!upload || typeof upload !== 'object') return [];
        const uploadRecord = upload as Record<string, unknown>;
        if (typeof uploadRecord.path !== 'string' || !uploadRecord.path.trim()) return [];
        return [{
          path: uploadRecord.path,
          filename: typeof uploadRecord.filename === 'string' ? uploadRecord.filename : undefined,
          bytes: typeof uploadRecord.bytes === 'number' && Number.isFinite(uploadRecord.bytes) ? uploadRecord.bytes : undefined,
        }];
      }) : [];
      const entry = { text: record.text.trim(), uploads: durableComposerHistoryUploads(uploads) };
      return entry.text || entry.uploads.length ? [entry] : [];
    }).slice(0, COMPOSER_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export function writeComposerHistory(projectId: string, mode: ComposerHistoryMode, history: ComposerHistoryItem[], storage = defaultComposerHistoryStorage()) {
  if (!storage) return;
  try {
    storage.setItem(composerHistoryStorageKey(projectId, mode), JSON.stringify(history.slice(0, COMPOSER_HISTORY_LIMIT)));
  } catch (error) {
    console.warn('Could not persist composer history', error);
  }
}

function durableComposerHistoryUploads(items: UploadAsset[]) {
  return uniqueUploadAssets(cloneUploadAssets(items).flatMap((asset): UploadAsset[] => {
    const path = asset.path.trim();
    if (!path || !isProjectScopedUploadPath(path)) return [];
    return [{ ...asset, path }];
  }));
}

function isProjectScopedUploadPath(filePath: string) {
  return filePath.replace(/\\/g, '/').startsWith(`${WORKSPACE_UPLOADS_ROOT}project/`);
}

function composerHistoryItemsEqual(a: ComposerHistoryItem, b: ComposerHistoryItem) {
  if (a.text !== b.text || a.uploads.length !== b.uploads.length) return false;
  return a.uploads.every((asset, index) => {
    const other = b.uploads[index];
    return Boolean(other) && asset.path === other.path && asset.filename === other.filename && asset.bytes === other.bytes;
  });
}

function uniqueUploadAssets(items: UploadAsset[]) {
  const byPath = new Map<string, UploadAsset>();
  for (const item of items) byPath.set(item.path, { ...byPath.get(item.path), ...item });
  return [...byPath.values()];
}

function defaultComposerHistoryStorage(): ComposerHistoryStorage | undefined {
  try {
    return typeof globalThis.localStorage === 'undefined' ? undefined : globalThis.localStorage;
  } catch {
    return undefined;
  }
}
