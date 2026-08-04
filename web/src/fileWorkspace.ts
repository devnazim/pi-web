const TEXT_FILE_VARIANT_SUFFIXES = new Set([
  'alpine',
  'ci',
  'debian',
  'debug',
  'default',
  'defaults',
  'dev',
  'development',
  'docker',
  'example',
  'local',
  'prod',
  'production',
  'release',
  'sample',
  'stage',
  'staging',
  'template',
  'test',
  'testing',
  'ubuntu',
]);

const WELL_KNOWN_TEXT_FILE_NAMES = new Set([
  '.babelrc',
  '.bashrc',
  '.browserslistrc',
  '.curlrc',
  '.dockerignore',
  '.editorconfig',
  '.eslintignore',
  '.eslintrc',
  '.gitattributes',
  '.gitignore',
  '.gitkeep',
  '.gitmodules',
  '.helmignore',
  '.ignore',
  '.gvimrc',
  '.inputrc',
  '.node-version',
  '.npmignore',
  '.npmrc',
  '.nvmrc',
  '.pnpmrc',
  '.prettierignore',
  '.prettierrc',
  '.profile',
  '.python-version',
  '.rgignore',
  '.ruby-version',
  '.stylelintignore',
  '.stylelintrc',
  '.swcrc',
  '.tmux.conf',
  '.tool-versions',
  '.vimrc',
  '.wgetrc',
  '.yarnrc',
  '.zprofile',
  '.zshrc',
  'brewfile',
  'cmakelists.txt',
  'gemfile',
  'gnumakefile',
  'jenkinsfile',
  'justfile',
  'makefile',
  'procfile',
  'rakefile',
  'taskfile',
  'tiltfile',
  'vagrantfile',
]);

export function isTextPath(filePath: string) {
  const fileName = filePath.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? '';
  return /\.(txt|md|mdx|json|jsonc|ts|tsx|js|jsx|css|scss|html|xml|yaml|yml|toml|ini|env|sh|bash|zsh|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|sql|log)$/i.test(fileName)
    || textFileNameVariant(fileName, '.env')
    || textFileNameVariant(fileName, 'dockerfile')
    || textFileNameVariant(fileName, '.dockerfile')
    || textFileNameVariant(fileName, 'containerfile')
    || textFileNameVariant(fileName, '.containerfile')
    || WELL_KNOWN_TEXT_FILE_NAMES.has(fileName);
}

function textFileNameVariant(fileName: string, baseName: string) {
  if (fileName === baseName) return true;
  if (!fileName.startsWith(`${baseName}.`)) return false;
  return fileName.slice(baseName.length + 1).split('.').every((suffix) => TEXT_FILE_VARIANT_SUFFIXES.has(suffix));
}

export function pathIsAtOrBelow(path: string, root: string) {
  return path === root || path.startsWith(`${root}/`);
}

export function remapPathRoot(path: string, previousRoot: string, nextRoot: string) {
  return pathIsAtOrBelow(path, previousRoot) ? `${nextRoot}${path.slice(previousRoot.length)}` : path;
}

export function fileAncestorDirectories(path: string) {
  const directories = [''];
  const parts = path.split('/').filter(Boolean).slice(0, -1);
  for (let index = 1; index <= parts.length; index += 1) directories.push(parts.slice(0, index).join('/'));
  return directories;
}

export function activePathAfterRemoval(paths: string[], activePath: string | undefined, removed: (path: string) => boolean) {
  if (!activePath || !removed(activePath)) return activePath;
  const activeIndex = paths.indexOf(activePath);
  const remaining = paths.filter((path) => !removed(path));
  return remaining[Math.min(Math.max(activeIndex, 0), remaining.length - 1)];
}

export function shouldRefreshFileSearchTarget(tab?: { loaded: boolean; savedContent?: string; draftContent?: string }) {
  return !tab || !tab.loaded || tab.savedContent === undefined || tab.draftContent === undefined || tab.savedContent === tab.draftContent;
}

export function closestDraftTextSearchRange(content: string, query: string, sourceLine: number, sourceColumn: number, options: { caseSensitive: boolean; wholeWord: boolean }) {
  if (!query) return undefined;
  let sourceLineStart = 0;
  for (let line = 1; line < sourceLine; line += 1) {
    const newline = content.indexOf('\n', sourceLineStart);
    if (newline === -1) {
      sourceLineStart = content.length;
      break;
    }
    sourceLineStart = newline + 1;
  }
  const center = Math.min(content.length, sourceLineStart + Math.max(sourceColumn - 1, 0));
  const windowStart = Math.max(0, center - 10_000);
  const windowEnd = Math.min(content.length, center + 10_000);
  const lineStarts = [{ offset: 0, line: 1, column: 1 }];
  let line = 1;
  let lineStart = 0;
  for (let newline = content.indexOf('\n'); newline !== -1 && newline < windowStart; newline = content.indexOf('\n', newline + 1)) {
    line += 1;
    lineStart = newline + 1;
  }
  lineStarts[0] = { offset: 0, line, column: windowStart - lineStart + 1 };
  const window = content.slice(windowStart, windowEnd);
  for (let newline = window.indexOf('\n'); newline !== -1; newline = window.indexOf('\n', newline + 1)) {
    line += 1;
    lineStarts.push({ offset: newline + 1, line, column: 1 });
  }

  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options.caseSensitive ? 'gu' : 'giu');
  let best: { line: number; startColumn: number; endColumn: number; score: number } | undefined;
  for (let match = expression.exec(window); match; match = expression.exec(window)) {
    const absoluteIndex = windowStart + match.index;
    if (options.wholeWord && (draftWordCharacterBefore(content, absoluteIndex) || draftWordCharacterAt(content, absoluteIndex + match[0].length))) continue;
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (lineStarts[middle].offset <= match.index) low = middle;
      else high = middle - 1;
    }
    const matchLine = lineStarts[low];
    const startColumn = matchLine.column + match.index - matchLine.offset;
    const score = Math.abs(matchLine.line - sourceLine) * 10_000 + Math.abs(startColumn - sourceColumn);
    if (!best || score < best.score) best = { line: matchLine.line, startColumn, endColumn: startColumn + match[0].length, score };
  }
  return best && { line: best.line, startColumn: best.startColumn, endColumn: best.endColumn };
}

function draftWordCharacterBefore(content: string, index: number) {
  if (index <= 0) return false;
  const lowSurrogate = content.charCodeAt(index - 1) >= 0xdc00 && content.charCodeAt(index - 1) <= 0xdfff;
  return draftWordCharacterAt(content, index - (lowSurrogate ? 2 : 1));
}

function draftWordCharacterAt(content: string, index: number) {
  const codePoint = index >= 0 && index < content.length ? content.codePointAt(index) : undefined;
  return codePoint !== undefined && /[\p{L}\p{N}\p{M}\p{Pc}\u200c\u200d]/u.test(String.fromCodePoint(codePoint));
}
