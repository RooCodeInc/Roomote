import { beforeEach, describe, expect, it, vi } from 'vitest';

const { completeSetupCommandMock } = vi.hoisted(() => ({
  completeSetupCommandMock: vi.fn(),
}));

vi.mock('./index', () => ({
  completeSetupCommand: (...args: unknown[]) =>
    completeSetupCommandMock(...args),
}));

vi.mock('@/lib/server/source-control', () => ({
  getSourceControlConnectionSummary: vi.fn(),
}));

import type { UserAuthSuccess } from '@/types';
import { createSetupNewSetupSession } from '@roomote/types';
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
    sourceControlSkipped?: boolean;
    integrationDiscoveryComplete?: boolean;
    starterTaskIds?: Array<'speed-up-ci' | 'security-scan'> | null;
  } = {},
) {
  const setupSession = createSetupNewSetupSession({ sessionId: 'session-1' });
  setupSession.integrationDiscoveryCompletedAt =
    overrides.integrationDiscoveryComplete === false
      ? null
      : '2026-01-01T00:00:00.000Z';
  setupSession.sourceControlSkippedAt = overrides.sourceControlSkipped
    ? '2026-01-01T00:00:00.000Z'
    : null;
  setupSession.starterTaskSelection =
    overrides.starterTaskIds === null
      ? null
      : {
          requestId: 'starter-request',
          taskIds: overrides.starterTaskIds ?? [],
          selectedAt: '2026-01-01T00:01:00.000Z',
        };
  return {
    setupCompletedAt: overrides.setupCompletedAt ?? null,
    setupNewState: { setupSession },
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
  });

  it('completes synchronized setup after an empty starter decision without a sandbox', async () => {
    await expect(
      completeConversationalSetupIfReady(
        auth,
        buildStatus({ computeReady: false }),
      ),
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
    ['integration discovery', { integrationDiscoveryComplete: false }],
    ['starter decision', { starterTaskIds: null }],
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

  it('completes the no-source path after source and integration skips without a sandbox', () => {
    expect(
      isConversationalSetupReadyForCompletion(
        buildStatus({
          computeReady: false,
          sourceControlReady: false,
          repositoryCount: 0,
          sourceControlSkipped: true,
          starterTaskIds: null,
        }),
      ),
    ).toBe(true);
  });

  it('waits for sandbox readiness and every selected launch attempt', () => {
    const status = buildStatus({
      computeReady: false,
      starterTaskIds: ['speed-up-ci', 'security-scan'],
    });
    expect(
      isConversationalSetupReadyForCompletion(status, [
        'speed-up-ci',
        'security-scan',
      ]),
    ).toBe(false);

    status.computeSetup.setupSatisfied = true;
    expect(
      isConversationalSetupReadyForCompletion(status, ['speed-up-ci']),
    ).toBe(false);
    expect(
      isConversationalSetupReadyForCompletion(status, [
        'speed-up-ci',
        'security-scan',
      ]),
    ).toBe(true);
  });
});
