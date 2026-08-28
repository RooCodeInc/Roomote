import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSubscribe,
  mockRequestInstancePing,
  mockCaptureEvent,
  mockCaptureActivationSetupCompleted,
  mockEnsureManagedReviewer,
  mockFindDeploymentSettings,
  mockInsertValues,
  mockOnConflictDoUpdate,
  mockInvalidateBrainEnabledCache,
  mockSql,
  mockTransaction,
  mockGetSetupBaseStatus,
  mockEnv,
} = vi.hoisted(() => ({
  mockSubscribe: vi.fn(),
  mockRequestInstancePing: vi.fn(),
  mockCaptureEvent: vi.fn(),
  mockCaptureActivationSetupCompleted: vi.fn(),
  mockEnsureManagedReviewer: vi.fn(),
  mockFindDeploymentSettings: vi.fn(),
  mockInsertValues: vi.fn(),
  mockOnConflictDoUpdate: vi.fn(),
  mockInvalidateBrainEnabledCache: vi.fn(),
  mockSql: vi.fn(() => 'sql-expression'),
  mockGetSetupBaseStatus: vi.fn().mockResolvedValue({ setupNewState: null }),
  mockEnv: { R_CLOUD_ENABLED: false },
  mockTransaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      execute: vi.fn(),
      query: {
        deploymentSettings: {
          findFirst: mockFindDeploymentSettings,
        },
      },
      insert: () => ({
        values: mockInsertValues,
      }),
      update: () => ({
        set: () => ({ where: vi.fn() }),
      }),
    }),
  ),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    transaction: (callback: (tx: unknown) => Promise<void>) =>
      mockTransaction(callback),
  },
  deploymentSettings: {
    id: 'deployment-settings.id',
    brainEnabled: 'deployment-settings.brain-enabled',
  },
  invalidateBrainEnabledCache: () => mockInvalidateBrainEnabledCache(),
  users: { id: 'users.id' },
  eq: vi.fn(),
  sql: mockSql,
}));

vi.mock('@roomote/types', () => ({
  TaskPayloadKind: { McpRecommendations: 'mcp-recommendations' },
  normalizeSetupNewState: (state: Record<string, unknown> | null = {}) => {
    const current = state ?? {};
    return {
      ...current,
      onboardingTaskId: current.onboardingTaskId ?? null,
      onboardingTaskStartedAt: current.onboardingTaskStartedAt ?? null,
      slackChannel: current.slackChannel ?? null,
      selectedRepositoryIds: current.selectedRepositoryIds ?? [],
    };
  },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  AVAILABLE_SETUP_MCP_INTEGRATIONS: [],
  enqueueTask: vi.fn(),
  normalizeEnabledSetupMcpIntegrationIds: vi.fn(),
}));

vi.mock('@roomote/sdk/server/request-instance-ping', () => ({
  requestInstancePing: (...args: unknown[]) => mockRequestInstancePing(...args),
}));

vi.mock('@roomote/telemetry/server', () => ({
  captureEvent: (...args: unknown[]) => mockCaptureEvent(...args),
  captureActivationSetupCompleted: (...args: unknown[]) =>
    mockCaptureActivationSetupCompleted(...args),
}));

vi.mock('@/lib/server/env', () => ({
  Env: mockEnv,
  isRoomoteCloudEnabled: (value: boolean) => value,
}));

vi.mock('@/lib/server/product-updates', () => ({
  subscribeToProductUpdates: (...args: unknown[]) => mockSubscribe(...args),
}));

vi.mock('./shared', () => ({
  assertAdmin: vi.fn(),
  ensureDefaultSetupAgents: vi.fn(),
  getSetupBaseStatus: (...args: unknown[]) => mockGetSetupBaseStatus(...args),
}));

vi.mock('../automations', () => ({
  ensureManagedReviewerEnabledByDefaultInTx: (...args: unknown[]) =>
    mockEnsureManagedReviewer(...args),
}));

import type { UserAuthSuccess } from '@/types';
import { completeSetupCommand } from './index';

function buildAuth(overrides: Partial<UserAuthSuccess> = {}): UserAuthSuccess {
  return {
    success: true,
    userType: 'user',
    userId: 'admin-1',
    name: 'Admin',
    primaryEmail: 'admin@example.com',
    isAdmin: true,
    anonymousAnalyticsEnabled: false,
    cloudEnabled: false,
    resource: {
      username: null,
      fullName: null,
      firstName: null,
      lastName: null,
      primaryEmailAddress: null,
      emailAddresses: [],
      imageUrl: '',
      createdAt: null,
    },
    ...overrides,
  } as UserAuthSuccess;
}

