const { mockGenerateTrackedNonTaskObject, mockEvaluateTypeSafeJudgments } =
  vi.hoisted(() => ({
    mockGenerateTrackedNonTaskObject: vi.fn(),
    mockEvaluateTypeSafeJudgments: vi.fn(),
  }));

vi.mock('../typesafe-judgment', () => ({
  evaluateTypeSafeJudgments: mockEvaluateTypeSafeJudgments,
}));

vi.mock('../non-task-provider-usage', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../non-task-provider-usage')>();

  return {
    ...actual,
    generateTrackedNonTaskObject: mockGenerateTrackedNonTaskObject,
  };
});

import {
  classifyRequestedWorkKindFromPrompt,
  resolveRequestedWorkKindDecision,
} from '../requested-work-kind';

describe('requested work kind classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEvaluateTypeSafeJudgments.mockResolvedValue(null);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses explicit bootstrap overrides before classification', async () => {
    const decision = await resolveRequestedWorkKindDecision({
      prompt: 'Build the feature',
      bootstrapSkill: 'plan-repo-implementation',
    });

    expect(decision).toEqual({
      kind: 'plan',
      source: 'explicit_bootstrap',
      confidence: 1,
    });
    expect(mockGenerateTrackedNonTaskObject).not.toHaveBeenCalled();
  });

  it('uses task-tool overrides before classification', async () => {
    const decision = await resolveRequestedWorkKindDecision({
      prompt: 'Anything',
      taskToolActionId: 'review-code',
    });

    expect(decision).toEqual({
      kind: 'question',
      source: 'task_tool',
      confidence: 1,
    });
    expect(mockGenerateTrackedNonTaskObject).not.toHaveBeenCalled();
  });

  it('classifies prompt text with the dedicated classifier', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValueOnce({
      object: {
        kind: 'implement',
        confidence: 0.93,
      },
    } as never);

    const decision = await classifyRequestedWorkKindFromPrompt(
      'Fix the flaky login test',
    );

    expect(decision).toEqual({
      kind: 'implement',
      source: 'llm_classifier',
      confidence: 0.93,
    });
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining(
          'use implementation straightforwardness as the tiebreaker',
        ),
        timeoutMs: 5_000,
      }),
    );
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining(
          'connected-system action asks that do not require repository or workspace changes',
        ),
      }),
    );
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining(
          'choose implement when any part of the request asks to modify repository or workspace state, run commands in the repository or workspace, validate changes, or deliver code, even when another part asks for external investigation',
        ),
      }),
    );
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining(
          '"Check Better Stack and fix the failure" is implement',
        ),
      }),
    );
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining(
          '"Inspect Sentry, then patch the crash" is implement',
        ),
      }),
    );
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining(
          '"Check Better Stack and tell me what failed" is question',
        ),
      }),
    );
    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining(
          '"Run a Sentry query and report the results" is question',
        ),
      }),
    );
  });

  it('nulls classifier confidence when it is out of range', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValueOnce({
      object: {
        kind: 'implement',
        confidence: 2,
      },
    } as never);

    const decision = await classifyRequestedWorkKindFromPrompt(
      'Fix the flaky login test',
    );

    expect(decision).toEqual({
      kind: 'implement',
      source: 'llm_classifier',
      confidence: null,
    });
  });

  it('falls back to system default when classification fails', async () => {
    mockGenerateTrackedNonTaskObject.mockRejectedValueOnce(
      new Error('timeout'),
    );

    const decision = await resolveRequestedWorkKindDecision({
      prompt: 'Investigate the auth flow',
    });

    expect(decision).toEqual({
      kind: 'unknown',
      source: 'system_default',
      confidence: null,
    });
  });

  it('uses a confident judgment-model answer without the helper model', async () => {
    mockEvaluateTypeSafeJudgments.mockResolvedValueOnce({
      kind: {
        type: 'choice',
        choice: 'implement',
        probabilities: {
          question: 0.05,
          plan: 0.04,
          implement: 0.9,
          unknown: 0.01,
        },
        confidence: 0.86,
      },
    });

    const decision = await resolveRequestedWorkKindDecision({
      prompt: 'Check Better Stack and fix the failure',
    });

    expect(decision).toEqual({
      kind: 'implement',
      source: 'llm_classifier',
      confidence: 0.86,
    });
    expect(mockGenerateTrackedNonTaskObject).not.toHaveBeenCalled();
  });

  it('defers to the helper model when the judgment model is unsure or fails', async () => {
    mockEvaluateTypeSafeJudgments
      .mockResolvedValueOnce({
        kind: {
          type: 'choice',
          choice: 'plan',
          probabilities: {
            question: 0.3,
            plan: 0.36,
            implement: 0.3,
            unknown: 0.04,
          },
          confidence: 0.12,
        },
      })
      .mockRejectedValueOnce(
        new Error('TypeSafe request failed with HTTP 429'),
      );
    mockGenerateTrackedNonTaskObject.mockResolvedValue({
      object: { kind: 'question', confidence: 0.7 },
    } as never);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const decision = await resolveRequestedWorkKindDecision({
        prompt: 'Look into the auth flow',
      });

      expect(decision).toEqual({
        kind: 'question',
        source: 'llm_classifier',
        confidence: 0.7,
      });
    }

    expect(mockGenerateTrackedNonTaskObject).toHaveBeenCalledTimes(2);
  });
});
