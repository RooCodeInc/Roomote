import { z } from 'zod';

import { ACP_ENVELOPE_EVENT_TYPES, CloudTaskType } from '@roomote/types';
import type { AuthTokenContext, JobTokenContext } from '@roomote/types';

const {
  mockEnqueueCloudTask,
  mockEvaluateFeatureFlag,
  mockFindCloudJob,
  mockFindCloudJobForAccess,
  mockFindCloudJobByIdAndOrgId,
  mockFindCloudJobByJobTokenClaims,
  mockGetSlackThreadFooterText,
  mockGetCommunicationMessages,
  mockQueueSlackMessage,
  mockQueueCommunicationMessage,
  mockQueueLinearMessage,
  mockRecordTaskMessageEnvelope,
  mockRecordTaskInferenceUsage,
} = vi.hoisted(() => ({
  mockEnqueueCloudTask: vi.fn(),
  mockEvaluateFeatureFlag: vi.fn(),
  mockFindCloudJob: vi.fn(),
  mockFindCloudJobForAccess: vi.fn(),
  mockFindCloudJobByIdAndOrgId: vi.fn(),
  mockFindCloudJobByJobTokenClaims: vi.fn(),
  mockGetSlackThreadFooterText: vi.fn(),
  mockGetCommunicationMessages: vi.fn(),
  mockQueueSlackMessage: vi.fn(),
  mockQueueCommunicationMessage: vi.fn(),
  mockQueueLinearMessage: vi.fn(),
  mockRecordTaskMessageEnvelope: vi.fn(),
  mockRecordTaskInferenceUsage: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueCloudTask: mockEnqueueCloudTask,
}));

