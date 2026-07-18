import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import { getGitStatus } from './git.js';
import {
  addAgentReviewReply,
  createAgentReviewThread,
  getPendingReviewThreads,
  getReviewThreads,
  resolveAgentReviewThread,
} from './reviewThreads.js';

const REVIEW_TOOL_NAMES = [
  'pi_web_review_list',
  'pi_web_review_reply',
  'pi_web_review_create',
  'pi_web_review_resolve',
] as const;
const MAX_PROMPT_THREADS = 100;
const MAX_THREAD_CHARS = 8 * 1024;
const MAX_FILE_SUMMARY_CHARS = 16 * 1024;
const MAX_PROMPT_CHARS = 128 * 1024;

type ReviewExtensionDependencies = {
  getGitStatus: typeof getGitStatus;
  getReviewThreads: typeof getReviewThreads;
  getPendingReviewThreads: typeof getPendingReviewThreads;
  addAgentReviewReply: typeof addAgentReviewReply;
  createAgentReviewThread: typeof createAgentReviewThread;
  resolveAgentReviewThread: typeof resolveAgentReviewThread;
};

type ListParams = { cursor?: string; limit?: number; path?: string; includeHandled?: boolean };
type ReplyParams = { threadId: string; body: string; handlesUserRevision: number; resolve?: boolean };
type CreateParams = { path: string; staged?: boolean; startLine: number; endLine: number; selectedText: string; contextBefore: string[]; contextAfter: string[]; body: string };
type ResolveParams = { threadId: string; handlesUserRevision: number; body?: string };
type ToolResult = { content: Array<{ type: 'text'; text: string }>; details: unknown };

const dependencies: ReviewExtensionDependencies = {
  getGitStatus,
  getReviewThreads,
  getPendingReviewThreads,
  addAgentReviewReply,
  createAgentReviewThread,
  resolveAgentReviewThread,
};

const stringProperty = { type: 'string', minLength: 1 } as const;
const revisionProperty = { type: 'integer', minimum: 0 } as const;

export function createPiWebReviewExtension(
  projectPath: string,
  sessionId: string,
  deps: ReviewExtensionDependencies = dependencies,
): InlineExtension {
  return {
    name: 'pi-web-review',
    factory: (pi) => registerReviewExtension(pi, projectPath, sessionId, deps),
  };
}

