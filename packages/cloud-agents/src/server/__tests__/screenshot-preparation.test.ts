const { mockEvaluate } = vi.hoisted(() => ({
  mockEvaluate: vi.fn(),
}));

vi.mock('../typesafe-judgment', () => ({
  evaluateTypeSafeJudgmentsWithMetadata: mockEvaluate,
}));

import {
  resetScreenshotPreparationState,
  prepareScreenshotStep,
} from '../screenshot-preparation';

const page = {
  url: 'http://localhost:3000/settings',
  title: 'Settings',
  visibleText: 'Profile settings Save',
  readyState: 'complete' as const,
  viewport: {
    width: 1280,
    height: 800,
    scrollX: 0,
    scrollY: 0,
    documentWidth: 1280,
    documentHeight: 1200,
  },
  controls: [
    {
      id: '@e1',
      role: 'textbox',
      name: 'Display name',
      value: '',
      rect: { x: 100, y: 120, width: 300, height: 40 },
    },
    {
      id: '@e2',
      role: 'textbox',
      name: 'API key',
      value: 'secret-value',
      sensitive: true,
    },
  ],
};

const fillAction = {
  id: 'fill_name',
  kind: 'fill' as const,
  targetId: '@e1',
  value: 'Roomote',
};

const readyAction = { id: 'capture', kind: 'capture-ready' as const };

function nextInput(
  allowedActions: (typeof fillAction)[] | (typeof readyAction)[],
  loopId?: string,
  correction?: {
    reason: string;
    requiredStates: string[];
    rejectedActionId?: string;
  },
) {
  return {
    operation: 'next' as const,
    optIn: true,
    ...(loopId ? { loopId } : {}),
    evidenceGoal: 'Show the saved settings state.',
    page,
    allowedActions,
    ...(correction ? { correction } : {}),
  };
}

describe('bounded screenshot preparation', () => {
  beforeEach(() => {
    resetScreenshotPreparationState();
    mockEvaluate.mockReset();
  });

  it('falls back when the deployment flag is disabled or the caller did not opt in', async () => {
    await expect(
      prepareScreenshotStep({
        runId: 'run-1',
        enabled: false,
        input: nextInput([fillAction]),
      }),
    ).resolves.toMatchObject({
      status: 'fallback',
      reason: 'prototype_disabled',
    });

    await expect(
      prepareScreenshotStep({
        runId: 'run-1',
        enabled: true,
        input: { ...nextInput([fillAction]), optIn: false },
      }),
    ).resolves.toMatchObject({ status: 'fallback', reason: 'not_opted_in' });
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  it('returns only an allowed action and carries timing and token metrics through acceptance', async () => {
    let currentTime = 1_000;
    mockEvaluate
      .mockResolvedValueOnce({
        answers: {
          next_action: {
            type: 'choice',
            choice: 'fill_name',
            probabilities: { fallback: 0.05, fill_name: 0.95 },
            confidence: 0.95,
          },
        },
        usage: { inputTokens: 90, outputTokens: 12 },
      })
      .mockResolvedValueOnce({
        answers: {
          next_action: {
            type: 'choice',
            choice: 'capture',
            probabilities: { fallback: 0.02, capture: 0.98 },
            confidence: 0.98,
          },
        },
        usage: { inputTokens: 80, outputTokens: 10 },
      });

    const first = await prepareScreenshotStep({
      runId: 'run-1',
      enabled: true,
      input: nextInput([fillAction]),
      now: () => currentTime,
    });
    expect(first).toMatchObject({
      status: 'running',
      action: fillAction,
      metrics: {
        actionsUsed: 1,
        inputTokens: 90,
        outputTokens: 12,
        usageReported: true,
      },
    });
    expect(mockEvaluate.mock.calls[0]![0].state.page.controls[1].value).toBe(
      '[redacted]',
    );
    const loopId = first.loopId!;

    currentTime += 250;
    const ready = await prepareScreenshotStep({
      runId: 'run-1',
      enabled: true,
      input: nextInput([readyAction], loopId),
      now: () => currentTime,
    });
    expect(ready).toMatchObject({
      status: 'ready',
      action: readyAction,
      metrics: { actionsUsed: 2, inputTokens: 170, outputTokens: 22 },
    });

    currentTime += 400;
    const accepted = await prepareScreenshotStep({
      runId: 'run-1',
      enabled: true,
      input: { operation: 'record', optIn: false, loopId, outcome: 'accepted' },
      now: () => currentTime,
    });
    expect(accepted).toMatchObject({
      status: 'accepted',
      metrics: {
        timeToAcceptedScreenshotMs: 650,
        acceptanceRate: 1,
        falseAcceptanceCount: 0,
      },
    });
  });

  it('uses one specific visual correction and then stops after the recapture budget', async () => {
    mockEvaluate
      .mockResolvedValueOnce({
        answers: {
          next_action: {
            type: 'choice',
            choice: 'capture',
            probabilities: { fallback: 0.01, capture: 0.99 },
            confidence: 0.99,
          },
        },
      })
      .mockResolvedValueOnce({
        answers: {
          next_action: {
            type: 'choice',
            choice: 'capture',
            probabilities: { fallback: 0.01, capture: 0.99 },
            confidence: 0.99,
          },
        },
      });

    const ready = await prepareScreenshotStep({
      runId: 'run-1',
      enabled: true,
      input: nextInput([readyAction]),
    });
    const loopId = ready.loopId!;

    const recapture = await prepareScreenshotStep({
      runId: 'run-1',
      enabled: true,
      input: {
        operation: 'record',
        optIn: false,
        loopId,
        outcome: 'rejected',
        correction: {
          reason: 'The dialog is not visible.',
          requiredStates: ['Dialog heading visible'],
        },
      },
    });
    expect(recapture).toMatchObject({
      status: 'recapture_required',
      metrics: { falseAcceptanceCount: 1 },
    });

    const readyAgain = await prepareScreenshotStep({
      runId: 'run-1',
      enabled: true,
      input: nextInput([readyAction], loopId),
    });
    expect(readyAgain).toMatchObject({
      status: 'ready',
      metrics: { recapturesUsed: 1 },
    });

    await expect(
      prepareScreenshotStep({
        runId: 'run-1',
        enabled: true,
        input: {
          operation: 'record',
          optIn: false,
          loopId,
          outcome: 'rejected',
          correction: {
            reason: 'Still not visible.',
            requiredStates: ['Dialog heading visible'],
          },
        },
      }),
    ).resolves.toMatchObject({
      status: 'fallback',
      reason: 'recapture_budget_exhausted',
    });
  });

  it('falls back instead of executing a low-confidence choice', async () => {
    mockEvaluate.mockResolvedValueOnce({
      answers: {
        next_action: {
          type: 'choice',
          choice: 'fill_name',
          probabilities: { fallback: 0.48, fill_name: 0.52 },
          confidence: 0.52,
        },
      },
    });

    await expect(
      prepareScreenshotStep({
        runId: 'run-1',
        enabled: true,
        input: nextInput([fillAction]),
      }),
    ).resolves.toMatchObject({ status: 'fallback', reason: 'low_confidence' });
  });
});
