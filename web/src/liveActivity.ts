export type AgentToolActivity = { id: string; name: string; status: 'running' | 'done' | 'error'; summary?: string };
export type AgentActivityTextKind = 'text' | 'thinking';
export type AgentActivityTextItem = { type: 'text'; text: string };
export type AgentActivityThinkingItem = { type: 'thinking'; text: string };
export type AgentActivityContentItem = AgentActivityTextItem | AgentActivityThinkingItem;
export type AgentActivityDelta = AgentActivityContentItem & { contentIndex?: number };
export type AgentActivityToolItem = { type: 'tool'; tool: AgentToolActivity };
export type AgentActivityItem = AgentActivityContentItem | AgentActivityToolItem;
export type AgentRetryActivity = { attempt?: number; maxAttempts?: number; delayMs?: number; errorMessage?: string };
export type AgentActivity = { running: boolean; streaming: boolean; error?: string; text: string; thinking: string; tools: AgentToolActivity[]; items: AgentActivityItem[]; notices: string[]; deltaContentKeys: string[]; retry?: AgentRetryActivity };
export type AgentServerEvent = { type?: string; operationId?: string; message?: string; data?: unknown };

const LIVE_ACTIVITY_TEXT_MAX_LENGTH = 8_000;

export function emptyAgentActivity(): AgentActivity {
  return { running: false, streaming: false, text: '', thinking: '', tools: [], items: [], notices: [], deltaContentKeys: [] };
}

export function retireAgentActivityPreview(activity: AgentActivity): AgentActivity {
  return {
    ...emptyAgentActivity(),
    running: activity.running,
    notices: activity.notices,
    ...(activity.retry ? { retry: activity.retry } : {}),
  };
}

export function appendLivePreviewText(current: string, delta: string, maxLength: number) {
  const next = `${current}${delta}`;
  if (next.length <= maxLength) return next;
  return `…\n${next.slice(Math.max(0, next.length - maxLength))}`;
}

function livePreviewText(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `…\n${value.slice(Math.max(0, value.length - maxLength))}`;
}

function appendLiveActivityTextItem(items: AgentActivityItem[], type: AgentActivityTextKind, text: string): AgentActivityItem[] {
  const previous = items[items.length - 1];
  const nextText = previous?.type === type ? appendLivePreviewText(previous.text, text, LIVE_ACTIVITY_TEXT_MAX_LENGTH) : livePreviewText(text, LIVE_ACTIVITY_TEXT_MAX_LENGTH);
  const nextItem: AgentActivityContentItem = type === 'text' ? { type: 'text', text: nextText } : { type: 'thinking', text: nextText };
  return previous?.type === type ? [...items.slice(0, -1), nextItem] : [...items, nextItem];
}

function appendLiveActivityTextSegment(activity: AgentActivity, type: AgentActivityTextKind, text: string): AgentActivity {
  if (!text) return activity;
  return {
    ...activity,
    text: type === 'text' ? appendLivePreviewText(activity.text, text, LIVE_ACTIVITY_TEXT_MAX_LENGTH) : activity.text,
    thinking: type === 'thinking' ? appendLivePreviewText(activity.thinking, text, LIVE_ACTIVITY_TEXT_MAX_LENGTH) : activity.thinking,
    items: appendLiveActivityTextItem(activity.items, type, text),
  };
}

function liveActivityContentKey(type: AgentActivityTextKind, contentIndex: unknown) {
  if (typeof contentIndex === 'number' && Number.isInteger(contentIndex) && contentIndex >= 0) return `${type}:${contentIndex}`;
  return contentIndex === undefined ? `${type}:unindexed` : undefined;
}

export function appendLiveActivityDelta(activity: AgentActivity, delta: AgentActivityDelta): AgentActivity {
  const next = appendLiveActivityTextSegment(activity, delta.type, delta.text);
  const key = liveActivityContentKey(delta.type, delta.contentIndex);
  return !key || activity.deltaContentKeys.includes(key) ? next : { ...next, deltaContentKeys: [...activity.deltaContentKeys, key] };
}

function liveActivityHasDelta(activity: AgentActivity, type: AgentActivityTextKind, contentIndex: unknown) {
  const key = liveActivityContentKey(type, contentIndex);
  if (key && activity.deltaContentKeys.includes(key)) return true;
  if (contentIndex === undefined) return activity.deltaContentKeys.some((item) => item.startsWith(`${type}:`));
  return activity.deltaContentKeys.includes(`${type}:unindexed`);
}

function upsertLiveActivityToolItem(items: AgentActivityItem[], tool: AgentToolActivity): AgentActivityItem[] {
  const index = items.findIndex((item) => item.type === 'tool' && item.tool.id === tool.id);
  if (index === -1) return [...items, { type: 'tool', tool }];
  const next = [...items];
  next[index] = { type: 'tool', tool };
  return next;
}

export function shouldUseOptimizedStreamingRender(activity: AgentActivity, enabled: boolean) {
  return enabled && activity.running && activity.streaming;
}

