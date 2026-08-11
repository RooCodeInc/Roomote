const { mockGenerateTrackedNonTaskObject } = vi.hoisted(() => ({
  mockGenerateTrackedNonTaskObject: vi.fn(),
}));

vi.mock('../../non-task-provider-usage', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../non-task-provider-usage')>();

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
          'choose implement when any part of the request asks to modify repository or workspace state, run commands, validate changes, or deliver code, even when another part asks for external investigation',
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
});