vi.mock('@roomote/feature-flags/server', () => ({
  getFeatureFlagEvaluator: vi.fn(() => ({
    evaluate: mockEvaluateFeatureFlag,
  })),
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

vi.mock('../lib/cloud-jobs', () => ({
  cloudJobMilestoneFields: [
    'provisionStartedAt',
    'provisionReadyAt',
    'setupCompletedAt',
    'harnessStartedAt',
    'runtimeTaskStartedAt',
    'firstAssistantOutputAt',
  ] as const,
  createSnapshot: vi.fn(),
  dequeueCloudJob: vi.fn(),
  dequeueResumeCloudJob: vi.fn(),
  enqueueSlackPrInactivityCheck: vi.fn(),
  fetchSnapshotEnv: vi.fn(),
  findCloudJob: mockFindCloudJob,
  findCloudJobByIdAndOrgId: mockFindCloudJobByIdAndOrgId,
  findCloudJobByJobTokenClaims: mockFindCloudJobByJobTokenClaims,
  finishCloudJob: vi.fn(),
  getMessageSources: vi.fn(),
  getResolvedGitAuthor: vi.fn(),
  getResolvedRuntimeEnvVars: vi.fn(),
  recordComputeProviderUsage: vi.fn(),
  recordTaskInferenceUsage: mockRecordTaskInferenceUsage,
  recordTaskMessageEnvelope: mockRecordTaskMessageEnvelope,
  refreshGitHubTokenWithMetadata: vi.fn(),
  revertPrCommit: vi.fn(),
  setTaskHarnessSessionId: vi.fn(),
  stampCloudJobMilestone: vi.fn(),
  touchCloudJobHeartbeat: vi.fn(),
  updateCloudJob: vi.fn(),
  updateCloudJobRuntimeState: vi.fn(),
}));

vi.mock('../lib/cloud-jobs/find-cloud-job', () => ({
  findCloudJobForAccess: mockFindCloudJobForAccess,
  findCloudJobByIdAndOrgId: mockFindCloudJobByIdAndOrgId,
  findCloudJobByJobTokenClaims: mockFindCloudJobByJobTokenClaims,
}));

import { cloudJobsRouter } from './cloud-jobs';

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

  return cloudJobsRouter.createCaller({ auth });
}

function createJobCaller() {
  const auth: JobTokenContext = {
    cloudJobId: 42,
    userId: 'user-1',
    tokenType: 'cj',
    version: 1,
  };

  return cloudJobsRouter.createCaller({ auth });
}

describe('cloudJobsRouter queue message guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnqueueCloudTask.mockResolvedValue({ id: 99, taskId: 'task-99' });
    mockEvaluateFeatureFlag.mockResolvedValue(false);
    mockFindCloudJob.mockResolvedValue({ id: 42 });
    mockFindCloudJobForAccess.mockResolvedValue({ id: 42 });
    mockFindCloudJobByIdAndOrgId.mockResolvedValue({ id: 42 });
    mockFindCloudJobByJobTokenClaims.mockResolvedValue({ id: 42 });
    mockGetSlackThreadFooterText.mockResolvedValue(
      '_Reply or use the <https://app.example.com/task/task-1|web app>._',
    );
    mockQueueSlackMessage.mockResolvedValue(undefined);
    mockGetCommunicationMessages.mockResolvedValue([]);
    mockQueueCommunicationMessage.mockResolvedValue(undefined);
    mockQueueLinearMessage.mockResolvedValue(undefined);
    mockRecordTaskMessageEnvelope.mockResolvedValue(undefined);
    mockRecordTaskInferenceUsage.mockResolvedValue({ recorded: true });
  });

  it('rejects queueSlackMessage for auth-token callers', async () => {
    await expect(
      createAuthCaller().queueSlackMessage({
        cloudJobId: 42,
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
        cloudJobId: 42,
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
        cloudJobId: 42,
        sessionId: 'session-1',
        payload: linearAgentSessionEventPayload,
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    expect(mockQueueLinearMessage).not.toHaveBeenCalled();
  });

  it('allows queueSlackMessage for the matching job token', async () => {
    await expect(
      createJobCaller().queueSlackMessage({
        cloudJobId: 42,
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
    expect(mockFindCloudJobByJobTokenClaims).toHaveBeenCalledWith({
      cloudJobId: 42,
      userId: 'user-1',
      tokenType: 'cj',
      version: 1,
    });
  });

  it('allows queueCommunicationMessage for the matching job token', async () => {
    await expect(
      createJobCaller().queueCommunicationMessage({
        cloudJobId: 42,
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
    expect(mockFindCloudJobByJobTokenClaims).toHaveBeenCalledWith({
      cloudJobId: 42,
      userId: 'user-1',
      tokenType: 'cj',
      version: 1,
    });
  });

  it('allows queueLinearMessage for the matching job token', async () => {
    await expect(
      createJobCaller().queueLinearMessage({
        cloudJobId: 42,
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
    expect(mockFindCloudJobByJobTokenClaims).toHaveBeenCalledWith({
      cloudJobId: 42,
      userId: 'user-1',
      tokenType: 'cj',
      version: 1,
    });
  });

  it('rejects job-token callers when token claims do not match the persisted job', async () => {
    mockFindCloudJobByJobTokenClaims.mockResolvedValue(null);

    await expect(createJobCaller().findFirstById(42)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Cannot access resources from a different job',
    });

    expect(mockFindCloudJob).not.toHaveBeenCalled();
  });

  it('rejects job-token-only routes when token claims do not match the persisted job', async () => {
    mockFindCloudJobByJobTokenClaims.mockResolvedValue(null);

    await expect(
      createJobCaller().queueSlackMessage({
        cloudJobId: 42,
        message: {
          text: 'continue',
          user: 'U123',
          ts: '1710000000.123',
        },
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Cannot access resources from a different job',
    });

    expect(mockQueueSlackMessage).not.toHaveBeenCalled();
  });

  it('rejects job-token callers before claim lookup when the input job id differs', async () => {
    await expect(createJobCaller().findFirstById(43)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Cannot access resources from a different job',
    });

    expect(mockFindCloudJobByJobTokenClaims).not.toHaveBeenCalled();
    expect(mockFindCloudJob).not.toHaveBeenCalled();
  });

  it('resolves the footer text for the job thread', async () => {
    mockFindCloudJob.mockResolvedValue({
      id: 42,
      taskId: 'task-1',
      prRepo: null,
      prNumber: null,
    });

    await expect(
      createJobCaller().getSlackThreadFooterText({
        cloudJobId: 42,
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
      channelId: 'C123',
      threadTs: '1710000000.123',
    });
  });

  it('rejects recordMessageEnvelope for auth-token callers', async () => {
    await expect(
      createAuthCaller().recordMessageEnvelope({
        cloudJobId: 42,
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
      message: 'This endpoint is only available to job tokens',
    });

    expect(mockRecordTaskMessageEnvelope).not.toHaveBeenCalled();
  });

  it('allows recordMessageEnvelope for the matching job token', async () => {
    await expect(
      createJobCaller().recordMessageEnvelope({
        cloudJobId: 42,
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
    ).resolves.toBeUndefined();

    expect(mockRecordTaskMessageEnvelope).toHaveBeenCalledWith({
      cloudJobId: 42,
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

  it('rejects recordInferenceUsage for auth-token callers', async () => {
    await expect(
      createAuthCaller().recordInferenceUsage({
        cloudJobId: 42,
        harnessSessionId: 'ses-1',
        messageId: 'msg-1',
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'This endpoint is only available to job tokens',
    });

    expect(mockRecordTaskInferenceUsage).not.toHaveBeenCalled();
  });

  it('allows recordInferenceUsage for the matching job token', async () => {
    await expect(
      createJobCaller().recordInferenceUsage({
        cloudJobId: 42,
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
      cloudJobId: 42,
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
        type: CloudTaskType.StandardTask,
        userId: 'user-1',
        computeProvider: 'modal',
        payload: {
          repo: 'acme/api',
          description: 'Ship it',
        },
      }),
    ).resolves.toEqual({ id: 99, taskId: 'task-99' });

    expect(mockEnqueueCloudTask).toHaveBeenCalledWith(
      expect.objectContaining({
        computeProvider: 'modal',
      }),
    );
  });

  it('allows omitted compute provider values without consulting the feature flag', async () => {
    await expect(
      createAuthCaller().enqueue({
        type: CloudTaskType.StandardTask,
        userId: 'user-1',
        payload: {
          repo: 'acme/api',
          description: 'Ship it',
        },
      }),
    ).resolves.toEqual({ id: 99, taskId: 'task-99' });

    expect(mockEvaluateFeatureFlag).not.toHaveBeenCalled();
    expect(mockEnqueueCloudTask).toHaveBeenCalledWith({
      payload: {
        repo: 'acme/api',
        description: 'Ship it',
      },
      type: CloudTaskType.StandardTask,
      userId: 'user-1',
    });
  });
});
