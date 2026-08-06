export const COMPOSER_UPLOAD_ACCEPT = 'image/*,video/*,.txt,.md,.pdf,.json,.jsonc,application/json';

const COMPOSER_UPLOAD_EXTENSIONS = new Set(['txt', 'md', 'pdf', 'json', 'jsonc']);
const COMPOSER_UPLOAD_MIME_TYPES = new Set(['application/json']);

export function composerClipboardUploadFiles(data: Pick<DataTransfer, 'files' | 'items'>) {
  const fileItems = Array.from(data.items).filter((item) => item.kind === 'file');
  const listedFiles = Array.from(data.files);
  const clipboardFiles = listedFiles.length
    ? listedFiles
    : fileItems.flatMap((item) => {
      const file = item.getAsFile();
      return file ? [file] : [];
    });
  const files = clipboardFiles.filter(isSupportedComposerUploadFile).map(normalizePastedFileName);
  const detectedCount = Math.max(fileItems.length, listedFiles.length);

  return {
    files,
    detectedCount,
    rejectedCount: detectedCount - files.length,
  };
}

export function handleComposerFilePaste(
  event: Pick<ClipboardEvent, 'clipboardData' | 'preventDefault'>,
  options: { busy: boolean; onFiles: (files: File[]) => void; onError: (message: string) => void },
) {
  if (!event.clipboardData) return false;
  const clipboardUpload = composerClipboardUploadFiles(event.clipboardData);
  if (!clipboardUpload.detectedCount) return false;
  event.preventDefault();
  if (options.busy) {
    options.onError('Wait for the current upload to finish before pasting more files.');
    return true;
  }
  if (clipboardUpload.rejectedCount) {
    options.onError(clipboardUpload.detectedCount === 1
      ? 'This clipboard file type is not supported.'
      : 'One or more clipboard file types are not supported.');
    return true;
  }
  options.onFiles(clipboardUpload.files);
  return true;
}

export function isSupportedComposerUploadFile(file: Pick<File, 'name' | 'type'>) {
  const mimeType = file.type.toLowerCase();
  if (mimeType.startsWith('image/') || mimeType.startsWith('video/') || COMPOSER_UPLOAD_MIME_TYPES.has(mimeType)) return true;
  return COMPOSER_UPLOAD_EXTENSIONS.has(file.name.trim().split('.').at(-1)?.toLowerCase() ?? '');
}

function normalizePastedFileName(file: File, index: number) {
  if (file.name.trim() && /\.[A-Za-z0-9]+$/.test(file.name.trim())) return file;
  const extension = pastedFileExtension(file.type);
  if (!extension) return file;
  const kind = file.type.toLowerCase().startsWith('image/') ? 'image' : file.type.toLowerCase().startsWith('video/') ? 'video' : 'file';
  const sequence = index ? `-${index + 1}` : '';
  return new File([file], `pasted-${kind}-${Date.now()}${sequence}.${extension}`, { type: file.type, lastModified: file.lastModified });
}

function pastedFileExtension(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  const knownExtensions: Record<string, string> = {
    'application/json': 'json',
    'image/jpeg': 'jpg',
    'image/svg+xml': 'svg',
    'video/quicktime': 'mov',
    'video/x-m4v': 'm4v',
  };
  if (knownExtensions[normalized]) return knownExtensions[normalized];
  const match = /^(?:image|video)\/([a-z0-9.+-]+)$/.exec(normalized);
  return match?.[1].split('+', 1)[0];
}

export async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.append(textarea);
  textarea.select();
  try {
    if (!document.execCommand('copy')) throw new Error('Copy failed');
  } finally {
    textarea.remove();
  }
}
