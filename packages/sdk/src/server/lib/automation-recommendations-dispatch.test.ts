import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRunAutomationNow,
  mockRunCustomAutomationNow,
  mockSelectResults,
  mockTransaction,
} = vi.hoisted(() => ({
  mockRunAutomationNow: vi.fn(),
  mockRunCustomAutomationNow: vi.fn(),
  mockSelectResults: [] as unknown[][],
  mockTransaction: vi.fn(),
}));

vi.mock('../automations/run-now', () => ({
  runAutomationNow: (...args: unknown[]) => mockRunAutomationNow(...args),
}));

vi.mock('../automations/custom-automations', () => ({
  runCustomAutomationNow: (...args: unknown[]) =>
    mockRunCustomAutomationNow(...args),
}));

vi.mock('@roomote/db/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/db/server')>();
  const tx = {
    execute: vi.fn(),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => mockSelectResults.shift() ?? []),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    })),
  };
  mockTransaction.mockImplementation(
    async (callback: (executor: typeof tx) => Promise<unknown>) => callback(tx),
  );
  return {
    ...actual,
    db: { transaction: mockTransaction },
  };
});

import { runAutomationRecommendationInitialRunJob } from './automation-recommendations';

const claimedAt = '2026-09-02T16:00:00.000Z';
const baseBatch = {
  version: 1 as const,
  inputFingerprint: 'fingerprint-1',
  catalogVersion: 1,
  status: 'ready' as const,
  startedAt: claimedAt,
  completedAt: claimedAt,
  partial: false,
  errorCode: null,
  dismissed: false,
  applicationState: 'applied' as const,
  recommendations: [
    {
      id: 'recommendation-1',
      candidateId: 'built-in.ci-failure-triage',
      rank: 1,
      score: 1,
      explanation: 'Triage failed CI runs.',
      enabled: true,
      lastRunTaskId: null,
      automationId: null,
      applied: true,
      initialRunClaimedAt: null,
      initialRunDispatchAttemptedAt: null,
      initialRunTerminalAt: null,
    },
  ],
};

describe('automation recommendation dispatch fence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(claimedAt));
    mockSelectResults.length = 0;
  });

  afterEach(() => vi.useRealTimers());

  it('does not dispatch when setup completes after claim but before admission', async () => {
    mockSelectResults.push(
      [
        {
          setupCompletedAt: null,
          setupNewState: { automationRecommendations: baseBatch },
        },
      ],
      [
        {
          setupCompletedAt: null,
          setupNewState: {
            automationRecommendations: {
              ...baseBatch,
              recommendations: baseBatch.recommendations.map((item) => ({
                ...item,
                initialRunClaimedAt: claimedAt,
              })),
            },
          },
        },
      ],
      [{ setupCompletedAt: new Date(claimedAt) }],
      [
        {
          setupCompletedAt: new Date(claimedAt),
          setupNewState: { automationRecommendations: baseBatch },
        },
      ],
    );

    await runAutomationRecommendationInitialRunJob({
      fingerprint: 'fingerprint-1',
      recommendationId: 'recommendation-1',
    });

    expect(mockRunAutomationNow).not.toHaveBeenCalled();
    expect(mockRunCustomAutomationNow).not.toHaveBeenCalled();
    expect(mockTransaction).toHaveBeenCalledTimes(4);
  });
});