function registerReviewExtension(pi: ExtensionAPI, projectPath: string, sessionId: string, deps: ReviewExtensionDependencies) {
  pi.registerTool({
    name: 'pi_web_review_list',
    label: 'List Pi Web review threads',
    description: 'List review threads for this Pi Web project and durable session. Use cursors to paginate and includeHandled only when prior handled revisions are relevant.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cursor: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        path: stringProperty,
        includeHandled: { type: 'boolean' },
      },
    } as any,
    execute: async (_toolCallId, params) => toolResult(await listReviewThreads(projectPath, sessionId, params as ListParams, deps)),
  });

  pi.registerTool({
    name: 'pi_web_review_reply',
    label: 'Reply to Pi Web review thread',
    description: 'Reply to a review thread in this session, optionally resolving it. handlesUserRevision must be the exact user revision being handled; stale revisions are rejected.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['threadId', 'body', 'handlesUserRevision'],
      properties: {
        threadId: stringProperty,
        body: stringProperty,
        handlesUserRevision: revisionProperty,
        resolve: { type: 'boolean' },
      },
    } as any,
    execute: async (_toolCallId, params) => {
      const input = params as ReplyParams;
      return mutationToolResult(await deps.addAgentReviewReply(projectPath, sessionId, input), input.threadId);
    },
  });

  pi.registerTool({
    name: 'pi_web_review_create',
    label: 'Create Pi Web review thread',
    description: 'Create a location-specific agent review thread in this project and session. Supply the exact selected text and up to three immediately adjacent context lines from the file version you inspected; set staged=true only when anchoring to the staged/index version. Stale anchors are rejected.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'startLine', 'endLine', 'selectedText', 'contextBefore', 'contextAfter', 'body'],
      properties: {
        path: stringProperty,
        staged: { type: 'boolean' },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
        selectedText: stringProperty,
        contextBefore: { type: 'array', maxItems: 3, items: { type: 'string' } },
        contextAfter: { type: 'array', maxItems: 3, items: { type: 'string' } },
        body: stringProperty,
      },
    } as any,
    execute: async (_toolCallId, params) => mutationToolResult(await deps.createAgentReviewThread(projectPath, sessionId, params as CreateParams)),
  });

  pi.registerTool({
    name: 'pi_web_review_resolve',
    label: 'Resolve Pi Web review thread',
    description: 'Resolve a review thread in this session, optionally adding a final reply. handlesUserRevision must be exact; backend conflict errors are returned to the model.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['threadId', 'handlesUserRevision'],
      properties: {
        threadId: stringProperty,
        handlesUserRevision: revisionProperty,
        body: stringProperty,
      },
    } as any,
    execute: async (_toolCallId, params) => {
      const input = params as ResolveParams;
      return mutationToolResult(await deps.resolveAgentReviewThread(projectPath, sessionId, input), input.threadId);
    },
  });

  pi.registerCommand('pi-web-review', {
    description: 'Review unstaged changes and session review threads',
    handler: async () => {
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...REVIEW_TOOL_NAMES])]);
      const [status, pending, allThreads] = await Promise.all([
        deps.getGitStatus(projectPath),
        deps.getPendingReviewThreads(projectPath, sessionId),
        deps.getReviewThreads(projectPath, sessionId),
      ]);
      pi.sendUserMessage(buildReviewPrompt(status, pending, allThreads));
    },
  });
}

async function listReviewThreads(
  projectPath: string,
  sessionId: string,
  params: ListParams,
  deps: ReviewExtensionDependencies,
) {
  const result = params.includeHandled
    ? await deps.getReviewThreads(projectPath, sessionId)
    : await deps.getPendingReviewThreads(projectPath, sessionId);
  const threads = reviewItems(result).filter((thread) => {
    if (params.includeHandled && reviewItemStatus(thread) === 'resolved') return false;
    return !params.path || reviewItemPath(thread) === params.path;
  });
  const offset = Number.parseInt(params.cursor ?? '0', 10);
  const limit = params.limit ?? 20;
  const page: unknown[] = [];
  let size = 512;
  for (const thread of threads.slice(offset, offset + limit)) {
    const bounded = boundedReviewItem(thread);
    const itemSize = stringify(bounded).length;
    if (page.length && size + itemSize > MAX_PROMPT_CHARS) break;
    page.push(bounded);
    size += itemSize;
  }
  return {
    ...(!Array.isArray(result) && result && typeof result === 'object' && 'revision' in result
      ? { revision: (result as { revision?: unknown }).revision }
      : {}),
    threads: page,
    total: threads.length,
    ...(offset + page.length < threads.length ? { nextCursor: String(offset + page.length) } : {}),
    ...(page.some(isTruncatedReviewItem) ? { truncated: true } : {}),
  };
}

function toolResult(details: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: stringify(details) }],
    details,
  };
}

function mutationToolResult(details: unknown, threadId?: string): ToolResult {
  const threads = reviewItems(details);
  const thread = threadId
    ? threads.find((item) => reviewItemId(item) === threadId)
    : threads.at(-1);
  const revision = !Array.isArray(details) && details && typeof details === 'object'
    ? (details as Record<string, unknown>).revision
    : undefined;
  const summary = {
    success: true,
    ...(revision !== undefined ? { revision } : {}),
    ...(thread ? { thread: boundedReviewItem(thread) } : {}),
    note: 'Mutation succeeded. Use pi_web_review_list for the current paginated thread collection.',
  };
  return {
    content: [{ type: 'text', text: stringify(summary) }],
    details: summary,
  };
}

