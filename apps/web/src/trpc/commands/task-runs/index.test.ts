import { ALL_REPOSITORIES, RunStatus, TaskPayloadKind } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

const {
  mockEnqueueTask,
  mockCanRetryFailedStart,
  mockFindFastSession,
  mockFindReplacement,
  mockFindTaskRun,
  mockGetRepositories,
  mockDbWhere,
  mockDbSelect,
  mockGoalCommit,
  mockGoalRollback,
  mockPrepareTaskGoalActivation,
  mockResolveTaskByIdAccess,
  mockResolveWorkspaceProvider,
  mockSendSandboxPrompt,
} = vi.hoisted(() => ({
  mockEnqueueTask: vi.fn(),
  mockCanRetryFailedStart: vi.fn(),
  mockFindFastSession: vi.fn(),
  mockFindReplacement: vi.fn(),
  mockFindTaskRun: vi.fn(),
  mockGetRepositories: vi.fn(),
  mockDbWhere: vi.fn(),
  mockDbSelect: vi.fn(),
  mockGoalCommit: vi.fn(),
  mockGoalRollback: vi.fn(),
  mockPrepareTaskGoalActivation: vi.fn(),
  mockResolveTaskByIdAccess: vi.fn(),
  mockResolveWorkspaceProvider: vi.fn(),
  mockSendSandboxPrompt: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildSlackRoutingContext: vi.fn(),
  canRetryFailedStart: (...args: unknown[]) => mockCanRetryFailedStart(...args),
  DeploymentReadOnlyError: class DeploymentReadOnlyError extends Error {
    code = 'DEPLOYMENT_READ_ONLY';
  },
  enqueueTask: (...args: unknown[]) => mockEnqueueTask(...args),
  fastAgentConversationRepository: {
    findById: (...args: unknown[]) => mockFindFastSession(...args),
  },
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
        findFirst: (...args: unknown[]) => {
          const options = args[0] as
            | { columns?: Record<string, boolean> }
            | undefined;
          return options?.columns?.id === true &&
            options.columns.taskId === true &&
            Object.keys(options.columns).length === 2
            ? mockFindReplacement(...args)
            : mockFindTaskRun(...args);
        },
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

import {
  createFailedStartReplacementTaskRunCommand,
  createStandardTaskRunCommand,
  startTaskGoalCommand,
} from './index';

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
    mockFindTaskRun.mockResolvedValue(null);
    mockFindFastSession.mockResolvedValue(null);
    mockFindReplacement.mockResolvedValue(null);
    mockCanRetryFailedStart.mockResolvedValue(true);
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

  it('creates an immediate replacement with original launch settings and canonical Fast metadata', async () => {
    const sourceConversation = {
      surface: 'slack' as const,
      workspaceId: 'workspace-1',
      conversationId: 'thread-1',
      replyTarget: { channelId: 'channel-1', threadId: 'thread-1' },
    };
    const canonicalConversation = {
      ...sourceConversation,
      replyTarget: { channelId: 'channel-2', threadId: 'thread-1' },
    };
    mockFindTaskRun.mockResolvedValue({
      id: 77,
      taskId: 'source-task',
      status: RunStatus.Failed,
      payloadKind: TaskPayloadKind.StandardTask,
      harness: 'opencode-server',
      vendor: 'modal',
      payload: {
        repo: ALL_REPOSITORIES,
        environmentId: 'original-environment',
        description: 'Original prompt',
        communicationSourceEventId: 'gateway-event-1',
        launchIdempotencyKey: 'original-launch',
        fastAgentSessionId: '11111111-1111-4111-8111-111111111111',
        fastAgentParent: {
          sessionId: '11111111-1111-4111-8111-111111111111',
          conversation: sourceConversation,
        },
      },
      error: 'Provider failed to start',
      result: null,
    });
    mockResolveTaskByIdAccess.mockResolvedValue({
      kind: 'resolved',
      task: {
        id: 'source-task',
        model: 'openrouter/openai/gpt-5.4',
      },
    });
    mockFindFastSession.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      userId: auth.userId,
      conversation: canonicalConversation,
    });

    const result = await createFailedStartReplacementTaskRunCommand(auth, {
      runId: 77,
    });

    expect(result.success).toBe(true);
    expect(mockFindFastSession).toHaveBeenCalledWith({
      id: '11111111-1111-4111-8111-111111111111',
      fallbackConversation: sourceConversation,
    });
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          computeProvider: 'modal',
          payload: expect.objectContaining({
            environmentId: 'original-environment',
            description: 'Original prompt',
            communicationContextInherited: true,
            fastAgentSessionId: '22222222-2222-4222-8222-222222222222',
            fastAgentParent: {
              sessionId: '22222222-2222-4222-8222-222222222222',
              conversation: canonicalConversation,
            },
            harnessModelOverrides: expect.objectContaining({
              'opencode-server': 'openrouter/openai/gpt-5.4',
            }),
          }),
        }),
      }),
    );
    const enqueuedPayload = mockEnqueueTask.mock.calls[0]?.[0]?.task?.payload;
    expect(enqueuedPayload).not.toHaveProperty('communicationSourceEventId');
    expect(enqueuedPayload).toHaveProperty(
      'launchIdempotencyKey',
      'failed-start-replacement:77',
    );
  });

  it('strips client-supplied Fast linkage from ordinary web launches', async () => {
    await createStandardTaskRunCommand(auth, {
      payload: {
        repo: ALL_REPOSITORIES,
        description: 'Spoof linkage',
        communicationContextInherited: true,
        fastAgentSessionId: '11111111-1111-4111-8111-111111111111',
        fastAgentParent: {
          sessionId: '11111111-1111-4111-8111-111111111111',
          conversation: {
            surface: 'web',
            workspaceId: 'other-user',
            conversationId: 'other-session',
          },
        },
      },
    });

    const enqueuedPayload = mockEnqueueTask.mock.calls[0]?.[0]?.task?.payload;
    expect(enqueuedPayload).not.toHaveProperty('communicationContextInherited');
    expect(enqueuedPayload).not.toHaveProperty('fastAgentSessionId');
    expect(enqueuedPayload).not.toHaveProperty('fastAgentParent');
  });

  it('rejects recovery linkage to another user Fast session', async () => {
    mockFindTaskRun.mockResolvedValue({
      id: 77,
      taskId: 'source-task',
      status: RunStatus.Failed,
      payloadKind: TaskPayloadKind.StandardTask,
      harness: 'opencode-server',
      vendor: 'modal',
      payload: {
        repo: ALL_REPOSITORIES,
        description: 'Retry',
        fastAgentParent: {
          sessionId: '11111111-1111-4111-8111-111111111111',
          conversation: {
            surface: 'web',
            workspaceId: 'workspace-1',
            conversationId: 'session-1',
          },
        },
      },
      error: 'Provider failed to start',
      result: null,
    });
    mockResolveTaskByIdAccess.mockResolvedValue({
      kind: 'resolved',
      task: {
        id: 'source-task',
        model: 'openrouter/openai/gpt-5.4',
      },
    });
    mockFindFastSession.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      userId: 'other-user',
      conversation: {
        surface: 'web',
        workspaceId: 'workspace-1',
        conversationId: 'session-1',
      },
    });

    await expect(
      createFailedStartReplacementTaskRunCommand(auth, { runId: 77 }),
    ).resolves.toEqual({
      success: false,
      error: 'Failed task start is not linked to your Fast session.',
    });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('returns an existing replacement instead of launching a duplicate', async () => {
    mockFindTaskRun.mockResolvedValue({
      id: 77,
      taskId: 'source-task',
      status: RunStatus.Failed,
      payloadKind: TaskPayloadKind.StandardTask,
      harness: 'opencode-server',
      vendor: 'modal',
      payload: {
        repo: ALL_REPOSITORIES,
        description: 'Original prompt',
      },
    });
    mockResolveTaskByIdAccess.mockResolvedValue({
      kind: 'resolved',
      task: {
        id: 'source-task',
        model: 'openrouter/openai/gpt-5.4',
      },
    });
    mockFindReplacement.mockResolvedValue({
      id: 88,
      taskId: 'replacement-task',
    });

    await expect(
      createFailedStartReplacementTaskRunCommand(auth, { runId: 77 }),
    ).resolves.toEqual({
      success: true,
      id: 88,
      taskId: 'replacement-task',
    });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('recovers the winning replacement after a concurrent uniqueness race', async () => {
    mockFindTaskRun.mockResolvedValue({
      id: 77,
      taskId: 'source-task',
      status: RunStatus.Failed,
      payloadKind: TaskPayloadKind.StandardTask,
      harness: 'opencode-server',
      vendor: 'modal',
      payload: {
        repo: ALL_REPOSITORIES,
        description: 'Original prompt',
      },
    });
    mockResolveTaskByIdAccess.mockResolvedValue({
      kind: 'resolved',
      task: {
        id: 'source-task',
        model: 'openrouter/openai/gpt-5.4',
      },
    });
    mockFindReplacement
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 88, taskId: 'replacement-task' });
    mockEnqueueTask.mockRejectedValue(new Error('duplicate key'));

    await expect(
      createFailedStartReplacementTaskRunCommand(auth, { runId: 77 }),
    ).resolves.toEqual({
      success: true,
      id: 88,
      taskId: 'replacement-task',
    });
  });
});
