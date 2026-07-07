import { FeatureFlag } from '@roomote/feature-flags';
import { ALL_REPOSITORIES, CloudTaskType } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

const { mockEnqueueCloudTask, mockGetRepositories, mockDbWhere, mockDbSelect } =
  vi.hoisted(() => ({
    mockEnqueueCloudTask: vi.fn(),
    mockGetRepositories: vi.fn(),
    mockDbWhere: vi.fn(),
    mockDbSelect: vi.fn(),
  }));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildSlackRoutingContext: vi.fn(),
  enqueueCloudTask: (...args: unknown[]) => mockEnqueueCloudTask(...args),
  getTaskUrl: vi.fn(() => 'https://roomote.test/tasks/task-123'),
  routeTask: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
  cloudJobs: {
    id: 'cloud_jobs.id',
    taskId: 'cloud_jobs.task_id',
    slackThreadTs: 'cloud_jobs.slack_thread_ts',
    status: 'cloud_jobs.status',
  },
  db: {
    query: {
      cloudJobs: {
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
  isNotNull: vi.fn((value: unknown) => ({ type: 'isNotNull', value })),
  markTaskStartParallelCountEndedAt: vi.fn(),
  repositories: {
    id: 'repositories.id',
    isActive: 'repositories.is_active',
    sourceControlProvider: 'repositories.source_control_provider',
  },
  slackInstallations: {
    isActive: 'slack_installations.is_active',
  },
  sql: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: vi.fn(),
}));

vi.mock('@/lib/server', () => ({
  Env: {
    ROOMOTE_APP_URL: 'https://roomote.test',
    TRPC_URL: 'https://roomote.test/api/trpc',
  },
  getArtifactById: vi.fn(),
  getRepositories: (...args: unknown[]) => mockGetRepositories(...args),
}));

vi.mock('@/lib/task-utils', () => ({
  humanizeFilename: (value: string) => value,
}));

import { createStandardTaskCloudJobCommand } from './index';

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
  mockEnqueueCloudTask.mockResolvedValue({
    id: 123,
    taskId: 'task-123',
  });
}

describe('createStandardTaskCloudJobCommand', () => {
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

    const result = await createStandardTaskCloudJobCommand(auth, {
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
    expect(mockEnqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: CloudTaskType.StandardTask,
        payload: expect.objectContaining({
          repo: 'acme/Platform/backend',
          environmentId: '7bb91386-6282-4c98-9b31-0eb181116822',
          sourceControlProvider: 'ado',
        }),
      }),
      expect.objectContaining({
        launchClass: 'human',
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

    const result = await createStandardTaskCloudJobCommand(auth, {
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
    expect(mockEnqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: CloudTaskType.StandardTask,
        payload: expect.not.objectContaining({
          environmentId: expect.anything(),
        }),
      }),
      expect.objectContaining({
        launchClass: 'human',
      }),
    );
  });

  it('allows an all-repositories launch without an environment', async () => {
    const result = await createStandardTaskCloudJobCommand(auth, {
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
    expect(mockEnqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: CloudTaskType.StandardTask,
        payload: expect.objectContaining({
          repo: ALL_REPOSITORIES,
        }),
      }),
      expect.objectContaining({
        launchClass: 'human',
      }),
    );
  });

  it('rejects launches without an environment or repository target', async () => {
    const result = await createStandardTaskCloudJobCommand(auth, {
      payload: {
        repo: '',
        description: 'Update the backend',
      },
    });

    expect(result).toEqual({
      success: false,
      error: 'Select an environment before starting a task.',
    });
    expect(mockEnqueueCloudTask).not.toHaveBeenCalled();
  });

  it('stamps an environment source-control provider from its repository mappings', async () => {
    mockDbWhere.mockResolvedValue([{ sourceControlProvider: 'ado' }]);

    const result = await createStandardTaskCloudJobCommand(auth, {
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
    expect(mockEnqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: CloudTaskType.StandardTask,
        payload: expect.objectContaining({
          environmentId: '7bb91386-6282-4c98-9b31-0eb181116822',
          sourceControlProvider: 'ado',
        }),
      }),
      expect.objectContaining({
        launchClass: 'human',
      }),
    );
  });
});
