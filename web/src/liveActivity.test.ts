import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  emptyAgentActivity,
  liveActivityMatchesPersistedPreview,
  reduceAgentActivityEvent,
  retireAgentActivityPreview,
  shouldUseOptimizedStreamingRender,
  type AgentActivity,
  type AgentServerEvent,
} from './liveActivity';

function messageUpdate(assistantMessageEvent: Record<string, unknown>): AgentServerEvent {
  return { type: 'agent:event', data: { type: 'message_update', assistantMessageEvent } };
}

function assistantMessageStart(): AgentServerEvent {
  return { type: 'agent:event', data: { type: 'message_start', message: { role: 'assistant' } } };
}

describe('live agent activity', () => {
  test('stops optimized streaming at agent_end but stays running until the bridge settles', () => {
    let activity = reduceAgentActivityEvent(emptyAgentActivity(), { type: 'agent:event', data: { type: 'agent_start' } });
    activity = reduceAgentActivityEvent(activity, messageUpdate({ type: 'text_delta', delta: 'Final answer', contentIndex: 0 }));
    assert.equal(shouldUseOptimizedStreamingRender(activity, true), true);
    assert.equal(shouldUseOptimizedStreamingRender(activity, false), false);

    activity = reduceAgentActivityEvent(activity, { type: 'agent:event', data: { type: 'agent_end', willRetry: false } });
    assert.equal(activity.running, true);
    assert.equal(activity.streaming, false);
    assert.equal(shouldUseOptimizedStreamingRender(activity, true), false);

    activity = reduceAgentActivityEvent(activity, { type: 'agent:finish' });
    assert.equal(activity.running, false);
    assert.equal(activity.streaming, false);
    assert.equal(activity.text, 'Final answer');
  });

  test('shows a recoverable crash error and clears the running state', () => {
    const active = reduceAgentActivityEvent(emptyAgentActivity(), { type: 'agent:event', data: { type: 'agent_start' } });
    const recovered = reduceAgentActivityEvent(active, {
      type: 'agent:error',
      message: 'Agent stopped responding or crashed. Its session runtime was reset. You can retry or continue.',
    });

    assert.equal(recovered.running, false);
    assert.equal(recovered.streaming, false);
    assert.match(recovered.error ?? '', /retry or continue/i);
  });

  test('keeps terminal text after a tool in its original output position', () => {
    let activity: AgentActivity = reduceAgentActivityEvent(emptyAgentActivity(), { type: 'agent:event', data: { type: 'agent_start' } });
    activity = reduceAgentActivityEvent(activity, messageUpdate({ type: 'text_delta', delta: 'Before tool. ', contentIndex: 0 }));
    activity = reduceAgentActivityEvent(activity, messageUpdate({ type: 'text_end', content: 'Before tool. ', contentIndex: 0 }));
    activity = reduceAgentActivityEvent(activity, { type: 'agent:event', data: { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read' } });
    activity = reduceAgentActivityEvent(activity, assistantMessageStart());
    activity = reduceAgentActivityEvent(activity, messageUpdate({ type: 'text_end', content: 'After tool.', contentIndex: 0 }));
    activity = reduceAgentActivityEvent(activity, { type: 'agent:event', data: { type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'read' } });

    assert.deepEqual(activity.items, [
      { type: 'text', text: 'Before tool. ' },
      { type: 'tool', tool: { id: 'tool-1', name: 'read', status: 'done', summary: undefined } },
      { type: 'text', text: 'After tool.' },
    ]);

    activity = reduceAgentActivityEvent(activity, { type: 'agent:event', data: { type: 'agent_end' } });
    assert.equal(shouldUseOptimizedStreamingRender(activity, true), false);
  });

  test('does not duplicate text already received in deltas', () => {
    let activity = reduceAgentActivityEvent(emptyAgentActivity(), { type: 'agent:event', data: { type: 'agent_start' } });
    activity = reduceAgentActivityEvent(activity, messageUpdate({ type: 'text_delta', delta: 'Hello', contentIndex: 0 }));
    activity = reduceAgentActivityEvent(activity, messageUpdate({ type: 'text_end', content: 'Hello', contentIndex: 0 }));

    assert.deepEqual(activity.items, [{ type: 'text', text: 'Hello' }]);
  });

  test('does not duplicate delta-backed terminal text after a tool', () => {
    let activity = reduceAgentActivityEvent(emptyAgentActivity(), { type: 'agent:event', data: { type: 'agent_start' } });
    activity = reduceAgentActivityEvent(activity, messageUpdate({ type: 'text_delta', delta: 'After tool.', contentIndex: 0 }));
    activity = reduceAgentActivityEvent(activity, { type: 'agent:event', data: { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read' } });
    activity = reduceAgentActivityEvent(activity, messageUpdate({ type: 'text_end', content: 'After tool.', contentIndex: 0 }));

    assert.deepEqual(activity.items, [
      { type: 'text', text: 'After tool.' },
      { type: 'tool', tool: { id: 'tool-1', name: 'read', status: 'running', summary: undefined } },
    ]);
    assert.equal(activity.text, 'After tool.');
  });

  test('does not duplicate text when a provider omits content indexes', () => {
    let activity = reduceAgentActivityEvent(emptyAgentActivity(), { type: 'agent:event', data: { type: 'agent_start' } });
    activity = reduceAgentActivityEvent(activity, messageUpdate({ type: 'text_delta', delta: 'Hello' }));
    activity = reduceAgentActivityEvent(activity, messageUpdate({ type: 'text_end', content: 'Hello' }));

    assert.deepEqual(activity.items, [{ type: 'text', text: 'Hello' }]);
  });

  test('matches persisted final text even when thinking persistence differs', () => {
    const activity = { ...emptyAgentActivity(), text: 'Final answer', thinking: 'Detailed live reasoning' };

    assert.equal(liveActivityMatchesPersistedPreview(activity, { text: 'Final answer', thinking: 'Short persisted reasoning' }, false), true);
    assert.equal(liveActivityMatchesPersistedPreview(activity, { text: 'Different answer', thinking: 'Detailed live reasoning' }, false), false);
  });

  test('requires persisted thinking when a response has no final text', () => {
    const activity = { ...emptyAgentActivity(), thinking: 'Thinking-only response' };

    assert.equal(liveActivityMatchesPersistedPreview(activity, { text: '', thinking: 'Thinking-only response' }, false), true);
    assert.equal(liveActivityMatchesPersistedPreview(activity, { text: '', thinking: 'Different reasoning' }, false), false);
    assert.equal(liveActivityMatchesPersistedPreview(activity, { text: '', thinking: '' }, true), true);
  });

  test('retires persisted response content while preserving completion notices', () => {
    let activity = reduceAgentActivityEvent(emptyAgentActivity(), { type: 'agent:event', data: { type: 'agent_start' } });
    activity = reduceAgentActivityEvent(activity, messageUpdate({ type: 'text_delta', delta: 'Final answer', contentIndex: 0 }));
    activity = reduceAgentActivityEvent(activity, { type: 'agent:event', data: { type: 'auto_retry_end', success: true, attempt: 1 } });
    activity = reduceAgentActivityEvent(activity, { type: 'agent:event', data: { type: 'agent_end', willRetry: false } });
    activity = reduceAgentActivityEvent(activity, { type: 'agent:finish' });

    assert.deepEqual(retireAgentActivityPreview(activity), {
      ...emptyAgentActivity(),
      notices: ['retry succeeded'],
    });
  });

  test('keeps failed retry activity running until the bridge reports the terminal error', () => {
    let activity = reduceAgentActivityEvent(emptyAgentActivity(), { type: 'agent:event', data: { type: 'agent_start' } });
    activity = reduceAgentActivityEvent(activity, { type: 'agent:event', data: { type: 'auto_retry_start', attempt: 1 } });
    activity = reduceAgentActivityEvent(activity, { type: 'agent:event', data: { type: 'auto_retry_end', success: false, finalError: 'provider failed' } });

    assert.equal(activity.running, true);
    assert.equal(activity.streaming, false);

    activity = reduceAgentActivityEvent(activity, { type: 'agent:error', message: 'provider failed' });
    assert.equal(activity.running, false);
  });

  test('keeps post-response compaction active after retiring persisted content', () => {
    let activity = reduceAgentActivityEvent(emptyAgentActivity(), { type: 'agent:event', data: { type: 'agent_start' } });
    activity = reduceAgentActivityEvent(activity, messageUpdate({ type: 'text_delta', delta: 'Final answer', contentIndex: 0 }));
    activity = reduceAgentActivityEvent(activity, { type: 'agent:event', data: { type: 'agent_end', willRetry: false } });
    activity = reduceAgentActivityEvent(activity, { type: 'agent:event', data: { type: 'compaction_start' } });
    activity = reduceAgentActivityEvent(activity, { type: 'agent:event', data: { type: 'compaction_end', aborted: false, willRetry: false } });

    assert.deepEqual(retireAgentActivityPreview(activity), {
      ...emptyAgentActivity(),
      running: true,
      notices: ['compacting context', 'compaction finished'],
    });
  });
});
