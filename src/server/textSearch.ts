import type { FastifyInstance } from 'fastify';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ProjectRegistry } from './projects.js';

const MAX_TEXT_SEARCH_QUERY_LENGTH = 500;
const MAX_TEXT_SEARCH_GLOB_PATTERNS = 100;
const MAX_TEXT_SEARCH_GLOB_PATTERN_LENGTH = 500;
const MAX_TEXT_SEARCH_GLOB_EXPANSIONS = 1_000;
const MAX_TEXT_SEARCH_RESULTS = 1_000;
const MAX_TEXT_SEARCH_RESULTS_PER_FILE = 100;
const MAX_TEXT_SEARCH_CONTEXT_LINES = 3;
const MAX_TEXT_SEARCH_FILE_BYTES = 10 * 1024 * 1024;
const MAX_RIPGREP_JSON_LINE_BYTES = MAX_TEXT_SEARCH_FILE_BYTES * 3;
const MAX_TEXT_SEARCH_PREVIEW_CHARS = 500;
const TEXT_SEARCH_TIMEOUT_MS = 15_000;
const MAX_TEXT_SEARCH_STDERR_CHARS = 64 * 1024;
const TEXT_SEARCH_SKIPPED_GLOBS = ['!**/.git', '!**/.git/**', '!**/node_modules', '!**/node_modules/**', '!**/.pi-web', '!**/.pi-web/**'];

type TextSearchBody = {
  query?: unknown;
  caseSensitive?: unknown;
  wholeWord?: unknown;
  contextLines?: unknown;
  includePatterns?: unknown;
  excludePatterns?: unknown;
};

type TextSearchOptions = {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  contextLines: number;
  includePatterns: string[];
  excludePatterns: string[];
};

type TextSearchRange = { startColumn: number; endColumn: number };
type TextSearchLine = {
  line: number;
  preview: string;
  previewStartColumn: number;
  beforeTruncated: boolean;
  afterTruncated: boolean;
  ranges: TextSearchRange[];
  targetRange?: TextSearchRange;
};
type TextSearchFileEvent = { type: 'file'; path: string; matchCount: number; lines: TextSearchLine[] };
type TextSearchDoneEvent = { type: 'done'; fileCount: number; matchCount: number; limitHit: boolean; timedOut: boolean };
type TextSearchErrorEvent = { type: 'error'; message: string };
type TextSearchEvent = TextSearchFileEvent | TextSearchDoneEvent | TextSearchErrorEvent;
type PendingTextSearchLine = { line: number; text: string; ranges: TextSearchRange[] };
type PendingTextSearchFile = { path: string; matchCount: number; lines: Map<number, PendingTextSearchLine> };
type RipgrepJsonValue = { text?: unknown; bytes?: unknown };
type RipgrepJsonEvent = {
  type?: unknown;
  data?: {
    path?: RipgrepJsonValue;
    lines?: RipgrepJsonValue;
    line_number?: unknown;
    submatches?: Array<{ start?: unknown; end?: unknown }>;
  };
};

export async function registerTextSearchRoute(app: FastifyInstance, registry: ProjectRegistry) {
  const activeSearches = new Set<AbortController>();
  app.addHook('preClose', async () => {
    for (const controller of activeSearches) controller.abort();
    activeSearches.clear();
  });

  app.post<{ Params: { projectId: string }; Body: TextSearchBody }>(
    '/api/projects/:projectId/files/text-search',
    { compress: false },
    async (request, reply) => {
      try {
        const project = registry.get(request.params.projectId);
        const options = textSearchOptions(request.body);
        const globArgs = textSearchGlobArgs(options);
        const controller = new AbortController();
        activeSearches.add(controller);
        const abort = () => controller.abort();
        const cleanup = () => {
          reply.raw.off('close', abort);
          activeSearches.delete(controller);
          controller.abort();
        };
        reply.raw.once('close', abort);
        const stream = Readable.from(ndjsonTextSearch(project.path, options, globArgs, controller.signal));
        stream.once('close', cleanup);
        return reply
          .type('application/x-ndjson; charset=utf-8')
          .header('cache-control', 'no-store')
          .header('x-content-type-options', 'nosniff')
          .send(stream);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not search file contents' });
      }
    },
  );
}

