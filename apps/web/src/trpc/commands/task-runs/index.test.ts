import type { UserAuthSuccess } from '@/types';

const {
  mockEnqueueTask,
  mockGetRepositories,
  mockDbSelect,
  mockGoalCommit,
  mockGoalRollback,
  mockPrepareTaskGoalActivation,
  mockResolveTaskByIdAccess,
  mockResolveWorkspaceProvider,
  mockSendSandboxPrompt,
} = vi.hoisted(() => ({
  mockEnqueueTask: vi.fn(),
  mockGetRepositories: vi.fn(),
  mockDbSelect: vi.fn(),
  mockGoalCommit: vi.fn(),
  mockGoalRollback: vi.fn(),
  mockPrepareTaskGoalActivation: vi.fn(),
  mockResolveTaskByIdAccess: vi.fn(),
  mockResolveWorkspaceProvider: vi.fn(),
  mockSendSandboxPrompt: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  DeploymentReadOnlyError: class DeploymentReadOnlyError extends Error {},
  enqueueTask: (...args: unknown[]) => mockEnqueueTask(...args),
  getTaskUrl: vi.fn(() => 'https://roomote.test/tasks/task-123'),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
  sessionTasks: { taskId: 'sessionTasks.taskId' },
  db: {
    query: {
      tasks: {
        findFirst: vi.fn(async () => null),
      },
      sessionTasks: {
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
  prepareTaskGoalActivation: (...args: unknown[]) =>
    mockPrepareTaskGoalActivation(...args),
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

vi.mock('../sandbox-session', () => ({
  sendSandboxPromptCommand: (...args: unknown[]) =>
    mockSendSandboxPrompt(...args),
}));

import { startTaskGoalCommand } from './index';

const auth = {
  success: true,
  userType: 'user',
  userId: 'user-123',
  name: 'Test User',
  primaryEmail: 'test@example.com',
  isAdmin: true,
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

describe('startTaskGoalCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTaskByIdAccess.mockResolvedValue({
      kind: 'resolved',
      task: { id: 'task-123' },
    });
    mockGoalCommit.mockResolvedValue({
      objective: 'Ship the release',
      generation: 'goal-generation:replacement',
      status: 'active',
      maxContinuations: 5,
      continuationsUsed: 0,
      blockedReason: null,
      completedAt: null,
    });
    mockGoalRollback.mockResolvedValue(true);
    mockPrepareTaskGoalActivation.mockResolvedValue({
      generation: 'goal-generation:replacement',
      commit: mockGoalCommit,
      rollback: mockGoalRollback,
    });
    mockSendSandboxPrompt.mockResolvedValue({ success: true });
  });

  it('activates Goal Mode only after prompt delivery succeeds', async () => {
    await expect(
      startTaskGoalCommand(auth, {
        taskId: 'task-123',
        goal: { objective: 'Ship the release', maxContinuations: 5 },
        clientMessageId: 'message-1',
      }),
    ).resolves.toMatchObject({
      success: true,
      goal: { objective: 'Ship the release', status: 'active' },
    });

    expect(mockResolveTaskByIdAccess).toHaveBeenCalledWith(auth, {
      taskId: 'task-123',
    });
    expect(mockPrepareTaskGoalActivation).toHaveBeenCalledWith({
      taskId: 'task-123',
      goal: { objective: 'Ship the release', maxContinuations: 5 },
    });
    expect(mockSendSandboxPrompt).toHaveBeenCalledWith(
      auth,
      {
        taskId: 'task-123',
        prompt: 'Ship the release',
        source: 'web',
        clientMessageId: 'message-1',
        userImageUrl: undefined,
        autoSteerWhenQueued: true,
      },
      {
        goalContext: {
          objective: 'Ship the release',
          generation: 'goal-generation:replacement',
          status: 'active',
          maxContinuations: 5,
          continuationsUsed: 0,
          blockedReason: null,
          completedAt: null,
        },
      },
    );
    expect(mockGoalCommit).toHaveBeenCalledOnce();
    expect(mockGoalRollback).not.toHaveBeenCalled();
  });

  it('does not enable Goal Mode when the task is unavailable', async () => {
    mockResolveTaskByIdAccess.mockResolvedValue({ kind: 'not-found' });

    await expect(
      startTaskGoalCommand(auth, {
        taskId: 'missing-task',
        goal: { objective: 'Ship the release', maxContinuations: 5 },
      }),
    ).resolves.toEqual({ success: false, error: 'Task not found' });
    expect(mockPrepareTaskGoalActivation).not.toHaveBeenCalled();
  });

  it('rolls back the pending goal when prompt delivery fails', async () => {
    const deliveryError = new Error('Sandbox unavailable');
    mockSendSandboxPrompt.mockRejectedValue(deliveryError);

    await expect(
      startTaskGoalCommand(auth, {
        taskId: 'task-123',
        goal: { objective: 'Ship the release', maxContinuations: 5 },
      }),
    ).rejects.toBe(deliveryError);

    expect(mockGoalCommit).not.toHaveBeenCalled();
    expect(mockGoalRollback).toHaveBeenCalledOnce();
  });
});
