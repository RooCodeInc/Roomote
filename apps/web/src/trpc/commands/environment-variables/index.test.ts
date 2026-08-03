import type { UserAuthSuccess } from '@/types';

const { mockFinalChain, mockGetModelProviderNames } = vi.hoisted(() => ({
  mockFinalChain: vi.fn(),
  mockGetModelProviderNames: vi.fn().mockResolvedValue([]),
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
  inArray: vi.fn(),
  not: vi.fn(),
  getTableColumns: () => ({ id: 'env.id', name: 'env.name' }),
  getPersistedModelProviderEnvironmentVariableNames: mockGetModelProviderNames,
}));

import { createEnvVarCommand, getEnvVarsCommand } from './index';

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
    mockGetModelProviderNames.mockResolvedValue([]);
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

    it('excludes model-provider and named OpenAI-compatible values', async () => {
      mockFinalChain.mockResolvedValue([
        { id: 'task', name: 'MY_APP_TOKEN' },
        { id: 'model', name: 'TOGETHER_API_KEY' },
        {
          id: 'custom-model',
          name: 'OPENAI_COMPATIBLE_COMPANY_PROXY_API_KEY',
        },
        { id: 'declared-custom', name: 'CUSTOM_LLM_TOKEN' },
      ]);
      mockGetModelProviderNames.mockResolvedValue(['CUSTOM_LLM_TOKEN']);

      await expect(getEnvVarsCommand(buildMockAuth())).resolves.toEqual([
        { id: 'task', name: 'MY_APP_TOKEN' },
      ]);
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

    it('reserves model-provider variable names during dual-write rollout', async () => {
      await expect(
        createEnvVarCommand(buildMockAuth(), {
          name: 'TOGETHER_API_KEY',
          value: 'task-key',
        }),
      ).rejects.toThrow(
        'is reserved for model-provider configuration during the compatibility rollout',
      );
    });

    it('reserves custom names declared by model-provider configuration', async () => {
      mockGetModelProviderNames.mockResolvedValue(['CUSTOM_LLM_TOKEN']);

      await expect(
        createEnvVarCommand(buildMockAuth(), {
          name: 'CUSTOM_LLM_TOKEN',
          value: 'task-key',
        }),
      ).rejects.toThrow(
        'is reserved for model-provider configuration during the compatibility rollout',
      );
    });
  });
});
