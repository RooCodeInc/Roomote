import { ALL_REPOSITORIES, TaskPayloadKind } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

const {
  mockEnqueueTask,
  mockGetRepositories,
  mockDbWhere,
  mockDbSelect,
  mockEnableTaskGoal,
  mockResolveTaskByIdAccess,
  mockResolveWorkspaceProvider,
} = vi.hoisted(() => ({
  mockEnqueueTask: vi.fn(),
  mockGetRepositories: vi.fn(),
  mockDbWhere: vi.fn(),
  mockDbSelect: vi.fn(),
  mockEnableTaskGoal: vi.fn(),
  mockResolveTaskByIdAccess: vi.fn(),
  mockResolveWorkspaceProvider: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildSlackRoutingContext: vi.fn(),
  enqueueTask: (...args: unknown[]) => mockEnqueueTask(...args),
  getTaskUrl: vi.fn(() => 'https://roomote.test/tasks/task-123'),
  routeTask: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
  db: {
    query: {
      tasks: {
        findFirst: vi.fn(async () => null),
      },
      taskRuns: {
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
      },
      slackInstallations: {
        findFirst: vi.fn(async () => null),
      },
    },
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
  desc: vi.fn((value: unknown) => ({ type: 'desc', value })),
  enableTaskGoal: (...args: unknown[]) => mockEnableTaskGoal(...args),
  eq: vi.fn((left: unknown, right: unknown) => ({ type: 'eq', left, right })),
  environmentRepositoryMappings: {
    environmentId: 'environment_repository_mappings.environment_id',
    repositoryId: 'environment_repository_mappings.repository_id',
  },
  inArray: vi.fn((left: unknown, right: unknown) => ({
    type: 'inArray',
    left,
    right,
  })),
  markTaskStartParallelCountEndedAt: vi.fn(),
  resolveWorkspaceRepositoryProviders: (...args: unknown[]) =>
    mockResolveWorkspaceProvider(...args),
  repositories: {
    id: 'repositories.id',
    isActive: 'repositories.is_active',
    sourceControlProvider: 'repositories.source_control_provider',
  },
  slackInstallations: {
    isActive: 'slack_installations.is_active',
  },
  taskRuns: {
    id: 'task_runs.id',
    taskId: 'task_runs.task_id',
    status: 'task_runs.status',
    createdAt: 'task_runs.created_at',
    payload: 'task_runs.payload',
  },
  tasks: {
    id: 'tasks.id',
    slackChannelId: 'tasks.slack_channel_id',
    slackThreadTs: 'tasks.slack_thread_ts',
  },
  sql: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: vi.fn(),
}));

vi.mock('@/lib/server', () => ({
  Env: {
    R_APP_URL: 'https://roomote.test',
    TRPC_URL: 'https://roomote.test/api/trpc',
  },
  getArtifactById: vi.fn(),
  getRepositories: (...args: unknown[]) => mockGetRepositories(...args),
}));

vi.mock('@/lib/task-utils', () => ({
  humanizeFilename: (value: string) => value,
}));

vi.mock('../tasks/by-id', () => ({
  resolveTaskByIdAccessCommand: (...args: unknown[]) =>
    mockResolveTaskByIdAccess(...args),
}));

import { createStandardTaskRunCommand, enableTaskGoalCommand } from './index';

const auth = {
  success: true,
  userType: 'user',
  userId: 'user-123',
  name: 'Test User',
  primaryEmail: 'test@example.com',
  isAdmin: true,
  featureFlags: {},
  anonymousAnalyticsEnabled: false,
  cloudEnabled: false,
  cookieConsentedAt: null,
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
} satisfies UserAuthSuccess;

function mockSuccessfulEnqueue() {
  mockEnqueueTask.mockResolvedValue({
    id: 123,
    taskId: 'task-123',
  });
}

describe('enableTaskGoalCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTaskByIdAccess.mockResolvedValue({
      kind: 'resolved',
      task: { id: 'task-123' },
    });
    mockEnableTaskGoal.mockResolvedValue({
      objective: 'Ship the release',
      status: 'active',
      maxContinuations: 5,
      continuationsUsed: 0,
      blockedReason: null,
      completedAt: null,
    });
  });

  it('enables Goal Mode after resolving authenticated task access', async () => {
    await expect(
      enableTaskGoalCommand(auth, {
        taskId: 'task-123',
        goal: { objective: 'Ship the release', maxContinuations: 5 },
      }),
    ).resolves.toMatchObject({
      success: true,
      goal: { objective: 'Ship the release', status: 'active' },
    });

    expect(mockResolveTaskByIdAccess).toHaveBeenCalledWith(auth, {
      taskId: 'task-123',
    });
    expect(mockEnableTaskGoal).toHaveBeenCalledWith({
      taskId: 'task-123',
      goal: { objective: 'Ship the release', maxContinuations: 5 },
    });
  });

  it('does not enable Goal Mode when the task is unavailable', async () => {
    mockResolveTaskByIdAccess.mockResolvedValue({ kind: 'not-found' });

    await expect(
      enableTaskGoalCommand(auth, {
        taskId: 'missing-task',
        goal: { objective: 'Ship the release', maxContinuations: 5 },
      }),
    ).resolves.toEqual({ success: false, error: 'Task not found' });
    expect(mockEnableTaskGoal).not.toHaveBeenCalled();
  });
});

