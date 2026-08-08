import { z } from 'zod';

import {
  ACP_ENVELOPE_EVENT_TYPES,
  RunStatus,
  TaskPayloadKind,
} from '@roomote/types';
import type { AuthTokenContext, RunTokenContext } from '@roomote/types';

const {
  mockEnqueueTask,
  mockFindTaskRun,
  mockFindTaskRunForAccess,
  mockFindTaskRunByIdAndOrgId,
  mockFindTaskRunByRunTokenClaims,
  mockGetSlackThreadFooterText,
  mockGetCommunicationMessages,
  mockQueueSlackMessage,
  mockQueueCommunicationMessage,
  mockQueueLinearMessage,
  mockRecordTaskMessageEnvelope,
  mockRecordTaskInferenceUsage,
  mockClaimShowWidgetFallbackDelivery,
  mockReleaseShowWidgetFallbackDelivery,
  mockUpdateTaskRun,
} = vi.hoisted(() => ({
  mockEnqueueTask: vi.fn(),
  mockFindTaskRun: vi.fn(),
  mockFindTaskRunForAccess: vi.fn(),
  mockFindTaskRunByIdAndOrgId: vi.fn(),
  mockFindTaskRunByRunTokenClaims: vi.fn(),
  mockGetSlackThreadFooterText: vi.fn(),
  mockGetCommunicationMessages: vi.fn(),
  mockQueueSlackMessage: vi.fn(),
  mockQueueCommunicationMessage: vi.fn(),
  mockQueueLinearMessage: vi.fn(),
  mockRecordTaskMessageEnvelope: vi.fn(),
  mockRecordTaskInferenceUsage: vi.fn(),
  mockClaimShowWidgetFallbackDelivery: vi.fn(),
  mockReleaseShowWidgetFallbackDelivery: vi.fn(),
  mockUpdateTaskRun: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: mockEnqueueTask,
}));

vi.mock('@roomote/redis', () => ({
  getRedis: vi.fn(() => ({ mocked: true })),
}));

vi.mock('@roomote/communication/messages', () => ({
  getCommunicationMessages: mockGetCommunicationMessages,
  queueCommunicationMessage: mockQueueCommunicationMessage,
}));

vi.mock('@roomote/slack', () => ({
  clearPendingSlackRequestUserInput: vi.fn(),
  getSlackThreadFooterText: mockGetSlackThreadFooterText,
  getSlackStartedMessageData: vi.fn(),
  getSlackMessages: vi.fn(),
  getSlackRequestUserInputAnswers: vi.fn(),
  queueSlackMessage: mockQueueSlackMessage,
  queueSlackRequestUserInputAnswer: vi.fn(),
  setPendingSlackRequestUserInput: vi.fn(),
}));

vi.mock('@roomote/linear', () => ({
  agentSessionEventPayloadSchema: z.object({}).passthrough(),
  clearPendingLinearRequestUserInput: vi.fn(),
  getLinearMessages: vi.fn(),
  getLinearRequestUserInputAnswers: vi.fn(),
  queueLinearMessage: mockQueueLinearMessage,
  queueLinearRequestUserInputAnswer: vi.fn(),
  setPendingLinearRequestUserInput: vi.fn(),
}));

vi.mock('../lib/task-runs', () => ({
  taskRunMilestoneFields: [
    'provisionStartedAt',
    'provisionReadyAt',
    'setupCompletedAt',
    'harnessStartedAt',
    'runtimeTaskStartedAt',
    'firstAssistantOutputAt',
  ] as const,
  createSnapshot: vi.fn(),
  dequeueTaskRun: vi.fn(),
  dequeueResumeTaskRun: vi.fn(),
  enqueueSlackPrInactivityCheck: vi.fn(),
  fetchSnapshotEnv: vi.fn(),
  findTaskRun: mockFindTaskRun,
  findTaskRunByIdAndOrgId: mockFindTaskRunByIdAndOrgId,
  findTaskRunByRunTokenClaims: mockFindTaskRunByRunTokenClaims,
  finishRun: vi.fn(),
  getMessageSources: vi.fn(),
  getResolvedGitAuthor: vi.fn(),
  getResolvedRuntimeEnvVars: vi.fn(),
  recordComputeProviderUsage: vi.fn(),
  recordTaskInferenceUsage: mockRecordTaskInferenceUsage,
  recordTaskMessageEnvelope: mockRecordTaskMessageEnvelope,
  claimShowWidgetFallbackDelivery: mockClaimShowWidgetFallbackDelivery,
  releaseShowWidgetFallbackDelivery: mockReleaseShowWidgetFallbackDelivery,
  refreshGitHubTokenWithMetadata: vi.fn(),
  revertPrCommit: vi.fn(),
  setTaskHarnessSessionId: vi.fn(),
  stampTaskRunMilestone: vi.fn(),
  touchTaskRunHeartbeat: vi.fn(),
  updateTaskRun: mockUpdateTaskRun,
  updateTaskRunRuntimeState: vi.fn(),
}));