function buildReviewPrompt(
  status: Awaited<ReturnType<typeof getGitStatus>>,
  pendingResult: unknown,
  allThreadsResult: unknown,
) {
  const unstagedFiles = status.files.filter((file) => file.unstaged);
  const pending = reviewItems(pendingResult);
  const allThreads = reviewItems(allThreadsResult);
  const pendingIds = new Set(pending.map(reviewItemId).filter((id): id is string => Boolean(id)));
  const otherThreads = allThreads.filter((thread) => {
    const id = reviewItemId(thread);
    return !id || !pendingIds.has(id);
  });
  const fileSummary = unstagedFileSummary(unstagedFiles);
  const prefix = [
    'Review the current Pi Web worktree and its durable-session review threads.',
    '',
    'Scope and behavior:',
    '- Review only current unstaged and untracked changes. Do not review staged-only changes; for partially staged files, inspect only the unstaged diff.',
    '- Use the normal configured workspace tools to inspect diffs and files. This snapshot deliberately does not inline file contents.',
    '- Respond primarily in chat with concise, prioritized, actionable findings. Use Pi Web inline review tools only when a location-specific discussion is more useful than chat.',
    '- Check existing threads before creating a finding so you do not duplicate one. Address pending user revisions with a reply or resolution only when useful.',
    '- Set handlesUserRevision to the exact latestUserRevision shown by pi_web_review_list; backend conflict validation will reject stale revisions or invalid anchors.',
    '- When using pi_web_review_create, pass the exact selectedText plus up to three immediately preceding and following context lines from the file version you inspected.',
    '- Your normal configured model, agent profile, tools, actions, and optional delegation remain available. You may delegate if configured, but do not assume or force a reviewer subagent.',
    '- Stay in chat after the review is complete.',
    '',
    `Unstaged/untracked files (${unstagedFiles.length}; showing ${fileSummary.lines.length}):`,
    ...(fileSummary.lines.length ? fileSummary.lines : ['- None.']),
  ].join('\n');
  const selected = selectThreadContext(pending, otherThreads, MAX_PROMPT_CHARS - prefix.length - 4_096);
  const omittedThreads = pending.length - selected.pending.length + otherThreads.length - selected.other.length;
  const pagination = [paginationSummary(pendingResult), paginationSummary(allThreadsResult)].filter(Boolean).join('; ');
  const footer = [
    `Context limits: at most ${MAX_PROMPT_THREADS} threads, ${MAX_THREAD_CHARS} characters per thread, ${MAX_FILE_SUMMARY_CHARS} characters of file summaries, and ${MAX_PROMPT_CHARS} characters total. Use pi_web_review_list with cursor/limit/path to paginate.`,
    `Truncation/pagination: ${fileSummary.omitted} file(s) and ${omittedThreads} locally available thread(s) omitted${pagination ? `; backend metadata: ${pagination}` : ''}.`,
  ];
  return [
    prefix,
    '',
    `Pending user-thread revisions (${pending.length}; showing ${selected.pending.length}):`,
    ...(selected.pending.length ? selected.pending : ['- None.']),
    '',
    `Other existing threads (${otherThreads.length}; showing ${selected.other.length}):`,
    ...(selected.other.length ? selected.other : ['- None.']),
    '',
    ...footer,
  ].join('\n');
}

function unstagedFileSummary(files: Awaited<ReturnType<typeof getGitStatus>>['files']) {
  const lines: string[] = [];
  let size = 0;
  for (const file of files) {
    const stats = [`+${file.unstagedAdditions ?? 0}`, `-${file.unstagedDeletions ?? 0}`].join('/');
    const line = `- ${stringify(file.path)} [${file.status}; ${stats}${file.oldPath ? `; from ${stringify(file.oldPath)}` : ''}]`;
    if (lines.length && size + line.length + 1 > MAX_FILE_SUMMARY_CHARS) break;
    lines.push(line);
    size += line.length + 1;
  }
  return { lines, omitted: files.length - lines.length };
}

