import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  completeSetupCommandMock,
  getSourceControlConnectionSummaryMock,
  isSetupComputeReadyForCompletionMock,
} = vi.hoisted(() => ({
  completeSetupCommandMock: vi.fn(),
  getSourceControlConnectionSummaryMock: vi.fn(),
  isSetupComputeReadyForCompletionMock: vi.fn(),
}));

vi.mock('./index', () => ({
  completeSetupCommand: (...args: unknown[]) =>
    completeSetupCommandMock(...args),
}));

vi.mock('@/lib/server/source-control', () => ({
  getSourceControlConnectionSummary: getSourceControlConnectionSummaryMock,
}));

vi.mock('../compute', () => ({
  isSetupComputeReadyForCompletion: isSetupComputeReadyForCompletionMock,
}));

import type { UserAuthSuccess } from '@/types';
import {
  completeConversationalSetupIfReady,
  isConversationalSetupReadyForCompletion,
} from './setup-session-completion';

const auth = { userId: 'admin-1' } as UserAuthSuccess;

function buildStatus(
  overrides: {
    setupCompletedAt?: Date | null;
    modelReady?: boolean;
    computeReady?: boolean;
    sourceControlReady?: boolean;
    repositoryCount?: number;
  } = {},
) {
  return {
    setupCompletedAt: overrides.setupCompletedAt ?? null,
    modelSetup: { setupSatisfied: overrides.modelReady ?? true },
    computeSetup: { setupSatisfied: overrides.computeReady ?? true },
    sourceControlSetup: {
      setupSatisfied: overrides.sourceControlReady ?? true,
      providers: [
        {
          connected: overrides.sourceControlReady ?? true,
          repositoryCount: overrides.repositoryCount ?? 1,
        },
      ],
    },
  } as Parameters<typeof isConversationalSetupReadyForCompletion>[0];
}

describe('completeConversationalSetupIfReady', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    completeSetupCommandMock.mockResolvedValue({
      success: true,
      completionState: 'completed',
    });
    getSourceControlConnectionSummaryMock.mockResolvedValue({
      repositoryCounts: { github: 1 },
    });
    isSetupComputeReadyForCompletionMock.mockResolvedValue(true);
  });

  it('rechecks compute readiness inside the locked completion transaction', async () => {
    const tx = { id: 'completion-transaction' };
    isSetupComputeReadyForCompletionMock.mockResolvedValue(false);
    completeSetupCommandMock.mockImplementation(
      async (_auth, _input, options) => ({
        success: true,
        completionState: (await options.validateBeforeCompletion(tx))
          ? 'completed'
          : 'not_ready',
      }),
    );

    await expect(
      completeConversationalSetupIfReady(auth, buildStatus()),
    ).resolves.toBe(false);

    expect(isSetupComputeReadyForCompletionMock).toHaveBeenCalledWith(tx);
    expect(getSourceControlConnectionSummaryMock).toHaveBeenCalledWith(tx);
  });

  it('completes setup once prerequisites and repository synchronization are ready without starter work', async () => {
    await expect(
      completeConversationalSetupIfReady(auth, buildStatus()),
    ).resolves.toBe(true);

    expect(completeSetupCommandMock).toHaveBeenCalledOnce();
    expect(completeSetupCommandMock).toHaveBeenCalledWith(
      auth,
      undefined,
      expect.objectContaining({
        requireIncomplete: true,
        validateBeforeCompletion: expect.any(Function),
      }),
    );
  });

  it.each([
    ['inference', { modelReady: false }],
    ['compute', { computeReady: false }],
    ['source-control configuration', { sourceControlReady: false }],
    ['repository synchronization', { repositoryCount: 0 }],
    [
      'an already completed deployment',
      { setupCompletedAt: new Date('2026-01-01T00:00:00.000Z') },
    ],
  ])(
    'does not complete setup before %s is ready',
    async (_label, overrides) => {
      await expect(
        completeConversationalSetupIfReady(auth, buildStatus(overrides)),
      ).resolves.toBe(false);

      expect(completeSetupCommandMock).not.toHaveBeenCalled();
    },
  );
});
