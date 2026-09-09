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
import type { DatabaseOrTransaction } from '@roomote/db/server';
import { getSourceControlConnectionSummary } from '@/lib/server/source-control';
import { assertSetupStarterWorkReady } from './setup-starter-readiness';
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
    optionalSourceControlEnabled?: boolean;
  } = {},
) {
  return {
    setupCompletedAt: overrides.setupCompletedAt ?? null,
    optionalSourceControlEnabled:
      overrides.optionalSourceControlEnabled ?? false,
    setupNewState: { setupSession: null },
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

  it('completes with no source connection or repositories when opted in', async () => {
    await expect(
      completeConversationalSetupIfReady(
        auth,
        buildStatus({
          optionalSourceControlEnabled: true,
          sourceControlReady: false,
          repositoryCount: 0,
        }),
      ),
    ).resolves.toBe(true);
    expect(completeSetupCommandMock).toHaveBeenCalledOnce();
  });

  it.each([
    { modelReady: false },
    { computeReady: false },
    { setupCompletedAt: new Date('2026-01-01') },
  ])(
    'preserves required readiness and completed deployments when opted in: %j',
    async (overrides) => {
      await expect(
        completeConversationalSetupIfReady(
          auth,
          buildStatus({
            optionalSourceControlEnabled: true,
            sourceControlReady: false,
            repositoryCount: 0,
            ...overrides,
          }),
        ),
      ).resolves.toBe(false);
      expect(completeSetupCommandMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    [true, true],
    [false, false],
    [undefined, true],
    ['true', true],
  ])(
    'rechecks the persisted source-control policy under the completion lock (%j)',
    async (flag, expected) => {
      const tx = {
        query: {
          deploymentSettings: {
            findFirst: vi.fn().mockResolvedValue({
              metadata: { optional_source_control_enabled: flag },
            }),
          },
        },
      } as unknown as DatabaseOrTransaction;
      completeSetupCommandMock.mockImplementation(
        async (_auth, _input, options) => ({
          completionState: (await options.validateBeforeCompletion(tx))
            ? 'completed'
            : 'not_ready',
        }),
      );
      await expect(
        completeConversationalSetupIfReady(
          auth,
          buildStatus({
            optionalSourceControlEnabled: true,
            sourceControlReady: false,
            repositoryCount: 0,
          }),
        ),
      ).resolves.toBe(expected);
      expect(getSourceControlConnectionSummary).not.toHaveBeenCalled();
    },
  );

  it('retains locked repository validation when the rollout is off', async () => {
    const tx = {
      query: {
        deploymentSettings: {
          findFirst: vi.fn().mockResolvedValue({
            metadata: { optional_source_control_enabled: false },
          }),
        },
      },
    } as unknown as DatabaseOrTransaction;
    vi.mocked(getSourceControlConnectionSummary).mockResolvedValue({
      connectedProviders: [],
      repositoryCounts: {},
    } as Awaited<ReturnType<typeof getSourceControlConnectionSummary>>);
    completeSetupCommandMock.mockImplementation(
      async (_auth, _input, options) => ({
        completionState: (await options.validateBeforeCompletion(tx))
          ? 'completed'
          : 'not_ready',
      }),
    );
    await expect(
      completeConversationalSetupIfReady(auth, buildStatus()),
    ).resolves.toBe(false);
    expect(getSourceControlConnectionSummary).toHaveBeenCalledWith(tx);
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

describe('setup starter readiness with optional source control', () => {
  it.each([
    { sourceControlReady: false, repositoryCount: 0 },
    { sourceControlReady: true, repositoryCount: 0 },
    { sourceControlReady: false, repositoryCount: 1 },
  ])(
    'rejects choosing and launching repository work without access: %j',
    (overrides) => {
      const status = buildStatus({
        optionalSourceControlEnabled: true,
        ...overrides,
      });
      expect(() => assertSetupStarterWorkReady(status)).toThrow(
        'Connect source control',
      );
      expect(() =>
        assertSetupStarterWorkReady(status, {
          requireStarterSelection: true,
          requireCompute: true,
        }),
      ).toThrow('Connect source control');
    },
  );

  it('allows selection after repository sync but keeps selection and compute launch gates', () => {
    const status = buildStatus({ optionalSourceControlEnabled: true });
    expect(() => assertSetupStarterWorkReady(status)).not.toThrow();
    expect(() =>
      assertSetupStarterWorkReady(status, { requireStarterSelection: true }),
    ).toThrow('Choose your first work');
    expect(() =>
      assertSetupStarterWorkReady(
        buildStatus({
          optionalSourceControlEnabled: true,
          computeReady: false,
        }),
        { requireCompute: true },
      ),
    ).toThrow('Set up a sandbox');
  });
});