describe('completeSetupCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.R_CLOUD_ENABLED = false;
    mockInsertValues.mockReturnValue({
      onConflictDoUpdate: mockOnConflictDoUpdate,
    });
    mockFindDeploymentSettings.mockResolvedValue(undefined);
  });

  it('defaults Memory without overwriting a concurrent explicit choice', async () => {
    mockEnv.R_CLOUD_ENABLED = true;
    mockFindDeploymentSettings.mockResolvedValue({
      brainEnabled: null,
      metadata: null,
      setupCompletedAt: null,
      setupNewState: null,
    });

    await completeSetupCommand(buildAuth({ cloudEnabled: true }));

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ brainEnabled: true }),
    );
    expect(mockOnConflictDoUpdate).toHaveBeenCalledWith({
      target: 'deployment-settings.id',
      set: expect.objectContaining({ brainEnabled: 'sql-expression' }),
    });
    expect(mockSql).toHaveBeenCalledWith(
      ['coalesce(', ', ', ')'],
      'deployment-settings.brain-enabled',
      true,
    );
    expect(mockInvalidateBrainEnabledCache).toHaveBeenCalledOnce();
  });

  it('enables Memory when hosted setup creates the settings row by upsert', async () => {
    mockEnv.R_CLOUD_ENABLED = true;

    await completeSetupCommand(buildAuth({ cloudEnabled: true }));

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ brainEnabled: true }),
    );
  });

  it.each([false, true])(
    'preserves an explicit Memory selection of %s during hosted setup',
    async (brainEnabled) => {
      mockEnv.R_CLOUD_ENABLED = true;
      mockFindDeploymentSettings.mockResolvedValue({
        brainEnabled,
        metadata: null,
        setupCompletedAt: null,
        setupNewState: null,
      });

      await completeSetupCommand(buildAuth({ cloudEnabled: true }));

      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.not.objectContaining({ brainEnabled: expect.anything() }),
      );
      expect(mockOnConflictDoUpdate).toHaveBeenCalledWith({
        target: 'deployment-settings.id',
        set: expect.not.objectContaining({ brainEnabled: expect.anything() }),
      });
      expect(mockInvalidateBrainEnabledCache).not.toHaveBeenCalled();
    },
  );

  it('does not change the default for a new self-hosted deployment', async () => {
    await completeSetupCommand(buildAuth());

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.not.objectContaining({ brainEnabled: expect.anything() }),
    );
    expect(mockOnConflictDoUpdate).toHaveBeenCalledWith({
      target: 'deployment-settings.id',
      set: expect.not.objectContaining({ brainEnabled: expect.anything() }),
    });
    expect(mockInvalidateBrainEnabledCache).not.toHaveBeenCalled();
  });

  it('does not enable Memory on an existing completed hosted deployment', async () => {
    mockEnv.R_CLOUD_ENABLED = true;
    mockFindDeploymentSettings.mockResolvedValue({
      brainEnabled: null,
      metadata: null,
      setupCompletedAt: new Date('2026-01-01T00:00:00.000Z'),
      setupNewState: null,
    });

    await completeSetupCommand(buildAuth({ cloudEnabled: true }));

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.not.objectContaining({ brainEnabled: expect.anything() }),
    );
    expect(mockOnConflictDoUpdate).toHaveBeenCalledWith({
      target: 'deployment-settings.id',
      set: expect.not.objectContaining({ brainEnabled: expect.anything() }),
    });
    expect(mockInvalidateBrainEnabledCache).not.toHaveBeenCalled();
  });

  it('subscribes by default with the setup source', async () => {
    await completeSetupCommand(buildAuth());

    expect(mockSubscribe).toHaveBeenCalledWith('admin@example.com', 'setup');
  });

  it('does not subscribe after an explicit opt-out', async () => {
    await completeSetupCommand(buildAuth(), { productUpdatesEnabled: false });

    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('excludes Cloud admins', async () => {
    await completeSetupCommand(
      buildAuth({ cloudEnabled: true, isAdmin: true }),
    );

    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('preserves the reviewed automation selection during setup completion', async () => {
    mockFindDeploymentSettings.mockResolvedValue({
      setupNewState: {
        automationRecommendations: { status: 'ready' },
      },
      metadata: null,
    });

    await completeSetupCommand(buildAuth());

    expect(mockEnsureManagedReviewer).not.toHaveBeenCalled();
  });
});