function textSearchOptions(body: TextSearchBody | undefined): TextSearchOptions {
  if (!body || typeof body.query !== 'string') throw new Error('Missing search text');
  const query = body.query.trim();
  if (!query.length) throw new Error('Search text cannot be empty');
  if (query.length > MAX_TEXT_SEARCH_QUERY_LENGTH) throw new Error(`Search text cannot exceed ${MAX_TEXT_SEARCH_QUERY_LENGTH} characters`);
  if (/[\0\r\n]/.test(query)) throw new Error('Search text must be a single line');
  if (body.caseSensitive !== undefined && typeof body.caseSensitive !== 'boolean') throw new Error('Invalid case-sensitive option');
  if (body.wholeWord !== undefined && typeof body.wholeWord !== 'boolean') throw new Error('Invalid whole-word option');
  const contextLines = body.contextLines ?? 1;
  if (!Number.isInteger(contextLines) || Number(contextLines) < 0 || Number(contextLines) > MAX_TEXT_SEARCH_CONTEXT_LINES) {
    throw new Error(`Context lines must be an integer from 0 to ${MAX_TEXT_SEARCH_CONTEXT_LINES}`);
  }
  return {
    query,
    caseSensitive: body.caseSensitive === true,
    wholeWord: body.wholeWord === true,
    contextLines: Number(contextLines),
    includePatterns: textSearchGlobPatterns(body.includePatterns, 'include'),
    excludePatterns: textSearchGlobPatterns(body.excludePatterns, 'exclude'),
  };
}

