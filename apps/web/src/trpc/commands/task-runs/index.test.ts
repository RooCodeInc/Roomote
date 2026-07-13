import { FeatureFlag } from '@roomote/feature-flags';
import { ALL_REPOSITORIES, TaskPayloadKind } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

const {
  mockEnqueueTask,
  mockGetRepositories,
  mockDbWhere,
  mockDbSelect,
  mockResolveWorkspaceProvider,
} = vi.hoisted(() => ({
  mockEnqueueTask: vi.fn(),
  mockGetRepositories: vi.fn(),
  mockDbWhere: vi.fn(),
  mockDbSelect: vi.fn(),
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
  resolveWorkspaceSourceControlProvider: (...args: unknown[]) =>
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
    R_TRPC_URL: 'https://roomote.test/api/trpc',
  },
  getArtifactById: vi.fn(),
  getRepositories: (...args: unknown[]) => mockGetRepositories(...args),
}));

vi.mock('@/lib/task-utils', () => ({
  humanizeFilename: (value: string) => value,
}));

import { createStandardTaskRunCommand } from './index';

const featureFlags = Object.fromEntries(
  Object.values(FeatureFlag).map((flag) => [flag, false]),
) as Record<FeatureFlag, boolean>;

const auth = {
  success: true,
  userType: 'user',
  userId: 'user-123',
  name: 'Test User',
  primaryEmail: 'test@example.com',
  isAdmin: true,
  featureFlags,
  anonymousAnalyticsEnabled: false,
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
    mockResolveWorkspaceProvider.mockResolvedValue(undefined);
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
    mockResolveWorkspaceProvider.mockResolvedValue('ado');

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
});
