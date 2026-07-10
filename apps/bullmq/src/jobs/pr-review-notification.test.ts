import { z } from 'zod';

const {
  mockFindFirstTaskRun,
  mockFindFirstTaskPullRequest,
  mockFindFirstSlackInstallation,
  mockConsumePending,
  mockRequeuePending,
  mockSchedule,
  mockPrepareDelivery,
  mockRecordDelivery,
  mockPostMessage,
  mockTeamsPostMessage,
  mockCreateTeamsProvider,
  mockTelegramPostMessage,
} = vi.hoisted(() => ({
  mockFindFirstTaskRun: vi.fn(),
  mockFindFirstTaskPullRequest: vi.fn(),
  mockFindFirstSlackInstallation: vi.fn(),
  mockConsumePending: vi.fn(),
  mockRequeuePending: vi.fn(),
  mockSchedule: vi.fn(),
  mockPrepareDelivery: vi.fn(),
  mockRecordDelivery: vi.fn(),
  mockPostMessage: vi.fn(),
  mockTeamsPostMessage: vi.fn(),
  mockCreateTeamsProvider: vi.fn(),
  mockTelegramPostMessage: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: {
        findFirst: (...args: unknown[]) => mockFindFirstTaskRun(...args),
      },
      taskPullRequests: {
        findFirst: (...args: unknown[]) =>
          mockFindFirstTaskPullRequest(...args),
      },
      slackInstallations: {
        findFirst: (...args: unknown[]) =>
          mockFindFirstSlackInstallation(...args),
      },
    },
  },
  and: vi.fn(() => 'and-condition'),
  eq: vi.fn(() => 'eq-condition'),
  desc: vi.fn(() => 'desc-order'),
  taskRuns: { taskId: 'taskId', createdAt: 'createdAt' },
  taskPullRequests: {
    taskId: 'taskId',
    repository: 'repository',
    prNumber: 'prNumber',
  },
  slackInstallations: { isActive: 'isActive' },
}));

vi.mock('@roomote/env', () => ({
  Env: {
    R_TEAMS_BOT_APP_ID: 'teams-app',
    R_TEAMS_BOT_APP_PASSWORD: 'teams-secret',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
  },
}));

vi.mock('@roomote/sdk/server', () => ({
  PR_REVIEW_NOTIFICATION_DEFER_MS: 5000,
  PR_REVIEW_NOTIFICATION_MAX_DEFERRALS: 3,
  prReviewNotificationRequestSchema: z.object({
    taskId: z.string(),
    repository: z.string(),
    prNumber: z.number(),
    prUrl: z.string(),
    deferrals: z.number().default(0),
  }),
  consumePendingPrReviewActivity: mockConsumePending,
  requeuePendingPrReviewActivity: mockRequeuePending,
  schedulePrReviewNotificationJob: mockSchedule,
  createTeamsCommunicationProviderFromRuntimeCredentials:
    mockCreateTeamsProvider,
  preparePrReviewNotificationDelivery: mockPrepareDelivery,
  recordPrReviewNotificationDeliveryBestEffort: mockRecordDelivery,
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: class MockSlackNotifier {
    postMessage = mockPostMessage;
  },
}));

vi.mock('@roomote/communication/telegram-provider', () => ({
  TelegramCommunicationProvider: class MockTelegramProvider {
    postMessage = mockTelegramPostMessage;
  },
}));

import type { Job } from 'bullmq';

import { RunStatus } from '@roomote/types';

import { prReviewNotificationJob } from './pr-review-notification';

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      taskId: 'task-1',
      repository: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      deferrals: 0,
      ...overrides,
    },
  } as unknown as Job<never, void, string>;
}

const events = [{ kind: 'review_comment' as const, authorLogin: 'alice' }];

