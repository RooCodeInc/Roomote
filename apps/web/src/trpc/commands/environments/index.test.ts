const {
  mockCheckRepoAccess,
  mockDbSelect,
  mockEnqueueTask,
  mockGetBranches,
  mockGetRepositoryEmptyStates,
  mockGetRepositories,
  mockBeginEnvironmentVerification,
  mockActiveVerificationRuns,
} = vi.hoisted(() => ({
  mockCheckRepoAccess: vi.fn(),
  mockDbSelect: vi.fn(),
  mockEnqueueTask: vi.fn().mockResolvedValue({
    taskId: 'task-env-definition-1',
    id: 'run-env-definition-1',
  }),
  mockGetBranches: vi.fn(),
  mockGetRepositoryEmptyStates: vi.fn(async () => new Map<string, boolean>()),
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
  // Active verification run seen inside the retry critical section. Each entry
  // is returned by the locked transaction's active-run lookup.
  mockActiveVerificationRuns: [] as Array<{ taskId: string }>,
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: mockEnqueueTask,
}));

vi.mock('@roomote/github', () => ({
  getBranches: mockGetBranches,
  getRepositoryEmptyStates: mockGetRepositoryEmptyStates,
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
  or: vi.fn(),
  repositories: {},
  sql: vi.fn(),
  taskRuns: {},
  tasks: {},
  updateEnvironmentDefinition: vi.fn(),
  users: {},
  withEnvironmentVerificationRetryLock: async (
    _environmentId: string,
    mutation: (tx: unknown) => Promise<unknown>,
  ) => {
    // Provide a transaction whose active-run lookup returns the seeded rows.
    const activeRunQuery = {
      innerJoin: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => mockActiveVerificationRuns,
          }),
        }),
      }),
    };
    const tx = {
      select: () => ({
        from: () => activeRunQuery,
      }),
    };
    return mutation(tx);
  },
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
    cloudEnabled: false,
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

  it('applies the selected model to settings-created setup tasks', async () => {
    await startEnvironmentDefinitionTaskCommand(buildMockAuth(), {
      repositoryIds: ['repo-1'],
      selectedModelId: 'openrouter/z-ai/glm-5.2',
    });

    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          harness: 'opencode-server',
          payload: expect.objectContaining({
            harnessModelOverrides: {
              'opencode-server': 'openrouter/z-ai/glm-5.2',
            },
          }),
        }),
      }),
    );
  });

  it('flags empty repositories in the kickoff prompt instead of blocking', async () => {
    mockGetRepositoryEmptyStates.mockResolvedValueOnce(
      new Map([
        ['repo-1', true],
        ['repo-2', false],
      ]),
    );

    await startEnvironmentDefinitionTaskCommand(buildMockAuth(), {
      repositoryIds: ['repo-2', 'repo-1'],
    });

    expect(mockGetRepositoryEmptyStates).toHaveBeenCalledWith({
      repositoryIds: ['repo-1', 'repo-2'],
    });

    const enqueueInput = mockEnqueueTask.mock.calls[0]?.[0] as {
      task: { payload: { description: string } };
    };
    // Only the empty repo appears in the bootstrap list; acme/web has
    // commits, so the list ends right after acme/api.
    expect(enqueueInput.task.payload.description).toContain(
      'These repositories are brand new and have no commits yet:\n- acme/api\n\nFor each empty repository',
    );
  });

  it('keeps the kickoff prompt unchanged when no selected repository is empty', async () => {
    await startEnvironmentDefinitionTaskCommand(buildMockAuth(), {
      repositoryIds: ['repo-1'],
    });

    const enqueueInput = mockEnqueueTask.mock.calls[0]?.[0] as {
      task: { payload: { description: string } };
    };
    expect(enqueueInput.task.payload.description).not.toContain(
      'brand new and have no commits',
    );
  });
});

describe('retryEnvironmentVerificationCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveVerificationRuns.length = 0;
    // The command registers the attempt through enqueueTask's
    // afterCreateInTransaction hook, so the mock must invoke it (with a stub
    // transaction) to exercise registration.
    mockEnqueueTask.mockImplementation(
      async (
        _input: unknown,
        options?: {
          afterCreateInTransaction?: (
            tx: unknown,
            taskRun: unknown,
          ) => Promise<void>;
        },
      ) => {
        const taskRun = { taskId: 'task-verify-1', id: 'run-verify-1' };
        await options?.afterCreateInTransaction?.({}, taskRun);
        return taskRun;
      },
    );
  });

  function mockEnvironmentLookup() {
    mockDbSelect.mockReturnValueOnce({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: 'env-1', name: 'My Env' }],
        }),
      }),
    });
  }

  it('enqueues a verification task and registers the new attempt', async () => {
    mockEnvironmentLookup();

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
      expect.objectContaining({
        afterCreateInTransaction: expect.any(Function),
      }),
    );
    expect(mockBeginEnvironmentVerification).toHaveBeenCalledWith(
      expect.anything(),
      { environmentId: 'env-1', verificationTaskId: 'task-verify-1' },
    );
  });

  it('rejects when a verification task is already active', async () => {
    mockEnvironmentLookup();
    // A verification run is already active inside the locked critical section.
    mockActiveVerificationRuns.push({ taskId: 'task-active' });

    await expect(
      retryEnvironmentVerificationCommand(buildMockAuth(), {
        environmentId: 'env-1',
      }),
    ).rejects.toThrow('already being verified');

    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockBeginEnvironmentVerification).not.toHaveBeenCalled();
  });

  it('serializes concurrent retries so only one verification task is enqueued', async () => {
    mockEnvironmentLookup();
    mockEnvironmentLookup();

    // Model the advisory lock's serialization: the first retry through the
    // critical section sees no active run and enqueues, and its registration
    // (via afterCreateInTransaction) makes the attempt active for the second
    // retry.
    let attempt = 0;
    mockEnqueueTask.mockImplementation(
      async (
        _input: unknown,
        options?: {
          afterCreateInTransaction?: (
            tx: unknown,
            taskRun: unknown,
          ) => Promise<void>;
        },
      ) => {
        attempt += 1;
        const taskRun = {
          taskId: `task-verify-${attempt}`,
          id: `run-verify-${attempt}`,
        };
        await options?.afterCreateInTransaction?.({}, taskRun);
        // After the first enqueue+register, a subsequent critical section sees
        // the active run and must reject before enqueueing again.
        mockActiveVerificationRuns.push({ taskId: `task-verify-${attempt}` });
        return taskRun;
      },
    );

    const first = await retryEnvironmentVerificationCommand(buildMockAuth(), {
      environmentId: 'env-1',
    });
    expect(first).toEqual({ taskId: 'task-verify-1' });

    await expect(
      retryEnvironmentVerificationCommand(buildMockAuth(), {
        environmentId: 'env-1',
      }),
    ).rejects.toThrow('already being verified');

    expect(mockEnqueueTask).toHaveBeenCalledTimes(1);
    expect(mockBeginEnvironmentVerification).toHaveBeenCalledTimes(1);
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
