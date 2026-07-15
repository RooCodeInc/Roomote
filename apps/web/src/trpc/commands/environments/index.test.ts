const {
  mockCheckRepoAccess,
  mockDbSelect,
  mockEnqueueTask,
  mockGetBranches,
  mockGetRepositories,
  mockBeginEnvironmentVerification,
} = vi.hoisted(() => ({
  mockCheckRepoAccess: vi.fn(),
  mockDbSelect: vi.fn(),
  mockEnqueueTask: vi.fn().mockResolvedValue({
    taskId: 'task-env-definition-1',
    id: 'run-env-definition-1',
  }),
  mockGetBranches: vi.fn(),
  mockGetRepositories: vi.fn().mockResolvedValue([
    {
      id: 'repo-1',
      fullName: 'acme/api',
      installationId: 'installation-1',
    },
    {
      id: 'repo-2',
      fullName: 'acme/web',
      installationId: 'installation-1',
    },
  ]),
  mockBeginEnvironmentVerification: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: mockEnqueueTask,
}));

vi.mock('@roomote/github', () => ({
  getBranches: mockGetBranches,
}));

vi.mock('@roomote/db/server', () => ({
  activeRunStatuses: [],
  and: vi.fn(),
  beginEnvironmentVerification: mockBeginEnvironmentVerification,
  cancelTaskRunDirect: vi.fn(),
  createEnvironmentConfigVersionSnapshot: vi.fn(),
  db: {
    select: mockDbSelect,
  },
  desc: vi.fn(),
  environmentConfigVersions: {},
  environmentRepositoryMappings: {},
  environments: {},
  eq: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  loadEnvironmentSnapshots: vi.fn(),
  markTaskStartParallelCountEndedAt: vi.fn(),
  repositories: {},
  sql: vi.fn(),
  taskRuns: {},
  tasks: {},
  updateEnvironmentDefinition: vi.fn(),
  users: {},
}));

vi.mock('@/lib/server', () => ({
  checkRepoAccess: mockCheckRepoAccess,
  getRepositories: mockGetRepositories,
}));

import { TaskPayloadKind } from '@roomote/types';
import type { UserAuthSuccess } from '@/types';
import {
  createEnvironmentCommand,
  retryEnvironmentVerificationCommand,
  startEnvironmentDefinitionTaskCommand,
  updateEnvironmentCommand,
  validateConfigCommand,
} from './index';

function buildMockAuth(): UserAuthSuccess {
  return {
    success: true,
    userType: 'user',
    userId: 'user-1',
    name: 'Admin',
    primaryEmail: 'admin@example.com',
    isAdmin: true,
    featureFlags: {} as UserAuthSuccess['featureFlags'],
    anonymousAnalyticsEnabled: false,
    resource: {
      username: null,
      fullName: 'Admin',
      firstName: 'Admin',
      lastName: null,
      primaryEmailAddress: {
        id: 'email-1',
        emailAddress: 'admin@example.com',
      },
      emailAddresses: [
        {
          id: 'email-1',
          emailAddress: 'admin@example.com',
        },
      ],
      imageUrl: '',
      createdAt: null,
    },
  };
}

describe('startEnvironmentDefinitionTaskCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the setup environment title rules for settings-created tasks', async () => {
    const result = await startEnvironmentDefinitionTaskCommand(
      buildMockAuth(),
      {
        repositoryIds: ['repo-2', 'repo-1'],
      },
    );

    expect(result.taskId).toBe('task-env-definition-1');
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Set up the api + web environment',
        task: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
          payload: expect.objectContaining({
            selectedRepositories: ['acme/api', 'acme/web'],
          }),
        }),
        initiator: { kind: 'user', userId: 'user-1' },
        workflow: 'setup_onboarding',
        surface: 'web',
        trigger: 'manual',
      }),
    );
  });
});

describe('retryEnvironmentVerificationCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnqueueTask.mockResolvedValue({
      taskId: 'task-verify-1',
      id: 'run-verify-1',
    });
  });

  it('enqueues a verification task and registers the new attempt', async () => {
    mockDbSelect
      // Environment lookup.
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: 'env-1', name: 'My Env' }],
          }),
        }),
      })
      // Active verification task lookup (none active).
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: async () => [] }),
          }),
        }),
      });

    const result = await retryEnvironmentVerificationCommand(buildMockAuth(), {
      environmentId: 'env-1',
    });

    expect(result).toEqual({ taskId: 'task-verify-1' });
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
          payload: expect.objectContaining({
            environmentId: 'env-1',
            verifiesEnvironmentId: 'env-1',
          }),
        }),
        workflow: 'standard',
      }),
    );
    expect(mockBeginEnvironmentVerification).toHaveBeenCalledWith(
      expect.anything(),
      { environmentId: 'env-1', verificationTaskId: 'task-verify-1' },
    );
  });

  it('rejects when a verification task is already active', async () => {
    mockDbSelect
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: 'env-1', name: 'My Env' }],
          }),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => [{ taskId: 'task-active' }],
            }),
          }),
        }),
      });

    await expect(
      retryEnvironmentVerificationCommand(buildMockAuth(), {
        environmentId: 'env-1',
      }),
    ).rejects.toThrow('already being verified');

    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockBeginEnvironmentVerification).not.toHaveBeenCalled();
  });

  it('rejects when the environment does not exist', async () => {
    mockDbSelect.mockReturnValueOnce({
      from: () => ({
        where: () => ({ limit: async () => [] }),
      }),
    });

    await expect(
      retryEnvironmentVerificationCommand(buildMockAuth(), {
        environmentId: 'env-missing',
      }),
    ).rejects.toThrow('Environment not found');
  });
});

describe('environment repository validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects create when a configured repository is not linked', async () => {
    mockDbSelect
      .mockReturnValueOnce({
        from: () => ({ where: () => ({ limit: async () => [] }) }),
      })
      .mockReturnValueOnce({
        from: () => ({ where: async () => [] }),
      });

    const result = await createEnvironmentCommand(buildMockAuth(), {
      name: 'ADO Test',
      config: {
        name: 'ADO Test',
        repositories: [{ repository: 'roomote/Test ADO' }],
      },
    });

    expect(result).toEqual({
      success: false,
      error: 'Repositories are not linked to this deployment: roomote/Test ADO',
    });
  });

  it('rejects update when a configured repository is not linked', async () => {
    mockDbSelect
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                id: 'env-1',
                name: 'ADO Test',
                description: null,
                config: {
                  name: 'ADO Test',
                  repositories: [{ repository: 'roomote/Test ADO/Test ADO' }],
                },
              },
            ],
          }),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({ where: async () => [] }),
      });

    const result = await updateEnvironmentCommand(buildMockAuth(), {
      id: 'env-1',
      config: {
        name: 'ADO Test',
        repositories: [{ repository: 'roomote/Test ADO' }],
      },
    });

    expect(result).toEqual({
      success: false,
      error: 'Repositories are not linked to this deployment: roomote/Test ADO',
    });
  });

  it('does not validate Azure DevOps branches through GitHub', async () => {
    mockDbSelect.mockReturnValueOnce({
      from: () => ({
        where: async () => [
          {
            id: 'repo-ado',
            fullName: 'roomote/Test ADO/Test ADO',
            installationId: null,
            sourceControlProvider: 'ado',
          },
        ],
      }),
    });
    mockCheckRepoAccess.mockResolvedValue(true);

    const result = await validateConfigCommand(buildMockAuth(), {
      config: {
        name: 'ADO Test',
        repositories: [
          {
            repository: 'roomote/Test ADO/Test ADO',
            branch: 'main',
          },
        ],
      },
    });

    expect(result).toEqual({ errors: [], warnings: [] });
    expect(mockGetBranches).not.toHaveBeenCalled();
  });

  it('continues warning when a GitHub branch is missing', async () => {
    mockDbSelect.mockReturnValueOnce({
      from: () => ({
        where: async () => [
          {
            id: 'repo-github',
            fullName: 'roomote/roomote',
            installationId: 'installation-1',
            sourceControlProvider: 'github',
          },
        ],
      }),
    });
    mockCheckRepoAccess.mockResolvedValue(true);
    mockGetBranches.mockResolvedValue(['main']);

    const result = await validateConfigCommand(buildMockAuth(), {
      config: {
        name: 'GitHub Test',
        repositories: [
          { repository: 'roomote/roomote', branch: 'missing-branch' },
        ],
      },
    });

    expect(result).toEqual({
      errors: [],
      warnings: [
        "Branch 'missing-branch' was not found in 'roomote/roomote'. It may not exist yet.",
      ],
    });
    expect(mockGetBranches).toHaveBeenCalledWith({
      userId: 'user-1',
      fullName: 'roomote/roomote',
    });
  });
});
