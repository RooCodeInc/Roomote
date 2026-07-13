const { mockDbSelect, mockEnqueueTask, mockGetRepositories } = vi.hoisted(
  () => ({
    mockDbSelect: vi.fn(),
    mockEnqueueTask: vi.fn().mockResolvedValue({
      taskId: 'task-env-definition-1',
      id: 'run-env-definition-1',
    }),
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
  }),
);

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: mockEnqueueTask,
}));

vi.mock('@roomote/db/server', () => ({
  activeRunStatuses: [],
  and: vi.fn(),
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
  checkRepoAccess: vi.fn(),
  getRepositories: mockGetRepositories,
}));

import { TaskPayloadKind } from '@roomote/types';
import type { UserAuthSuccess } from '@/types';
import {
  createEnvironmentCommand,
  startEnvironmentDefinitionTaskCommand,
  updateEnvironmentCommand,
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
});