function textSearchGlobPatterns(value: unknown, kind: 'include' | 'exclude') {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Invalid files-to-${kind} patterns`);
  if (value.length > MAX_TEXT_SEARCH_GLOB_PATTERNS) throw new Error(`Files-to-${kind} patterns cannot exceed ${MAX_TEXT_SEARCH_GLOB_PATTERNS} entries`);
  return [...new Set(value.map((pattern) => {
    if (typeof pattern !== 'string') throw new Error(`Invalid files-to-${kind} pattern`);
    const normalized = pattern.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
    if (!normalized || normalized.length > MAX_TEXT_SEARCH_GLOB_PATTERN_LENGTH || /[\0\r\n]/.test(normalized)) throw new Error(`Invalid files-to-${kind} pattern`);
    if (normalized.startsWith('!')) throw new Error(`Files-to-${kind} patterns cannot start with !`);
    if (/^(?:\.\.?$|\.\.?\/|\/|[a-zA-Z]:(?:$|\/))/.test(normalized)) throw new Error('Search paths are not supported; use a workspace-relative glob without ./');
    return normalized;
  }))];
}

function textSearchGlobArgs(options: Pick<TextSearchOptions, 'includePatterns' | 'excludePatterns'>) {
  const includes = new Set<string>();
  for (const pattern of options.includePatterns) {
    for (const glob of [...textSearchIncludeTraversalGlobs(pattern), ...expandTextSearchGlob(pattern)]) {
      includes.add(glob);
      if (includes.size > MAX_TEXT_SEARCH_GLOB_EXPANSIONS) throw new Error(`Search glob expansion cannot exceed ${MAX_TEXT_SEARCH_GLOB_EXPANSIONS} entries`);
    }
  }
  return [
    ...[...includes].flatMap((glob) => ['--glob', glob]),
    ...options.excludePatterns.flatMap(expandTextSearchGlob).flatMap((glob) => ['--glob', `!${glob}`]),
    ...TEXT_SEARCH_SKIPPED_GLOBS.flatMap((glob) => ['--glob', glob]),
  ];
}

function textSearchIncludeTraversalGlobs(pattern: string) {
  const normalized = pattern.startsWith('.') ? `*${pattern}` : pattern;
  const prefixes = new Set<string>();
  for (const expanded of expandTextSearchBraceAlternatives(normalized)) {
    const components = splitTextSearchGlob(expanded, '/');
    for (let index = 0; index < components.length - 1; index += 1) {
      const prefix = collapseRecursiveGlob(`**/${components.slice(0, index + 1).join('/')}/`);
      if (prefix === '**/') continue;
      prefixes.add(prefix);
      if (prefixes.size > MAX_TEXT_SEARCH_GLOB_EXPANSIONS) throw new Error(`Search glob expansion cannot exceed ${MAX_TEXT_SEARCH_GLOB_EXPANSIONS} entries`);
    }
  }
  return [...prefixes];
}

function expandTextSearchBraceAlternatives(glob: string, expanded: string[] = []) {
  const brace = expandableTextSearchBrace(glob);
  if (!brace) {
    expanded.push(glob);
    if (expanded.length > MAX_TEXT_SEARCH_GLOB_EXPANSIONS) throw new Error(`Search glob expansion cannot exceed ${MAX_TEXT_SEARCH_GLOB_EXPANSIONS} entries`);
    return expanded;
  }
  for (const alternative of brace.alternatives) {
    expandTextSearchBraceAlternatives(`${glob.slice(0, brace.start)}${alternative}${glob.slice(brace.end + 1)}`, expanded);
  }
  return expanded;
}

function expandableTextSearchBrace(glob: string) {
  const starts: number[] = [];
  let inBrackets = false;
  let bracketCharacters = 0;
  let bracketNegated = false;
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (inBrackets) {
      if (bracketCharacters === 0 && (character === '!' || character === '^')) {
        bracketNegated = true;
        bracketCharacters += 1;
      } else if (character === ']' && bracketCharacters > (bracketNegated ? 1 : 0)) inBrackets = false;
      else bracketCharacters += 1;
      continue;
    }
    if (character === '[') {
      inBrackets = true;
      bracketCharacters = 0;
      bracketNegated = false;
      continue;
    }
    if (character === '{') {
      starts.push(index);
      continue;
    }
    if (character !== '}' || !starts.length) continue;
    const start = starts.pop()!;
    const alternatives = splitTextSearchGlob(glob.slice(start + 1, index), ',');
    if (alternatives.length > 1) return { start, end: index, alternatives };
  }
  return undefined;
}

function expandTextSearchGlob(pattern: string) {
  const normalized = pattern.startsWith('.') ? `*${pattern}` : pattern;
  return [...new Set([
    collapseRecursiveGlob(`**/${normalized}/**`),
    collapseRecursiveGlob(`**/${normalized}`),
  ])];
}

function splitTextSearchGlob(glob: string, separator: string) {
  const components: string[] = [];
  let current = '';
  let braceDepth = 0;
  let inBrackets = false;
  let bracketCharacters = 0;
  let bracketNegated = false;
  for (const character of glob) {
    if (character === separator && braceDepth === 0 && !inBrackets) {
      components.push(current);
      current = '';
      continue;
    }
    if (inBrackets) {
      if (bracketCharacters === 0 && (character === '!' || character === '^')) {
        bracketNegated = true;
        bracketCharacters += 1;
      } else if (character === ']' && bracketCharacters > (bracketNegated ? 1 : 0)) inBrackets = false;
      else bracketCharacters += 1;
    } else if (character === '[') {
      inBrackets = true;
      bracketCharacters = 0;
      bracketNegated = false;
    } else if (character === '{') braceDepth += 1;
    else if (character === '}' && braceDepth > 0) braceDepth -= 1;
    current += character;
  }
  components.push(current);
  return components;
}

function collapseRecursiveGlob(glob: string) {
  return glob.split('/').filter((segment, index, segments) => segment !== '**' || segments[index - 1] !== '**').join('/');
}

async function* ndjsonTextSearch(projectPath: string, options: TextSearchOptions, globArgs: string[], signal: AbortSignal) {
  for await (const event of projectTextSearch(projectPath, options, globArgs, signal)) yield `${JSON.stringify(event)}\n`;
}

async function* projectTextSearch(projectPath: string, options: TextSearchOptions, globArgs: string[], signal: AbortSignal): AsyncGenerator<TextSearchEvent> {
  const args = [
    '--json',
    '--no-config',
    '--no-follow',
    '--no-pre',
    '--no-require-git',
    '--fixed-strings',
    options.caseSensitive ? '--case-sensitive' : '--ignore-case',
    ...(options.wholeWord ? ['--word-regexp'] : []),
    `--context=${options.contextLines}`,
    `--max-count=${MAX_TEXT_SEARCH_RESULTS_PER_FILE + 1}`,
    `--max-filesize=${MAX_TEXT_SEARCH_FILE_BYTES}`,
    '--hidden',
    ...globArgs,
    '--',
    options.query,
    '.',
  ];
  if (signal.aborted) return;
  let executable: string;
  try {
    ({ rgPath: executable } = await import('@vscode/ripgrep'));
  } catch {
    yield { type: 'error', message: 'Text search is unavailable on this platform' };
    return;
  }
  if (signal.aborted) return;
  const child = spawn(executable, args, {
    cwd: projectPath,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childSettled = false;
  let stoppedForLimit = false;
  let resultsTruncated = false;
  let timedOut = false;
  let stderr = '';
  let pendingOutputChunks: Buffer[] = [];
  let pendingOutputBytes = 0;
  let totalMatches = 0;
  let fileCount = 0;
  const pendingFiles = new Map<string, PendingTextSearchFile>();
  const stopChild = () => {
    if (!childSettled) child.kill();
  };
  const abortChild = () => stopChild();
  signal.addEventListener('abort', abortChild, { once: true });
  if (signal.aborted) stopChild();
  const timeout = setTimeout(() => {
    timedOut = true;
    stopChild();
  }, TEXT_SEARCH_TIMEOUT_MS);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < MAX_TEXT_SEARCH_STDERR_CHARS) stderr += chunk.slice(0, MAX_TEXT_SEARCH_STDERR_CHARS - stderr.length);
  });
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, closeSignal) => {
      childSettled = true;
      resolve({ code, signal: closeSignal });
    });
  });

  try {
    for await (const rawChunk of child.stdout) {
      if (signal.aborted) break;
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      let chunkOffset = 0;
      while (chunkOffset < chunk.length) {
        const newlineIndex = chunk.indexOf(0x0a, chunkOffset);
        if (newlineIndex === -1) {
          const remainder = chunk.subarray(chunkOffset);
          pendingOutputBytes += remainder.length;
          if (pendingOutputBytes > MAX_RIPGREP_JSON_LINE_BYTES) {
            stopChild();
            throw new Error('A search result line is too large to display');
          }
          pendingOutputChunks.push(remainder);
          break;
        }

        const segment = chunk.subarray(chunkOffset, newlineIndex);
        const jsonLineBytes = pendingOutputBytes + segment.length;
        if (jsonLineBytes > MAX_RIPGREP_JSON_LINE_BYTES) {
          stopChild();
          throw new Error('A search result line is too large to display');
        }
        const jsonLine = pendingOutputChunks.length ? Buffer.concat([...pendingOutputChunks, segment], jsonLineBytes) : segment;
        pendingOutputChunks = [];
        pendingOutputBytes = 0;
        const event = parseRipgrepEvent(jsonLine);
        if (event) {
          const fileEvent = applyRipgrepEvent(event, pendingFiles, projectPath, MAX_TEXT_SEARCH_RESULTS - totalMatches);
          if (fileEvent?.type === 'match-count') {
            totalMatches += fileEvent.count;
            resultsTruncated ||= fileEvent.truncated;
            if (fileEvent.globalLimitHit) {
              stoppedForLimit = true;
              stopChild();
            }
          } else if (fileEvent?.type === 'file') {
            fileCount += 1;
            yield fileEvent.event;
          }
        }
        if (stoppedForLimit || signal.aborted) break;
        chunkOffset = newlineIndex + 1;
      }
      if (stoppedForLimit || signal.aborted) break;
    }

    const result = await completion;
    if (signal.aborted) return;
    for (const pending of pendingFiles.values()) {
      if (!pending.matchCount) continue;
      fileCount += 1;
      yield textSearchFileEvent(pending);
    }
    pendingFiles.clear();

    if (!stoppedForLimit && !timedOut && result.code !== 0 && result.code !== 1) {
      yield { type: 'error', message: stderr.trim() || `Text search exited with code ${result.code ?? result.signal ?? 'unknown'}` };
      return;
    }
    yield {
      type: 'done',
      fileCount,
      matchCount: totalMatches,
      limitHit: stoppedForLimit || resultsTruncated || timedOut,
      timedOut,
    };
  } catch (error) {
    stopChild();
    await completion.catch(() => undefined);
    if (!signal.aborted) yield { type: 'error', message: error instanceof Error ? error.message : 'Could not search file contents' };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abortChild);
    stopChild();
  }
}

function parseRipgrepEvent(line: Buffer): RipgrepJsonEvent | undefined {
  if (!line.length) return undefined;
  try {
    return JSON.parse(line.toString('utf8')) as RipgrepJsonEvent;
  } catch {
    return undefined;
  }
}

function applyRipgrepEvent(
  event: RipgrepJsonEvent,
  pendingFiles: Map<string, PendingTextSearchFile>,
  projectPath: string,
  remainingMatches: number,
): { type: 'match-count'; count: number; truncated: boolean; globalLimitHit: boolean } | { type: 'file'; event: TextSearchFileEvent } | undefined {
  if (event.type !== 'match' && event.type !== 'context' && event.type !== 'end') return undefined;
  const filePath = ripgrepText(event.data?.path);
  if (!filePath) return undefined;
  const normalizedPath = normalizeRipgrepPath(projectPath, filePath);
  let pending = pendingFiles.get(normalizedPath);
  if (!pending) {
    pending = { path: normalizedPath, matchCount: 0, lines: new Map() };
    pendingFiles.set(normalizedPath, pending);
  }

  if (event.type === 'end') {
    pendingFiles.delete(normalizedPath);
    return pending.matchCount ? { type: 'file', event: textSearchFileEvent(pending) } : undefined;
  }

  const text = ripgrepText(event.data?.lines);
  const lineNumber = event.data?.line_number;
  if (text === undefined || typeof lineNumber !== 'number' || !Number.isSafeInteger(lineNumber) || lineNumber < 1) return undefined;
  const lineText = text.replace(/\r?\n$/, '');
  let line = pending.lines.get(lineNumber);
  if (event.type === 'context') {
    if (!line) pending.lines.set(lineNumber, { line: lineNumber, text: lineText, ranges: [] });
    return undefined;
  }

  const availableForFile = Math.max(0, MAX_TEXT_SEARCH_RESULTS_PER_FILE - pending.matchCount);
  const matches = (event.data?.submatches ?? [])
    .filter((match): match is { start: number; end: number } => typeof match.start === 'number' && typeof match.end === 'number' && match.start >= 0 && match.end >= match.start);
  const acceptedMatches = matches.slice(0, Math.min(availableForFile, Math.max(remainingMatches, 0)));
  const accepted = ripgrepRanges(lineText, acceptedMatches);
  if (accepted.length) {
    if (!line) {
      line = { line: lineNumber, text: lineText, ranges: [] };
      pending.lines.set(lineNumber, line);
    }
    line.ranges.push(...accepted);
  }
  pending.matchCount += accepted.length;
  const truncated = accepted.length < matches.length;
  return {
    type: 'match-count',
    count: accepted.length,
    truncated,
    globalLimitHit: truncated && remainingMatches <= accepted.length,
  };
}

function textSearchFileEvent(file: PendingTextSearchFile): TextSearchFileEvent {
  return {
    type: 'file',
    path: file.path,
    matchCount: file.matchCount,
    lines: [...file.lines.values()]
      .sort((left, right) => left.line - right.line)
      .flatMap(textSearchLines),
  };
}

function textSearchLines(line: PendingTextSearchLine): TextSearchLine[] {
  if (!line.ranges.length) {
    return [{
      line: line.line,
      preview: line.text.slice(0, MAX_TEXT_SEARCH_PREVIEW_CHARS),
      previewStartColumn: 1,
      beforeTruncated: false,
      afterTruncated: line.text.length > MAX_TEXT_SEARCH_PREVIEW_CHARS,
      ranges: [],
    }];
  }
  return line.ranges.map((targetRange) => {
    const targetStartIndex = targetRange.startColumn - 1;
    const targetEndIndex = targetRange.endColumn - 1;
    const previewStartIndex = Math.min(targetStartIndex, Math.max(0, targetStartIndex - Math.floor(MAX_TEXT_SEARCH_PREVIEW_CHARS / 3), targetEndIndex - MAX_TEXT_SEARCH_PREVIEW_CHARS));
    const previewEndIndex = Math.min(line.text.length, previewStartIndex + MAX_TEXT_SEARCH_PREVIEW_CHARS);
    const previewStartColumn = previewStartIndex + 1;
    const previewEndColumn = previewEndIndex + 1;
    return {
      line: line.line,
      preview: line.text.slice(previewStartIndex, previewEndIndex),
      previewStartColumn,
      beforeTruncated: previewStartIndex > 0,
      afterTruncated: previewEndIndex < line.text.length,
      ranges: line.ranges.filter((range) => range.endColumn > previewStartColumn && range.startColumn < previewEndColumn),
      targetRange,
    };
  });
}

function ripgrepRanges(line: string, matches: Array<{ start: number; end: number }>): TextSearchRange[] {
  if (!matches.length) return [];
  const bytes = Buffer.from(line, 'utf8');
  const offsets = [...new Set(matches.flatMap((match) => [
    Math.min(match.start, bytes.length),
    Math.min(Math.max(match.end, match.start), bytes.length),
  ]))].sort((left, right) => left - right);
  const columns = new Map<number, number>();
  let byteOffset = 0;
  let column = 1;
  for (const offset of offsets) {
    column += bytes.subarray(byteOffset, offset).toString('utf8').length;
    columns.set(offset, column);
    byteOffset = offset;
  }
  return matches.map((match) => {
    const start = Math.min(match.start, bytes.length);
    const end = Math.min(Math.max(match.end, match.start), bytes.length);
    return { startColumn: columns.get(start)!, endColumn: columns.get(end)! };
  });
}

function ripgrepText(value: RipgrepJsonValue | undefined) {
  return typeof value?.text === 'string' ? value.text : undefined;
}

function normalizeRipgrepPath(projectPath: string, filePath: string) {
  const normalized = path.normalize(filePath);
  const absolute = path.resolve(projectPath, normalized);
  const relative = path.relative(path.resolve(projectPath), absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Search result escapes workspace');
  return relative.split(path.sep).join('/');
}