vi.mock('../lib/task-runs/find-task-run', () => ({
  findTaskRunForAccess: mockFindTaskRunForAccess,
  findTaskRunByIdAndOrgId: mockFindTaskRunByIdAndOrgId,
  findTaskRunByRunTokenClaims: mockFindTaskRunByRunTokenClaims,
}));

import { taskRunsRouter } from './task-runs';

const linearAgentSessionEventPayload = {
  type: 'AgentSessionEvent' as const,
  action: 'prompted' as const,
  organizationId: 'linear-org-1',
  appUserId: 'app-user-1',
  webhookTimestamp: 1710000000901,
  webhookId: 'webhook-1',
  agentSession: {
    id: 'session-1',
    issue: {
      id: 'issue-1',
      identifier: 'ENG-1',
      title: 'Test issue',
      url: 'https://linear.app/issue/ENG-1',
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
};

function createAuthCaller() {
  const auth: AuthTokenContext = {
    userId: 'user-1',
    tokenType: 'auth',
    version: 1,
  };

  return taskRunsRouter.createCaller({ auth });
}

function createRunCaller() {
  const auth: RunTokenContext = {
    runId: 42,
    userId: 'user-1',
    principal: 'user',
    tokenType: 'run',
    version: 1,
  };

  return taskRunsRouter.createCaller({ auth });
}

describe('taskRunsRouter queue message guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnqueueTask.mockResolvedValue({ id: 99, taskId: 'task-99' });
    mockFindTaskRun.mockResolvedValue({ id: 42 });
    mockFindTaskRunForAccess.mockResolvedValue({ id: 42 });
    mockFindTaskRunByIdAndOrgId.mockResolvedValue({ id: 42 });
    mockFindTaskRunByRunTokenClaims.mockResolvedValue({ id: 42 });
    mockGetSlackThreadFooterText.mockResolvedValue(
      '_Reply or use the <https://app.example.com/task/task-1|web app>._',
    );
    mockQueueSlackMessage.mockResolvedValue(undefined);
    mockGetCommunicationMessages.mockResolvedValue([]);
    mockQueueCommunicationMessage.mockResolvedValue(undefined);
    mockQueueLinearMessage.mockResolvedValue(undefined);
    mockRecordTaskMessageEnvelope.mockResolvedValue(null);
    mockRecordTaskInferenceUsage.mockResolvedValue({ recorded: true });
    mockClaimShowWidgetFallbackDelivery.mockResolvedValue({ claimed: true });
    mockReleaseShowWidgetFallbackDelivery.mockResolvedValue(undefined);
    mockUpdateTaskRun.mockResolvedValue(undefined);
  });

  it('strips actingUserId from run-token update input (confused-deputy guard)', async () => {
    // A run token is held by the sandbox runtime. Allowing it to write
    // actingUserId would let a compromised sandbox reassign the run's acting
    // user and read another user's actor-scoped credentials. The schema must
    // drop the field so it never reaches the persistence layer.
    await createRunCaller().update({
      id: 42,
      status: RunStatus.Running,
      actingUserId: 'victim-user',
    } as never);

    expect(mockUpdateTaskRun).toHaveBeenCalledTimes(1);
    const [persistedId, persistedValues] = mockUpdateTaskRun.mock.calls[0]!;
    expect(persistedId).toBe(42);
    expect(persistedValues).not.toHaveProperty('actingUserId');
    expect(persistedValues).toEqual({ status: RunStatus.Running });
  });

  it('strips taskId from run-token update input (run->task binding guard)', async () => {
    // A run token is held by the sandbox runtime. Allowing it to write taskId
    // would let a compromised sandbox re-point its run at a different task,
    // corrupting attribution, visibility, and PR linkage. The schema must drop
    // the field so it never reaches the persistence layer.
    await createRunCaller().update({
      id: 42,
      status: RunStatus.Running,
      taskId: 'attacker-task',
    } as never);

    expect(mockUpdateTaskRun).toHaveBeenCalledTimes(1);
    const [persistedId2, persistedValues2] = mockUpdateTaskRun.mock.calls[0]!;
    expect(persistedId2).toBe(42);
    expect(persistedValues2).not.toHaveProperty('taskId');
    expect(persistedValues2).toEqual({ status: RunStatus.Running });
  });

  it('still persists legitimate non-stripped update fields for the run token', async () => {
    await createRunCaller().update({
      id: 42,
      status: RunStatus.Running,
      result: { ok: true },
    });

    expect(mockUpdateTaskRun).toHaveBeenCalledWith(42, {
      status: RunStatus.Running,
      result: { ok: true },
    });
  });

  it('rejects queueSlackMessage for auth-token callers', async () => {
    await expect(
      createAuthCaller().queueSlackMessage({
        runId: 42,
        message: {
          text: 'continue',
          user: 'U123',
          ts: '1710000000.123',
        },
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    expect(mockQueueSlackMessage).not.toHaveBeenCalled();
  });

  it('rejects queueCommunicationMessage for auth-token callers', async () => {
    await expect(
      createAuthCaller().queueCommunicationMessage({
        runId: 42,
        provider: 'teams',
        message: {
          provider: 'teams',
          text: 'continue',
          user: '29:user',
          ts: 'activity-1',
          channel: '19:channel',
          threadTs: 'root-activity',
        },
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    expect(mockQueueCommunicationMessage).not.toHaveBeenCalled();
  });

  it('rejects queueLinearMessage for auth-token callers', async () => {
    await expect(
      createAuthCaller().queueLinearMessage({
        runId: 42,
        sessionId: 'session-1',
        payload: linearAgentSessionEventPayload,
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    expect(mockQueueLinearMessage).not.toHaveBeenCalled();
  });

  it('allows queueSlackMessage for the matching run token', async () => {
    await expect(
      createRunCaller().queueSlackMessage({
        runId: 42,
        message: {
          text: 'continue',
          user: 'U123',
          ts: '1710000000.123',
        },
      }),
    ).resolves.toBeUndefined();

    expect(mockQueueSlackMessage).toHaveBeenCalledWith(42, {
      text: 'continue',
      user: 'U123',
      ts: '1710000000.123',
    });
    expect(mockFindTaskRunByRunTokenClaims).toHaveBeenCalledWith({
      runId: 42,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    });
  });

  it('allows queueCommunicationMessage for the matching run token', async () => {
    await expect(
      createRunCaller().queueCommunicationMessage({
        runId: 42,
        provider: 'teams',
        message: {
          provider: 'teams',
          text: 'continue',
          user: '29:user',
          ts: 'activity-1',
          channel: '19:channel',
          threadTs: 'root-activity',
        },
      }),
    ).resolves.toBeUndefined();

    expect(mockQueueCommunicationMessage).toHaveBeenCalledWith('teams', 42, {
      provider: 'teams',
      text: 'continue',
      user: '29:user',
      ts: 'activity-1',
      channel: '19:channel',
      threadTs: 'root-activity',
    });
    expect(mockFindTaskRunByRunTokenClaims).toHaveBeenCalledWith({
      runId: 42,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    });
  });

  it('allows queueLinearMessage for the matching run token', async () => {
    await expect(
      createRunCaller().queueLinearMessage({
        runId: 42,
        sessionId: 'session-1',
        payload: linearAgentSessionEventPayload,
      }),
    ).resolves.toBeUndefined();

    expect(mockQueueLinearMessage).toHaveBeenCalledWith(
      42,
      'session-1',
      linearAgentSessionEventPayload,
      undefined,
    );
    expect(mockFindTaskRunByRunTokenClaims).toHaveBeenCalledWith({
      runId: 42,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    });
  });

  it('rejects run-token callers when token claims do not match the persisted run', async () => {
    mockFindTaskRunByRunTokenClaims.mockResolvedValue(null);

    await expect(createRunCaller().findFirstById(42)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Cannot access resources from a different run',
    });

    expect(mockFindTaskRun).not.toHaveBeenCalled();
  });

  it('rejects run-token-only routes when token claims do not match the persisted run', async () => {
    mockFindTaskRunByRunTokenClaims.mockResolvedValue(null);

    await expect(
      createRunCaller().queueSlackMessage({
        runId: 42,
        message: {
          text: 'continue',
          user: 'U123',
          ts: '1710000000.123',
        },
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Cannot access resources from a different run',
    });

    expect(mockQueueSlackMessage).not.toHaveBeenCalled();
  });

  it('rejects run-token callers before claim lookup when the input run id differs', async () => {
    await expect(createRunCaller().findFirstById(43)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Cannot access resources from a different run',
    });

    expect(mockFindTaskRunByRunTokenClaims).not.toHaveBeenCalled();
    expect(mockFindTaskRun).not.toHaveBeenCalled();
  });

  it('resolves the footer text for the run thread', async () => {
    mockFindTaskRun.mockResolvedValue({
      id: 42,
      taskId: 'task-1',
      prRepo: null,
      prNumber: null,
    });

    await expect(
      createRunCaller().getSlackThreadFooterText({
        runId: 42,
        slackChannelId: 'C123',
        threadTs: '1710000000.123',
        taskUrl: 'http://localhost:3000/task/task-1',
      }),
    ).resolves.toBe(
      '_Reply or use the <https://app.example.com/task/task-1|web app>._',
    );

    expect(mockGetSlackThreadFooterText).toHaveBeenCalledWith({
      taskUrl: 'http://localhost:3000/task/task-1',
      taskId: 'task-1',
      prRepo: null,
      prNumber: null,
      linkedPrs: [],
      channelId: 'C123',
      threadTs: '1710000000.123',
    });
  });

  it('rejects recordMessageEnvelope for auth-token callers', async () => {
    await expect(
      createAuthCaller().recordMessageEnvelope({
        runId: 42,
        taskId: 'task-42',
        envelope: {
          ts: 1710000000123,
          eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
          role: 'user',
          protocol: 'roomote_runtime',
          contentBlocks: [],
          metadata: null,
          payload: {},
        },
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'This endpoint is only available to run tokens',
    });

    expect(mockRecordTaskMessageEnvelope).not.toHaveBeenCalled();
  });

  it('allows recordMessageEnvelope for the matching run token', async () => {
    await expect(
      createRunCaller().recordMessageEnvelope({
        runId: 42,
        taskId: 'task-42',
        envelope: {
          ts: 1710000000123,
          eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
          role: 'user',
          protocol: 'roomote_runtime',
          contentBlocks: [],
          metadata: null,
          payload: {},
        },
      }),
    ).resolves.toBeNull();

    expect(mockRecordTaskMessageEnvelope).toHaveBeenCalledWith({
      runId: 42,
      taskId: 'task-42',
      userId: 'user-1',
      envelope: {
        ts: 1710000000123,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        protocol: 'roomote_runtime',
        contentBlocks: [],
        metadata: null,
        payload: {},
      },
    });
  });

  it('claims and releases show_widget fallback delivery for the matching run token', async () => {
    await expect(
      createRunCaller().claimShowWidgetFallbackDelivery({
        runId: 42,
        toolCallId: 'call-1',
      }),
    ).resolves.toEqual({ claimed: true });

    await expect(
      createRunCaller().releaseShowWidgetFallbackDelivery({
        runId: 42,
        toolCallId: 'call-1',
      }),
    ).resolves.toBeUndefined();

    expect(mockClaimShowWidgetFallbackDelivery).toHaveBeenCalledWith({
      runId: 42,
      toolCallId: 'call-1',
    });
    expect(mockReleaseShowWidgetFallbackDelivery).toHaveBeenCalledWith({
      runId: 42,
      toolCallId: 'call-1',
    });
  });

  it('rejects recordInferenceUsage for auth-token callers', async () => {
    await expect(
      createAuthCaller().recordInferenceUsage({
        runId: 42,
        harnessSessionId: 'ses-1',
        messageId: 'msg-1',
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'This endpoint is only available to run tokens',
    });

    expect(mockRecordTaskInferenceUsage).not.toHaveBeenCalled();
  });

  it('allows recordInferenceUsage for the matching run token', async () => {
    await expect(
      createRunCaller().recordInferenceUsage({
        runId: 42,
        harnessSessionId: 'ses-1',
        messageId: 'msg-1',
        providerId: 'openrouter',
        modelId: 'openai/gpt-5.4',
        agent: 'build',
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 2,
        cacheReadTokens: 4,
        cacheWriteTokens: 1,
        totalTokens: 22,
        contextTokens: 14,
        costMicroUsd: 123,
        costSource: 'opencode_message',
        messageCreatedAt: new Date('2026-07-01T12:00:00.000Z'),
        messageCompletedAt: new Date('2026-07-01T12:00:01.000Z'),
      }),
    ).resolves.toEqual({ recorded: true });

    expect(mockRecordTaskInferenceUsage).toHaveBeenCalledWith({
      runId: 42,
      harnessSessionId: 'ses-1',
      messageId: 'msg-1',
      providerId: 'openrouter',
      modelId: 'openai/gpt-5.4',
      agent: 'build',
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      cacheReadTokens: 4,
      cacheWriteTokens: 1,
      totalTokens: 22,
      contextTokens: 14,
      costMicroUsd: 123,
      costSource: 'opencode_message',
      messageCreatedAt: new Date('2026-07-01T12:00:00.000Z'),
      messageCompletedAt: new Date('2026-07-01T12:00:01.000Z'),
    });
  });

  it('allows explicit compute provider overrides for auth-token callers', async () => {
    await expect(
      createAuthCaller().enqueue({
        task: {
          type: TaskPayloadKind.StandardTask,
          computeProvider: 'modal',
          payload: {
            repo: 'acme/api',
            description: 'Ship it',
          },
        },
        initiator: { kind: 'user', userId: 'user-1' },
        workflow: 'standard',
        surface: 'api',
        trigger: 'manual',
      }),
    ).resolves.toEqual({ id: 99, taskId: 'task-99' });

    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          computeProvider: 'modal',
        }),
      }),
    );
  });

  it('validates the initiator union and passes the classified launch through', async () => {
    await expect(
      createAuthCaller().enqueue({
        task: {
          type: TaskPayloadKind.StandardTask,
          payload: {
            repo: 'acme/api',
            description: 'Ship it',
          },
        },
        initiator: { kind: 'user', userId: 'user-1' },
        workflow: 'standard',
        surface: 'api',
        trigger: 'manual',
      }),
    ).resolves.toEqual({ id: 99, taskId: 'task-99' });

    expect(mockEnqueueTask).toHaveBeenCalledWith({
      task: {
        type: TaskPayloadKind.StandardTask,
        payload: {
          repo: 'acme/api',
          description: 'Ship it',
        },
      },
      initiator: { kind: 'user', userId: 'user-1' },
      workflow: 'standard',
      surface: 'api',
      trigger: 'manual',
    });
  });

  it('rejects launches without an initiator', async () => {
    await expect(
      createAuthCaller().enqueue({
        task: {
          type: TaskPayloadKind.StandardTask,
          payload: {
            repo: 'acme/api',
            description: 'Ship it',
          },
        },
        workflow: 'standard',
        surface: 'api',
        trigger: 'manual',
      } as never),
    ).rejects.toThrow();

    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('accepts snapshot resumes through the resume input shape', async () => {
    await expect(
      createAuthCaller().enqueue({
        task: {
          type: TaskPayloadKind.SnapshotResume,
          payload: {
            repo: 'acme/api',
            sourceSnapshotId: 'snap-1',
            sourceRunId: 42,
          },
        },
        actingUserId: 'user-2',
      }),
    ).resolves.toEqual({ id: 99, taskId: 'task-99' });

    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        actingUserId: 'user-2',
        task: expect.objectContaining({
          type: TaskPayloadKind.SnapshotResume,
        }),
      }),
    );
  });
});
