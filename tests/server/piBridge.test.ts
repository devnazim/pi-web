import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PiBridge } from '../../src/server/piBridge.js';

test('lists refreshed models from the session registry', async () => {
  let refreshes = 0;
  const calls: Array<[string, string | undefined]> = [];
  const bridge = new PiBridge();
  (bridge as any).getCommandSession = async (projectPath: string, sessionId?: string) => {
    calls.push([projectPath, sessionId]);
    return {
      modelRegistry: {
        refresh: () => { refreshes += 1; },
        getAvailable: () => [
          { provider: 'openai', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } },
          { provider: 'ollama', id: 'llama3.1:8b', reasoning: false },
        ],
        getProviderDisplayName: (provider: string) => provider.toUpperCase(),
      },
    };
  };

  const models = await bridge.models('/workspace', 'session-1');

  assert.deepEqual(calls, [['/workspace', 'session-1']]);
  assert.equal(refreshes, 1);
  assert.deepEqual(models, [
    {
      value: 'openai/gpt-5.6-sol',
      label: 'GPT-5.6 Sol · OPENAI',
      provider: 'openai',
      id: 'gpt-5.6-sol',
      reasoning: true,
      thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      value: 'ollama/llama3.1:8b',
      label: 'llama3.1:8b · OLLAMA',
      provider: 'ollama',
      id: 'llama3.1:8b',
      reasoning: false,
      thinkingLevels: ['off'],
    },
  ]);
});
