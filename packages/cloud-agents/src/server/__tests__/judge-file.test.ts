const { evaluateDecisionModelMock } = vi.hoisted(() => ({
  evaluateDecisionModelMock: vi.fn(),
}));

vi.mock('../typesafe-judgment', () => ({
  evaluateDecisionModel: evaluateDecisionModelMock,
}));

import { evaluateJudgeFileCriteria } from '../judge-file';

describe('evaluateJudgeFileCriteria', () => {
  const state = {
    path: 'apps/web/src/Example.tsx',
    patch: '+<p>Save your work.</p>',
    patchTruncated: false,
    finalContent: '<p>Save your work.</p>',
    finalContentTruncated: false,
  };

  beforeEach(() => {
    evaluateDecisionModelMock.mockReset();
  });

  it('uses independent platform-owned Choice questions and preserves confidence/probabilities', async () => {
    evaluateDecisionModelMock.mockResolvedValue({
      criterion_0: {
        type: 'choice',
        choice: 'rewrite',
        confidence: 0.93,
        probabilities: { pass: 0.02, rewrite: 0.93, unclear: 0.05 },
      },
      criterion_1: {
        type: 'choice',
        choice: 'pass',
        confidence: 0.88,
        probabilities: { pass: 0.88, rewrite: 0.04, unclear: 0.08 },
      },
    });

    const result = await evaluateJudgeFileCriteria({
      state,
      criteria: [
        {
          id: 'criterion_0',
          rule: 'Do not describe functionality in UI text.',
        },
        { id: 'criterion_1', rule: 'Use sentence case.' },
      ],
    });

    expect(result).toEqual([
      {
        id: 'criterion_0',
        outcome: 'rewrite',
        confidence: 0.93,
        probabilities: { pass: 0.02, rewrite: 0.93, unclear: 0.05 },
      },
      {
        id: 'criterion_1',
        outcome: 'pass',
        confidence: 0.88,
        probabilities: { pass: 0.88, rewrite: 0.04, unclear: 0.08 },
      },
    ]);

    expect(evaluateDecisionModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'judge-file-criterion',
        highVolume: true,
        skipShadow: true,
        state: expect.objectContaining({
          ...state,
          criteria: expect.any(Array),
        }),
        questions: {
          criterion_0: expect.objectContaining({ type: 'choice' }),
          criterion_1: expect.objectContaining({ type: 'choice' }),
        },
      }),
    );
  });

  it('returns null when no judgment backend is configured', async () => {
    evaluateDecisionModelMock.mockResolvedValue(null);

    await expect(
      evaluateJudgeFileCriteria({
        state,
        criteria: [{ id: 'criterion_0', rule: 'Use sentence case.' }],
      }),
    ).resolves.toBeNull();
  });
});