describe('createStandardTaskRunCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbSelect.mockReturnValue({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: mockDbWhere,
        })),
      })),
    });
    mockDbWhere.mockResolvedValue([]);
    // Shared resolver defaults to unresolved; the environment test overrides it.
    mockResolveWorkspaceProvider.mockResolvedValue({});
    mockSuccessfulEnqueue();
  });

  it('stamps the selected repository source-control provider onto manual task payloads', async () => {
    mockGetRepositories.mockResolvedValue([
      {
        id: 'repo-ado',
        fullName: 'acme/Platform/backend',
        sourceControlProvider: 'ado',
      },
    ]);

    const result = await createStandardTaskRunCommand(auth, {
      payload: {
        repo: 'acme/Platform/backend',
        environmentId: '7bb91386-6282-4c98-9b31-0eb181116822',
        description: 'Update the backend',
      },
    });

    expect(result).toEqual({
      success: true,
      id: 123,
      taskId: 'task-123',
    });
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
          payload: expect.objectContaining({
            repo: 'acme/Platform/backend',
            environmentId: '7bb91386-6282-4c98-9b31-0eb181116822',
            sourceControlProvider: 'ado',
          }),
        }),
        initiator: { kind: 'user', userId: 'user-123' },
        workflow: 'standard',
        surface: 'web',
        trigger: 'manual',
      }),
    );
  });

  it('allows a bare-repo launch without an environment', async () => {
    mockGetRepositories.mockResolvedValue([
      {
        id: 'repo-ado',
        fullName: 'acme/Platform/backend',
        sourceControlProvider: 'ado',
      },
    ]);

    const result = await createStandardTaskRunCommand(auth, {
      payload: {
        repo: 'acme/Platform/backend',
        description: 'Update the backend',
      },
    });

    expect(result).toEqual({
      success: true,
      id: 123,
      taskId: 'task-123',
    });
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
          payload: expect.not.objectContaining({
            environmentId: expect.anything(),
          }),
        }),
        initiator: { kind: 'user', userId: 'user-123' },
        workflow: 'standard',
        surface: 'web',
        trigger: 'manual',
      }),
    );
  });

  it('allows an all-repositories launch without an environment', async () => {
    const result = await createStandardTaskRunCommand(auth, {
      payload: {
        repo: ALL_REPOSITORIES,
        description: 'Update everything',
      },
    });

    expect(result).toEqual({
      success: true,
      id: 123,
      taskId: 'task-123',
    });
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
          payload: expect.objectContaining({
            repo: ALL_REPOSITORIES,
          }),
        }),
        initiator: { kind: 'user', userId: 'user-123' },
        workflow: 'standard',
        surface: 'web',
        trigger: 'manual',
      }),
    );
  });

  it('rejects launches without an environment or repository target', async () => {
    const result = await createStandardTaskRunCommand(auth, {
      payload: {
        repo: '',
        description: 'Update the backend',
      },
    });

    expect(result).toEqual({
      success: false,
      error: 'Select an environment before starting a task.',
    });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('stamps an environment source-control provider from its repository mappings', async () => {
    // The environment resolver delegates to the shared @roomote/db resolver.
    mockResolveWorkspaceProvider.mockResolvedValue({
      'acme/Platform/backend': 'ado',
    });

    const result = await createStandardTaskRunCommand(auth, {
      payload: {
        repo: ALL_REPOSITORIES,
        environmentId: '7bb91386-6282-4c98-9b31-0eb181116822',
        description: 'Update the environment',
      },
    });

    expect(result).toEqual({
      success: true,
      id: 123,
      taskId: 'task-123',
    });
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
          payload: expect.objectContaining({
            environmentId: '7bb91386-6282-4c98-9b31-0eb181116822',
            sourceControlProvider: 'ado',
          }),
        }),
        initiator: { kind: 'user', userId: 'user-123' },
        workflow: 'standard',
        surface: 'web',
        trigger: 'manual',
      }),
    );
  });

  it('uses the first repository provider for a mixed environment', async () => {
    mockResolveWorkspaceProvider.mockResolvedValue({
      'octo/api': 'github',
      'group/web': 'gitlab',
    });

    const result = await createStandardTaskRunCommand(auth, {
      payload: {
        repo: ALL_REPOSITORIES,
        environmentId: '7bb91386-6282-4c98-9b31-0eb181116822',
        description: 'Update the environment',
      },
    });

    expect(result.success).toBe(true);
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            sourceControlProvider: 'github',
          }),
        }),
      }),
    );
  });

  it('allows mixed selected repositories and keeps selection order for the primary provider', async () => {
    mockGetRepositories.mockResolvedValue([
      {
        id: 'repo-github',
        fullName: 'octo/api',
        sourceControlProvider: 'github',
      },
      {
        id: 'repo-gitlab',
        fullName: 'group/web',
        sourceControlProvider: 'gitlab',
      },
    ]);

    const result = await createStandardTaskRunCommand(auth, {
      payload: {
        repo: ALL_REPOSITORIES,
        selectedRepositories: ['octo/api', 'group/web'],
        description: 'Update selected repositories',
      },
    });

    expect(result.success).toBe(true);
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            selectedRepositories: ['octo/api', 'group/web'],
            sourceControlProvider: 'github',
          }),
        }),
      }),
    );
  });
});
