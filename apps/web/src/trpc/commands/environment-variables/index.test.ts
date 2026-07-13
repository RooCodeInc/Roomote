import type { FeatureFlag } from '@roomote/feature-flags';

import type { UserAuthSuccess } from '@/types';

const { mockFinalChain, mockInArray } = vi.hoisted(() => ({
  mockFinalChain: vi.fn(),
  mockInArray: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          orderBy: mockFinalChain,
        }),
      }),
    })),
  },
  environmentVariables: { name: 'env.name', userId: 'env.user_id' },
  eq: vi.fn(),
  desc: vi.fn(),
  inArray: mockInArray,
  not: vi.fn(),
  getTableColumns: () => ({ id: 'env.id', name: 'env.name' }),
}));

import {
  createEnvVarCommand,
  deleteDeploymentEnvironmentVariables,
  getEnvVarsCommand,
} from './index';

function buildMockAuth(
  overrides: Partial<UserAuthSuccess> = {},
): UserAuthSuccess {
  return {
    success: true,
    userType: 'user',
    userId: 'env-test-user',
    isAdmin: true,
    name: 'Env Tester',
    primaryEmail: 'env@example.com',
    featureFlags: {} as Record<FeatureFlag, boolean>,
    resource: {
      username: 'env-tester',
      fullName: 'Env Tester',
      firstName: 'Env',
      lastName: 'Tester',
      primaryEmailAddress: { id: '1', emailAddress: 'env@example.com' },
      emailAddresses: [{ id: '1', emailAddress: 'env@example.com' }],
      imageUrl: '',
      createdAt: new Date(),
    },
    ...overrides,
  } as UserAuthSuccess;
}

describe('environment-variables commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getEnvVarsCommand', () => {
    it('rejects non-admin users', async () => {
      await expect(
        getEnvVarsCommand(buildMockAuth({ isAdmin: false })),
      ).rejects.toThrow('Unauthorized');
    });

    it('applies a where clause (excludes comms provider env var names)', async () => {
      mockFinalChain.mockResolvedValue([]);

      await getEnvVarsCommand(buildMockAuth());

      expect(mockFinalChain).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteDeploymentEnvironmentVariables', () => {
    it('deletes each named deployment value once', async () => {
      const where = vi.fn().mockResolvedValue(undefined);
      const executor = {
        delete: vi.fn(() => ({ where })),
      } as unknown as Parameters<
        typeof deleteDeploymentEnvironmentVariables
      >[0];

      await deleteDeploymentEnvironmentVariables(executor, [
        ' ADO_BASE_URL ',
        'ADO_BASE_URL',
        '',
      ]);

      expect(mockInArray).toHaveBeenCalledWith('env.name', ['ADO_BASE_URL']);
      expect(executor.delete).toHaveBeenCalledTimes(1);
      expect(where).toHaveBeenCalledTimes(1);
    });
  });

  describe('createEnvVarCommand', () => {
    it('rejects reserved comms provider variable names', async () => {
      await expect(
        createEnvVarCommand(buildMockAuth(), {
          name: 'R_SLACK_CLIENT_SECRET',
          value: 'secret',
        }),
      ).rejects.toThrow(
        'is a reserved communications provider variable. Configure it under Settings → Communications.',
      );
    });

    it('rejects alternate accepted comms variable names', async () => {
      await expect(
        createEnvVarCommand(buildMockAuth(), {
          name: 'R_SLACK_CLIENT_ID',
          value: 'client-id',
        }),
      ).rejects.toThrow(
        'is a reserved communications provider variable. Configure it under Settings → Communications.',
      );
    });
  });
});
