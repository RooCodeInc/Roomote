import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSubscribe,
  mockRequestInstancePing,
  mockCaptureEvent,
  mockCaptureActivationSetupCompleted,
  mockEnsureManagedReviewer,
  mockTransaction,
  mockGetSetupBaseStatus,
} = vi.hoisted(() => ({
  mockSubscribe: vi.fn(),
  mockRequestInstancePing: vi.fn(),
  mockCaptureEvent: vi.fn(),
  mockCaptureActivationSetupCompleted: vi.fn(),
  mockEnsureManagedReviewer: vi.fn(),
  mockGetSetupBaseStatus: vi.fn().mockResolvedValue({ setupNewState: null }),
  mockTransaction: vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
    callback({
      execute: vi.fn(),
      insert: () => ({
        values: () => ({ onConflictDoUpdate: vi.fn() }),
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
  deploymentSettings: { id: 'deployment-settings.id' },
  users: { id: 'users.id' },
  eq: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@roomote/types', () => ({
  TaskPayloadKind: { McpRecommendations: 'mcp-recommendations' },
  normalizeSetupNewState: () => ({
    onboardingTaskId: null,
    onboardingTaskStartedAt: null,
    slackChannel: null,
    selectedRepositoryIds: [],
  }),
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
  Env: { R_CLOUD_ENABLED: false },
  isRoomoteCloudEnabled: () => false,
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
});
