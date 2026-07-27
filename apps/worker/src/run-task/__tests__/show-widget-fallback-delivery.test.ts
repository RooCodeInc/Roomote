const { claimDelivery, releaseDelivery, replyToChatThread } = vi.hoisted(
  () => ({
    claimDelivery: vi.fn(),
    releaseDelivery: vi.fn(),
    replyToChatThread: vi.fn(),
  }),
);

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      claimShowWidgetFallbackDelivery: claimDelivery,
      releaseShowWidgetFallbackDelivery: releaseDelivery,
    },
  },
}));

vi.mock('../../mcp/roomote-mcp-server/chat-api-client', () => ({
  replyToChatThread,
}));

import { deliverShowWidgetFallback } from '../show-widget-fallback-delivery';

const logger = {
  runId: 42,
  filePath: '/tmp/test.log',
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
};

const delivery = {
  toolCallId: 'call-1',
  title: 'Plan',
  textFallback: 'Plan fallback',
  widgetUrl: 'https://app.example.com/task/task-1#msg-1',
};

const mcpTaskEnv = {
  ROOMOTE_CLOUD_TOKEN: 'token',
  ROOMOTE_PLATFORM_API_URL: 'https://platform.example.com/',
  ROOMOTE_SLACK_CHANNEL: 'C123',
};

describe('deliverShowWidgetFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimDelivery.mockResolvedValue({ claimed: true });
    releaseDelivery.mockResolvedValue(undefined);
    replyToChatThread.mockResolvedValue({ messageTs: '123.456' });
  });

  it('claims and posts a chat fallback once through the shared reply path', async () => {
    await deliverShowWidgetFallback({
      runId: 42,
      delivery,
      mcpTaskEnv,
      logger,
    });

    expect(claimDelivery).toHaveBeenCalledWith({
      runId: 42,
      toolCallId: 'call-1',
    });
    expect(replyToChatThread).toHaveBeenCalledWith(
      {
        token: 'token',
        platformApiUrl: 'https://platform.example.com',
      },
      {
        text: 'Plan\n\nPlan fallback\n\n[View widget](https://app.example.com/task/task-1#msg-1)',
      },
    );
    expect(releaseDelivery).not.toHaveBeenCalled();
  });

  it('skips a fallback another delivery already claimed', async () => {
    claimDelivery.mockResolvedValue({ claimed: false });

    await deliverShowWidgetFallback({
      runId: 42,
      delivery,
      mcpTaskEnv,
      logger,
    });

    expect(replyToChatThread).not.toHaveBeenCalled();
  });

  it('posts a fallback for a communication-channel task', async () => {
    await deliverShowWidgetFallback({
      runId: 42,
      delivery,
      mcpTaskEnv: {
        ROOMOTE_CLOUD_TOKEN: 'token',
        ROOMOTE_PLATFORM_API_URL: 'https://platform.example.com',
        ROOMOTE_COMMUNICATION_PROVIDER: 'discord',
        ROOMOTE_COMMUNICATION_CHANNEL_ID: 'C123',
      },
      logger,
    });

    expect(replyToChatThread).toHaveBeenCalledWith(
      {
        token: 'token',
        platformApiUrl: 'https://platform.example.com',
      },
      expect.objectContaining({
        text: expect.stringContaining('[View widget]'),
      }),
    );
  });

  it('keeps persistence successful when the delivery claim is unavailable', async () => {
    claimDelivery.mockRejectedValue(new Error('claim unavailable'));

    await expect(
      deliverShowWidgetFallback({
        runId: 42,
        delivery,
        mcpTaskEnv,
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(replyToChatThread).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('claim unavailable'),
    );
  });

  it('releases the claim without failing widget persistence when chat fails', async () => {
    replyToChatThread.mockRejectedValue(new Error('chat unavailable'));

    await expect(
      deliverShowWidgetFallback({
        runId: 42,
        delivery,
        mcpTaskEnv,
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(releaseDelivery).toHaveBeenCalledWith({
      runId: 42,
      toolCallId: 'call-1',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('chat unavailable'),
    );
  });

  it('does nothing when the task did not originate from chat', async () => {
    await deliverShowWidgetFallback({
      runId: 42,
      delivery,
      mcpTaskEnv: {
        ROOMOTE_CLOUD_TOKEN: 'token',
        ROOMOTE_PLATFORM_API_URL: 'https://platform.example.com',
      },
      logger,
    });

    expect(claimDelivery).not.toHaveBeenCalled();
    expect(replyToChatThread).not.toHaveBeenCalled();
  });
});
