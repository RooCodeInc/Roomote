const {
  mockDeploymentSettingsFindFirst,
  mockDeploymentSettingsInsert,
  mockDeploymentSettingsInsertValues,
  mockDeploymentSettingsInsertOnConflictDoNothing,
  mockDeploymentSettingsUpdate,
  mockDeploymentSettingsUpdateSet,
  mockDeploymentSettingsUpdateWhere,
  mockEnv,
} = vi.hoisted(() => ({
  mockDeploymentSettingsFindFirst: vi.fn(),
  mockDeploymentSettingsInsert: vi.fn(),
  mockDeploymentSettingsInsertValues: vi.fn(),
  mockDeploymentSettingsInsertOnConflictDoNothing: vi.fn(),
  mockDeploymentSettingsUpdate: vi.fn(),
  mockDeploymentSettingsUpdateSet: vi.fn(),
  mockDeploymentSettingsUpdateWhere: vi.fn(),
  mockEnv: { R_INSTANCE_ID: undefined as string | undefined },
}));

vi.mock('@roomote/env', () => ({ Env: mockEnv }));

vi.mock('nanoid', () => ({ nanoid: vi.fn(() => 'generated-id') }));

vi.mock('../db', () => ({
  db: {
    query: {
      deploymentSettings: {
        findFirst: (...args: unknown[]) =>
          mockDeploymentSettingsFindFirst(...args),
      },
    },
    insert: (...args: unknown[]) => mockDeploymentSettingsInsert(...args),
    update: (...args: unknown[]) => mockDeploymentSettingsUpdate(...args),
  },
}));

vi.mock('../schema', () => ({
  deploymentSettings: {
    id: 'deploymentSettings.id',
    instanceAnalyticsId: 'deploymentSettings.instanceAnalyticsId',
  },
  users: {},
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
}));

import { getInstanceAnalyticsId } from './telemetry-ids';

describe('getInstanceAnalyticsId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.R_INSTANCE_ID = undefined;

    mockDeploymentSettingsInsert.mockReturnValue({
      values: mockDeploymentSettingsInsertValues,
    });
    mockDeploymentSettingsInsertValues.mockReturnValue({
      onConflictDoNothing: mockDeploymentSettingsInsertOnConflictDoNothing,
    });
    mockDeploymentSettingsUpdate.mockReturnValue({
      set: mockDeploymentSettingsUpdateSet,
    });
    mockDeploymentSettingsUpdateSet.mockReturnValue({
      where: mockDeploymentSettingsUpdateWhere,
    });
    mockDeploymentSettingsInsertOnConflictDoNothing.mockResolvedValue(
      undefined,
    );
    mockDeploymentSettingsUpdateWhere.mockResolvedValue(undefined);
  });

  it('returns the configured instance ID without reading deployment settings', async () => {
    mockEnv.R_INSTANCE_ID = 'cloud-deployment-42';

    await expect(getInstanceAnalyticsId()).resolves.toBe('cloud-deployment-42');
    expect(mockDeploymentSettingsFindFirst).not.toHaveBeenCalled();
    expect(mockDeploymentSettingsInsert).not.toHaveBeenCalled();
    expect(mockDeploymentSettingsUpdate).not.toHaveBeenCalled();
  });

  it('preserves the generated deployment setting fallback when unset', async () => {
    mockDeploymentSettingsFindFirst
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ instanceAnalyticsId: 'generated-id' });

    await expect(getInstanceAnalyticsId()).resolves.toBe('generated-id');
    expect(mockDeploymentSettingsInsertValues).toHaveBeenCalledWith({
      id: 'default',
      instanceAnalyticsId: 'generated-id',
      setupCompletedAt: null,
    });
    expect(mockDeploymentSettingsUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ instanceAnalyticsId: 'generated-id' }),
    );
  });
});