export function reduceAgentActivityEvent(activity: AgentActivity, event: AgentServerEvent): AgentActivity {
  if (event.type === 'agent:start') return { ...emptyAgentActivity(), running: true };
  if (event.type === 'agent:finish') return { ...activity, running: false, streaming: false, retry: undefined };
  if (event.type === 'agent:error' || event.type === 'error') {
    const message = event.message ?? 'Agent failed';
    if (/already processing/i.test(message) && activity.running) return { ...activity, notices: [...activity.notices, message] };
    return { ...activity, running: false, streaming: false, retry: undefined, error: message === 'Request was aborted' ? 'Operation aborted' : message };
  }
  if (event.type === 'agent:notice') return { ...activity, notices: [...activity.notices, event.message ?? 'notice'] };
  if (event.type !== 'agent:event' || !event.data || typeof event.data !== 'object') return activity;

  const data = event.data as Record<string, unknown>;
  const type = typeof data.type === 'string' ? data.type : '';
  if (type === 'agent_start') return { ...emptyAgentActivity(), running: true, streaming: true };
  if (type === 'message_start') {
    const message = data.message && typeof data.message === 'object' ? data.message as { role?: unknown } : undefined;
    return message?.role === 'assistant' ? { ...activity, deltaContentKeys: [] } : activity;
  }
  if (type === 'agent_end') {
    const willRetry = data.willRetry === true;
    return { ...activity, running: true, streaming: false, error: willRetry ? undefined : activity.error, retry: willRetry ? activity.retry : undefined };
  }
  if (type === 'message_update') {
    const messageEvent = data.assistantMessageEvent && typeof data.assistantMessageEvent === 'object' ? data.assistantMessageEvent as Record<string, unknown> : {};
    let next = activity;
    if (messageEvent.type === 'text_delta' && typeof messageEvent.delta === 'string' && messageEvent.delta) next = appendLiveActivityDelta(next, { type: 'text', text: messageEvent.delta, contentIndex: typeof messageEvent.contentIndex === 'number' ? messageEvent.contentIndex : undefined });
    if (messageEvent.type === 'thinking_delta' && typeof messageEvent.delta === 'string' && messageEvent.delta) next = appendLiveActivityDelta(next, { type: 'thinking', text: messageEvent.delta, contentIndex: typeof messageEvent.contentIndex === 'number' ? messageEvent.contentIndex : undefined });
    if (messageEvent.type === 'text_end' && !liveActivityHasDelta(next, 'text', messageEvent.contentIndex) && typeof messageEvent.content === 'string') next = appendLiveActivityTextSegment(next, 'text', messageEvent.content);
    if (messageEvent.type === 'thinking_end' && !liveActivityHasDelta(next, 'thinking', messageEvent.contentIndex) && typeof messageEvent.content === 'string') next = appendLiveActivityTextSegment(next, 'thinking', messageEvent.content);
    return { ...next, running: true, streaming: true };
  }
  if (type === 'tool_execution_start' || type === 'tool_execution_update' || type === 'tool_execution_end') {
    const tools = new Map(activity.tools.map((tool) => [tool.id, tool]));
    const id = String(data.toolCallId ?? data.toolName ?? tools.size);
    const name = String(data.toolName ?? 'tool');
    const existing = tools.get(id);
    const tool: AgentToolActivity = {
      id,
      name,
      status: type === 'tool_execution_end' ? (data.isError ? 'error' : 'done') : 'running',
      summary: toolActivitySummary(data) ?? existing?.summary,
    };
    tools.set(id, tool);
    return { ...activity, running: true, streaming: true, tools: [...tools.values()], items: upsertLiveActivityToolItem(activity.items, tool) };
  }
  if (type === 'notice') return { ...activity, notices: [...activity.notices, String(data.message ?? 'notice')] };
  if (type === 'auto_retry_start') {
    const attempt = typeof data.attempt === 'number' && Number.isFinite(data.attempt) ? data.attempt : undefined;
    const maxAttempts = typeof data.maxAttempts === 'number' && Number.isFinite(data.maxAttempts) ? data.maxAttempts : undefined;
    const delayMs = typeof data.delayMs === 'number' && Number.isFinite(data.delayMs) ? data.delayMs : undefined;
    const errorMessage = String(data.errorMessage ?? 'provider error');
    const attemptText = attempt && maxAttempts ? ` (${attempt}/${maxAttempts})` : attempt ? ` (${attempt})` : '';
    const delayText = delayMs ? ` in ${Math.ceil(delayMs / 1000)}s` : '';
    return { ...activity, running: true, retry: { attempt, maxAttempts, delayMs, errorMessage }, notices: [...activity.notices, `retrying${attemptText}${delayText} after ${errorMessage}`] };
  }
  if (type === 'auto_retry_end') {
    const failed = data.success !== true;
    return { ...activity, retry: undefined, notices: [...activity.notices, data.success ? 'retry succeeded' : `retry failed ${data.finalError ?? ''}`], running: true, streaming: failed ? false : activity.streaming };
  }
  if (type === 'compaction_start') return { ...activity, running: true, notices: [...activity.notices, 'compacting context'] };
  if (type === 'compaction_end') {
    const willRetry = data.willRetry === true;
    return {
      ...activity,
      running: true,
      streaming: willRetry ? activity.streaming : false,
      retry: willRetry ? activity.retry : undefined,
      notices: [...activity.notices, data.aborted ? 'compaction aborted' : 'compaction finished'],
    };
  }
  return activity;
}

function toolActivitySummary(data: Record<string, unknown>) {
  const args = data.args && typeof data.args === 'object' ? data.args : undefined;
  if (args && 'command' in args && typeof (args as { command?: unknown }).command === 'string') return (args as { command: string }).command;
  if (args && 'path' in args && typeof (args as { path?: unknown }).path === 'string') return (args as { path: string }).path;
  if (args && 'file_path' in args && typeof (args as { file_path?: unknown }).file_path === 'string') return (args as { file_path: string }).file_path;
  if (args) return JSON.stringify(args).slice(0, 160);
  return undefined;
}
