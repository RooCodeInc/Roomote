import { beforeEach, describe, expect, it, vi } from 'vitest';

const evaluate = vi.hoisted(() => vi.fn());
vi.mock('../typesafe-judgment', () => ({ evaluateDecisionModel: evaluate }));

import { chooseAdaptiveReasoningEffort } from '../adaptive-reasoning-effort';

const input = {
  request: 'Investigate a difficult race condition',
  modelId: 'openai/test',
  surface: 'task' as const,
  fallback: 'medium' as const,
  model: {
    id: 'openai/test',
    displayName: 'Test',
    family: 'Test',
    metadata: {
      contextWindow: null,
      inputTypes: null,
      inputPricePerToken: null,
      outputPricePerToken: null,
      lastRefreshedAt: null,
      supportsReasoning: true,
    },
  },
};

describe('chooseAdaptiveReasoningEffort', () => {
  beforeEach(() => evaluate.mockReset());

  it('selects once at a launch boundary with high-volume judgment and bounded input', async () => {
    evaluate.mockResolvedValue({
      effort: { choice: 'high', confidence: 0.91 },
    });
    expect(
      await chooseAdaptiveReasoningEffort({
        ...input,
        request: 'x'.repeat(10_000),
      }),
    ).toBe('high');
    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        highVolume: true,
        timeoutMs: 2_000,
        state: { request: 'x'.repeat(4_000), surface: 'task' },
      }),
    );
  });

  it('restricts choices to model-supported efforts', async () => {
    evaluate.mockResolvedValue({
      effort: { choice: 'max', confidence: 0.99 },
    });
    const selected = await chooseAdaptiveReasoningEffort({
      ...input,
      model: {
        id: input.modelId,
        displayName: 'Test',
        family: 'Test',
        metadata: {
          contextWindow: null,
          inputTypes: null,
          inputPricePerToken: null,
          outputPricePerToken: null,
          lastRefreshedAt: null,
          supportedReasoningEfforts: ['low', 'high'],
        },
      },
    });
    expect(selected).toBe('medium');
    expect(
      Object.keys(evaluate.mock.calls[0]![0].questions.effort.criteria),
    ).toEqual(['default', 'low', 'high']);
  });

  it('keeps the configured effort for abstention, low confidence, failure or no backend', async () => {
    for (const answer of [
      null,
      { effort: { choice: 'default', confidence: 0.99 } },
      { effort: { choice: 'max', confidence: 0.79 } },
    ]) {
      evaluate.mockResolvedValueOnce(answer);
      expect(await chooseAdaptiveReasoningEffort(input)).toBe('medium');
    }
    evaluate.mockRejectedValueOnce(new Error('timeout'));
    expect(await chooseAdaptiveReasoningEffort(input)).toBe('medium');
  });

  it('never judges a model known not to support reasoning', async () => {
    expect(
      await chooseAdaptiveReasoningEffort({
        ...input,
        model: {
          id: input.modelId,
          displayName: 'Test',
          family: 'Test',
          metadata: {
            contextWindow: null,
            inputTypes: null,
            inputPricePerToken: null,
            outputPricePerToken: null,
            lastRefreshedAt: null,
            supportsReasoning: false,
          },
        },
      }),
    ).toBe('medium');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('keeps defaults when capability metadata is missing', async () => {
    expect(
      await chooseAdaptiveReasoningEffort({
        request: input.request,
        modelId: input.modelId,
        surface: 'session',
        fallback: 'medium',
      }),
    ).toBe('medium');
    expect(evaluate).not.toHaveBeenCalled();
  });
});
