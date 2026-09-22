const mockEvaluateTypeSafeJudgments = vi.hoisted(() => vi.fn());

vi.mock('../typesafe-judgment', () => ({
  evaluateTypeSafeJudgments: mockEvaluateTypeSafeJudgments,
}));

import {
  deriveCustomAutomationJudgmentSpec,
  type CustomAutomationJudgmentSpec,
} from '@roomote/types';

import { evaluateCustomAutomationResultJudgment } from '../custom-automation-judgment';

describe('evaluateCustomAutomationResultJudgment', () => {
  const spec = deriveCustomAutomationJudgmentSpec(
    'Review deployment logs and summarize the actionable failures.',
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('evaluates the persisted question over bounded redacted state', async () => {
    mockEvaluateTypeSafeJudgments.mockResolvedValue({
      goal_addressed: { type: 'noul', noul: 0.84 },
    });

    await expect(
      evaluateCustomAutomationResultJudgment({
        spec,
        result: `API_KEY=super-secret-value\n${'result '.repeat(2_000)}`,
        timeoutMs: 1_500,
      }),
    ).resolves.toEqual({
      specVersion: 1,
      questionId: 'goal_addressed',
      answer: { type: 'noul', noul: 0.84 },
    });

    expect(mockEvaluateTypeSafeJudgments).toHaveBeenCalledWith({
      state: {
        goal: spec.goal,
        result: expect.not.stringContaining('super-secret-value'),
      },
      questions: { goal_addressed: spec.question },
      timeoutMs: 1_500,
    });
    const state = mockEvaluateTypeSafeJudgments.mock.calls[0]![0].state as {
      result: string;
    };
    expect(state.result.length).toBeLessThanOrEqual(6_000);
  });

  it.each([
    ['no backend', null],
    ['a malformed answer', { goal_addressed: { type: 'noul', noul: 2 } }],
  ])(
    'abstains on %s without changing the caller contract',
    async (_label, answer) => {
      mockEvaluateTypeSafeJudgments.mockResolvedValue(answer);

      await expect(
        evaluateCustomAutomationResultJudgment({ spec, result: 'No result.' }),
      ).resolves.toBeNull();
    },
  );

  it('abstains when the judgment request fails', async () => {
    mockEvaluateTypeSafeJudgments.mockRejectedValue(new Error('timeout'));

    await expect(
      evaluateCustomAutomationResultJudgment({
        spec: spec as CustomAutomationJudgmentSpec,
        result: 'The run completed.',
      }),
    ).resolves.toBeNull();
  });

  it('abstains on a malformed persisted specification', async () => {
    await expect(
      evaluateCustomAutomationResultJudgment({
        spec: { ...spec, questionId: 'unexpected' },
        result: 'The run completed.',
      }),
    ).resolves.toBeNull();
    expect(mockEvaluateTypeSafeJudgments).not.toHaveBeenCalled();
  });
});