describe('prReviewNotificationJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockFindFirstTaskRun.mockResolvedValue({
      id: 1,
      payload: { channel: 'C123' },
      slackThreadTs: '111.222',
      sourceRunId: null,
      status: RunStatus.Idle,
      taskPhase: 'waiting_for_prompt',
    });
    mockFindFirstTaskPullRequest.mockResolvedValue({ status: 'open' });
    mockFindFirstSlackInstallation.mockResolvedValue({
      botAccessToken: 'xoxb-token',
    });
    mockConsumePending.mockResolvedValue(events);
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'slack',
        channelId: 'C123',
        threadId: '111.222',
      },
      text: 'formatted-message',
    });
    mockRecordDelivery.mockResolvedValue(undefined);
    mockPostMessage.mockResolvedValue('999.888');
    mockCreateTeamsProvider.mockReturnValue({
      postMessage: mockTeamsPostMessage,
    });
    mockTeamsPostMessage.mockResolvedValue({ provider: 'teams' });
    mockTelegramPostMessage.mockResolvedValue({ provider: 'telegram' });
  });

  it('posts the aggregated notification to the originating Slack thread when the task is idle', async () => {
    await prReviewNotificationJob(makeJob() as never);

    expect(mockPrepareDelivery).toHaveBeenCalledWith({
      taskRun: expect.objectContaining({ id: 1 }),
      request: {
        taskId: 'task-1',
        repository: 'owner/repo',
        prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42',
        deferrals: 0,
      },
      events,
    });
    expect(mockPostMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '111.222',
      text: 'formatted-message',
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(mockRecordDelivery).toHaveBeenCalledWith({
      runId: 1,
      taskId: 'task-1',
      route: {
        provider: 'slack',
        channelId: 'C123',
        threadId: '111.222',
      },
      text: 'formatted-message',
      messageTs: '999.888',
    });
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('posts to Teams conversations with markdown formatting', async () => {
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'teams',
        channelId: '19:abc',
        threadId: 'thread-1',
        serviceUrl: 'https://smba.example.com',
      },
      text: 'formatted-message',
    });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockTeamsPostMessage).toHaveBeenCalledWith({
      channelId: '19:abc',
      serviceUrl: 'https://smba.example.com',
      threadId: 'thread-1',
      replyToMessageId: 'thread-1',
      text: 'formatted-message',
      textFormat: 'markdown',
    });
    expect(mockRecordDelivery).toHaveBeenCalledWith({
      runId: 1,
      taskId: 'task-1',
      route: {
        provider: 'teams',
        channelId: '19:abc',
        threadId: 'thread-1',
        serviceUrl: 'https://smba.example.com',
      },
      text: 'formatted-message',
    });
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('posts to Telegram chats as plain text', async () => {
    mockPrepareDelivery.mockResolvedValue({
      post: true,
      route: {
        provider: 'telegram',
        channelId: '12345',
        threadId: '77',
      },
      text: 'formatted-message',
    });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockTelegramPostMessage).toHaveBeenCalledWith({
      channelId: '12345',
      threadId: '77',
      text: 'formatted-message',
    });
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('defers while the task is actively running', async () => {
    mockFindFirstTaskRun.mockResolvedValue({
      id: 1,
      payload: {},
      slackThreadTs: '111.222',
      sourceRunId: null,
      status: RunStatus.Running,
      taskPhase: 'running',
    });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockSchedule).toHaveBeenCalledWith({
      request: expect.objectContaining({ deferrals: 1 }),
      delayMs: 5000,
    });
    expect(mockConsumePending).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('defers during follow-up turns on a live sandbox (Idle status with a running phase)', async () => {
    mockFindFirstTaskRun.mockResolvedValue({
      id: 1,
      payload: {},
      slackThreadTs: '111.222',
      sourceRunId: null,
      status: RunStatus.Idle,
      taskPhase: 'running',
    });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockSchedule).toHaveBeenCalledWith({
      request: expect.objectContaining({ deferrals: 1 }),
      delayMs: 5000,
    });
    expect(mockConsumePending).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('drops pending activity without posting when the deferral cap is reached while still running', async () => {
    mockFindFirstTaskRun.mockResolvedValue({
      id: 1,
      payload: {},
      slackThreadTs: '111.222',
      sourceRunId: null,
      status: RunStatus.Running,
      taskPhase: 'running',
    });

    await prReviewNotificationJob(makeJob({ deferrals: 3 }) as never);

    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockConsumePending).toHaveBeenCalled();
    expect(mockPrepareDelivery).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('skips (and drains) when the PR is already merged', async () => {
    mockFindFirstTaskPullRequest.mockResolvedValue({ status: 'merged' });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockConsumePending).toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('skips silently when there is no pending activity', async () => {
    mockConsumePending.mockResolvedValue([]);

    await prReviewNotificationJob(makeJob() as never);

    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('skips when the task has no conversation routing', async () => {
    mockPrepareDelivery.mockResolvedValue({
      post: false,
      reason: 'no_conversation_route',
    });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('skips without posting when the notification is not worth sending', async () => {
    mockPrepareDelivery.mockResolvedValue({
      post: false,
      reason: 'not_worth_notifying',
    });

    await prReviewNotificationJob(makeJob() as never);

    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(mockRequeuePending).not.toHaveBeenCalled();
  });

  it('requeues drained events and rethrows when delivery preparation fails', async () => {
    mockPrepareDelivery.mockRejectedValue(new Error('model unavailable'));

    await expect(prReviewNotificationJob(makeJob() as never)).rejects.toThrow(
      'model unavailable',
    );

    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(mockRequeuePending).toHaveBeenCalledWith({
      target: { taskId: 'task-1', repository: 'owner/repo', prNumber: 42 },
      events,
    });
  });

  it('requeues drained events and rethrows when posting fails', async () => {
    mockPostMessage.mockRejectedValue(new Error('slack down'));

    await expect(prReviewNotificationJob(makeJob() as never)).rejects.toThrow(
      'slack down',
    );

    expect(mockRequeuePending).toHaveBeenCalledWith({
      target: { taskId: 'task-1', repository: 'owner/repo', prNumber: 42 },
      events,
    });
  });
});
