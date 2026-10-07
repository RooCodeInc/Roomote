import {
  getTaskModelReasoningEfforts,
  normalizeTaskModelReasoningAlias,
  resolveTaskModelReasoningEffort,
} from '../task-model-reasoning';
import { buildOpenCodeModelReasoningOptions } from '../opencode-reasoning';
import type { TaskModelMetadata } from '../task-models';

const metadata: TaskModelMetadata = {
  contextWindow: null,
  inputTypes: null,
  inputPricePerToken: null,
  outputPricePerToken: null,
  lastRefreshedAt: null,
  supportsReasoning: true,
  supportedReasoningEfforts: ['max', 'high', 'low', 'high'],
};

describe('task model reasoning capabilities', () => {
  it.each([
    'openrouter/deepseek/deepseek-v4.1-flash',
    'vercel/deepseek/deepseek-v4.1-flash',
    'vercel/deepseek/deepseek-v4.1-flash-beta',
    'deepseek/deepseek-flash',
    'opencode-go/deepseek-v4.1-flash',
    'opencode-go/deepseek-flash',
  ])(
    'preserves DeepSeek alias intent in UI and provider options for %s',
    (modelId) => {
      const efforts = getTaskModelReasoningEfforts(modelId, metadata);
      expect(efforts).toEqual(['low', 'high', 'max']);
      expect(getTaskModelReasoningEfforts(modelId)).toEqual(efforts);
      for (const effort of ['medium', 'xhigh'] as const) {
        expect(resolveTaskModelReasoningEffort(modelId, effort, efforts)).toBe(
          'high',
        );
        expect(buildOpenCodeModelReasoningOptions(modelId, effort)).toEqual(
          modelId.startsWith('openrouter/')
            ? { reasoning: { effort: 'high' } }
            : { reasoningEffort: 'high' },
        );
      }
      for (const effort of ['low', 'high', 'max'] as const) {
        expect(normalizeTaskModelReasoningAlias(modelId, effort)).toBe(effort);
      }
      expect(
        resolveTaskModelReasoningEffort(modelId, null, efforts),
      ).toBeNull();
      expect(
        getTaskModelReasoningEfforts(modelId, {
          ...metadata,
          supportsReasoning: false,
        }),
      ).toEqual([]);
    },
  );

  it('canonicalizes stale alias metadata and respects empty capabilities', () => {
    const modelId = 'openrouter/deepseek/deepseek-v4.1-flash';
    expect(
      getTaskModelReasoningEfforts(modelId, {
        ...metadata,
        supportedReasoningEfforts: ['max', 'xhigh', 'high', 'medium', 'low'],
      }),
    ).toEqual(['low', 'high', 'max']);
    expect(
      getTaskModelReasoningEfforts(modelId, {
        ...metadata,
        supportedReasoningEfforts: [],
      }),
    ).toEqual([]);
  });

  it('does not change other models or invent capabilities for older DeepSeek models', () => {
    for (const modelId of [
      'openai/gpt-6.1-sol',
      'openrouter/deepseek/deepseek-v3.2',
    ]) {
      expect(normalizeTaskModelReasoningAlias(modelId, 'medium')).toBe(
        'medium',
      );
      expect(getTaskModelReasoningEfforts(modelId)).toEqual([
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
      expect(
        resolveTaskModelReasoningEffort(modelId, 'medium', [
          'low',
          'medium',
          'high',
        ]),
      ).toBe('medium');
    }
    expect(
      resolveTaskModelReasoningEffort('other/model', 'max', [
        'low',
        'medium',
        'high',
        'xhigh',
      ]),
    ).toBe('xhigh');
    expect(
      resolveTaskModelReasoningEffort('other/model', 'medium', ['low', 'high']),
    ).toBe('low');
  });
});
