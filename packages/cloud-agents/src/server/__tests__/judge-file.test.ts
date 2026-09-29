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

describe('evaluateRepositoryJudgement', () => {
  it('uses the shared rubric and validates answers', async () => {
    const { evaluateRepositoryJudgement } = await import('../judge-file');
    const request = {
      kind: 'judge' as const,
      rule: 'Use sentence case',
      evidence: [],
      focusPaths: ['example.ts'],
      complete: true,
      unresolved: [],
    };
    evaluateDecisionModelMock.mockResolvedValue({
      result: { type: 'choice', choice: 'violation', confidence: 0.97 },
    });
    expect(await evaluateRepositoryJudgement(request)).toEqual({
      outcome: 'violation',
      confidence: 0.97,
    });
    expect(evaluateDecisionModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        state: request,
        decision: 'repository-judgement',
        timeoutMs: 2500,
        skipShadow: true,
        questions: { result: expect.objectContaining({ type: 'choice' }) },
      }),
    );
    evaluateDecisionModelMock.mockResolvedValue({
      result: { choice: 'invented', confidence: 1 },
    });
    await expect(evaluateRepositoryJudgement(request)).rejects.toThrow(
      'Invalid judgment',
    );
  });
  it('does not send oversized evidence and reports absent backends', async () => {
    const { evaluateRepositoryJudgement } = await import('../judge-file');
    const request = {
      kind: 'judge' as const,
      rule: 'x'.repeat(40000),
      evidence: [],
      focusPaths: [],
      complete: true,
      unresolved: [],
    };
    evaluateDecisionModelMock.mockClear();
    await expect(evaluateRepositoryJudgement(request)).rejects.toThrow(
      'budget',
    );
    expect(evaluateDecisionModelMock).not.toHaveBeenCalled();
    evaluateDecisionModelMock.mockResolvedValue(null);
    expect(
      await evaluateRepositoryJudgement({
        ...request,
        rule: 'Use sentence case',
      }),
    ).toBeNull();
  });
});