function selectThreadContext(pending: unknown[], other: unknown[], maxChars: number) {
  const selected = { pending: [] as string[], other: [] as string[] };
  let size = 0;
  let count = 0;
  let full = false;
  for (const [items, target] of [[pending, selected.pending], [other, selected.other]] as const) {
    if (full) break;
    for (const item of items) {
      if (count >= MAX_PROMPT_THREADS) {
        full = true;
        break;
      }
      const line = threadLines([item])[0];
      if (size + line.length + 1 > maxChars) {
        full = true;
        break;
      }
      target.push(line);
      size += line.length + 1;
      count += 1;
    }
  }
  return selected;
}

function reviewItems(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') return [];
  for (const key of ['threads', 'items', 'results']) {
    const value = (result as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function reviewItemId(item: unknown) {
  if (!item || typeof item !== 'object') return undefined;
  const record = item as Record<string, unknown>;
  const id = record.id ?? record.threadId;
  return typeof id === 'string' ? id : undefined;
}

function reviewItemPath(item: unknown) {
  if (!item || typeof item !== 'object') return undefined;
  const record = item as Record<string, unknown>;
  if (typeof record.path === 'string') return record.path;
  const anchor = record.anchor;
  return anchor && typeof anchor === 'object' && typeof (anchor as Record<string, unknown>).path === 'string'
    ? (anchor as Record<string, unknown>).path as string
    : undefined;
}

function reviewItemStatus(item: unknown) {
  if (!item || typeof item !== 'object') return undefined;
  const status = (item as Record<string, unknown>).status;
  return typeof status === 'string' ? status : undefined;
}

function boundedReviewItem(item: unknown): unknown {
  const serialized = stringify(item);
  if (serialized.length <= MAX_THREAD_CHARS) return item;
  const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
  const anchor = record.anchor && typeof record.anchor === 'object' ? record.anchor as Record<string, unknown> : {};
  const messages = Array.isArray(record.messages) ? record.messages.slice(-4).map((message) => {
    if (!message || typeof message !== 'object') return message;
    const entry = message as Record<string, unknown>;
    return {
      id: entry.id,
      author: entry.author,
      userRevision: entry.userRevision,
      handlesUserRevision: entry.handlesUserRevision,
      createdAt: entry.createdAt,
      body: boundedText(entry.body, 1_200),
    };
  }) : undefined;
  return {
    id: reviewItemId(item),
    anchor: {
      path: reviewItemPath(item),
      startLine: anchor.startLine ?? record.startLine,
      endLine: anchor.endLine ?? record.endLine,
      selectedText: boundedText(anchor.selectedText, 1_500),
    },
    status: record.status,
    outdated: record.outdated,
    outdatedReason: record.outdatedReason,
    latestUserRevision: record.latestUserRevision,
    ...(messages ? { messages, messagesShown: messages.length, messagesTotal: record.messages instanceof Array ? record.messages.length : messages.length } : {}),
    ...(typeof record.body === 'string' ? { body: boundedText(record.body, 1_200) } : {}),
    truncated: true,
  };
}

function boundedText(value: unknown, maxSerializedChars: number) {
  if (typeof value !== 'string' || stringify(value).length <= maxSerializedChars) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (stringify(`${value.slice(0, middle)}…`).length <= maxSerializedChars) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}…`;
}

function isTruncatedReviewItem(item: unknown) {
  return Boolean(item && typeof item === 'object' && (item as Record<string, unknown>).truncated === true);
}

function threadLines(threads: unknown[]) {
  if (!threads.length) return ['- None.'];
  return threads.map((thread) => {
    const bounded = boundedReviewItem(thread);
    return `- ${stringify(bounded)}${isTruncatedReviewItem(bounded) ? ' [thread truncated; call pi_web_review_list for current details]' : ''}`;
  });
}

function paginationSummary(result: unknown) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
  const record = result as Record<string, unknown>;
  return ['nextCursor', 'cursor', 'hasMore', 'total', 'truncated']
    .filter((key) => record[key] !== undefined)
    .map((key) => `${key}=${stringify(record[key])}`)
    .join(', ');
}

function stringify(value: unknown) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
