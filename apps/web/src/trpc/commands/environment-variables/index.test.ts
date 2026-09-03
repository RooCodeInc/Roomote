import type { UserAuthSuccess } from '@/types';

const {
  mockDeleteWhere,
  mockFinalChain,
  mockInsertReturning,
  mockSelectLimit,
  mockUpdateReturning,
} = vi.hoisted(() => ({
  mockDeleteWhere: vi.fn(),
  mockFinalChain: vi.fn(),
  mockInsertReturning: vi.fn(),
  mockSelectLimit: vi.fn(),
  mockUpdateReturning: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          orderBy: mockFinalChain,
          limit: mockSelectLimit,
        }),
      }),
    })),
    transaction: vi.fn(
      async (
        callback: (tx: {
          delete: () => { where: typeof mockDeleteWhere };
        }) => Promise<void>,
      ) => callback({ delete: () => ({ where: mockDeleteWhere }) }),
    ),
    update: vi.fn(() => ({
      set: () => ({
        where: () => ({ returning: mockUpdateReturning }),
      }),
    })),
    insert: vi.fn(() => ({
      values: () => ({ returning: mockInsertReturning }),
    })),
  },
  environmentVariables: {
    id: 'env.id',
    name: 'env.name',
    userId: 'env.user_id',
  },
  eq: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
  not: vi.fn(),
  getTableColumns: () => ({ id: 'env.id', name: 'env.name' }),
}));

import {
  createEnvVarCommand,
  deleteEnvVarCommand,
  getEnvVarsCommand,
  updateEnvVarCommand,
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
    mockDeleteWhere.mockResolvedValue(undefined);
    mockFinalChain.mockResolvedValue([]);
    mockUpdateReturning.mockResolvedValue([{ id: 'updated-env-var' }]);
    mockInsertReturning.mockResolvedValue([{ id: 'created-env-var' }]);
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

    it('allows the sandbox OpenRouter key to be stored', async () => {
      mockSelectLimit.mockResolvedValue([]);

      await expect(
        createEnvVarCommand(buildMockAuth(), {
          name: 'SANDBOX_OPENROUTER_API_KEY',
          value: 'sandbox-openrouter-key',
        }),
      ).resolves.toBeUndefined();

      expect(mockInsertReturning).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateEnvVarCommand', () => {
    it.each([
      {
        name: 'DATABASE_URL',
        error: 'is a reserved deployment variable and cannot be set here.',
      },
      {
        name: 'OPENCODE_AUTH_CONTENT',
        error: 'is managed by Roomote and cannot be set here.',
      },
    ])('rejects reserved $name rows', async ({ name, error }) => {
      mockSelectLimit.mockResolvedValue([{ id: 'reserved-id', name }]);

      await expect(
        updateEnvVarCommand(buildMockAuth(), {
          id: 'reserved-id',
          value: 'replacement',
        }),
      ).rejects.toThrow(error);

      expect(mockUpdateReturning).not.toHaveBeenCalled();
    });

    it('updates an ordinary environment variable', async () => {
      mockSelectLimit.mockResolvedValue([
        { id: 'ordinary-id', name: 'ORDINARY_VAR' },
      ]);

      await expect(
        updateEnvVarCommand(buildMockAuth(), {
          id: 'ordinary-id',
          value: 'replacement',
        }),
      ).resolves.toBeUndefined();

      expect(mockUpdateReturning).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteEnvVarCommand', () => {
    it.each([
      {
        name: 'DATABASE_URL',
        error: 'is a reserved deployment variable and cannot be set here.',
      },
      {
        name: 'OPENCODE_AUTH_CONTENT',
        error: 'is managed by Roomote and cannot be set here.',
      },
    ])('rejects reserved $name rows', async ({ name, error }) => {
      mockSelectLimit.mockResolvedValue([{ id: 'reserved-id', name }]);

      await expect(
        deleteEnvVarCommand(buildMockAuth(), { id: 'reserved-id' }),
      ).rejects.toThrow(error);

      expect(mockDeleteWhere).not.toHaveBeenCalled();
    });

    it('deletes an ordinary environment variable', async () => {
      mockSelectLimit.mockResolvedValue([
        { id: 'ordinary-id', name: 'ORDINARY_VAR' },
      ]);

      await expect(
        deleteEnvVarCommand(buildMockAuth(), { id: 'ordinary-id' }),
      ).resolves.toEqual({ success: true });

      expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
    });
  });
});
