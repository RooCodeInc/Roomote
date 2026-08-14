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
      claimMissingChatCloseoutFallbackDelivery: claimDelivery,
      releaseMissingChatCloseoutFallbackDelivery: releaseDelivery,
    },
  },
}));

vi.mock('../../mcp/roomote-mcp-server/chat-api-client', () => ({
  replyToChatThread,
}));

import {
  deliverMissingChatCloseoutFallback,
  EMPTY_CHAT_CLOSEOUT_FALLBACK_TEXT,
} from '../missing-chat-closeout-fallback-delivery';

const logger = {
  runId: 42,
  filePath: '/tmp/test.log',
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
};

const mcpTaskEnv = {
  ROOMOTE_CLOUD_TOKEN: 'token',
  ROOMOTE_PLATFORM_API_URL: 'https://platform.example.com/',
  ROOMOTE_COMMUNICATION_PROVIDER: 'discord',
  ROOMOTE_COMMUNICATION_CHANNEL_ID: 'channel-1',
};

describe('deliverMissingChatCloseoutFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimDelivery.mockResolvedValue({ claimed: true });
    releaseDelivery.mockResolvedValue(undefined);
    replyToChatThread.mockResolvedValue({ messageTs: '123.456' });
  });

  it('posts the last finalized assistant message through the shared chat path', async () => {
    await deliverMissingChatCloseoutFallback({
      runId: 42,
      completionId: 'completion-1',
      text: 'Final answer from the assistant.',
      mcpTaskEnv,
      logger,
    });

    expect(claimDelivery).toHaveBeenCalledWith({
      runId: 42,
      completionId: 'completion-1',
    });
    expect(replyToChatThread).toHaveBeenCalledWith(
      {
        token: 'token',
        platformApiUrl: 'https://platform.example.com',
      },
      { text: 'Final answer from the assistant.' },
    );
    expect(releaseDelivery).not.toHaveBeenCalled();
  });

  it('posts a neutral fallback when the finalized assistant message is empty', async () => {
    await deliverMissingChatCloseoutFallback({
      runId: 42,
      completionId: 'completion-1',
      text: '   ',
      mcpTaskEnv,
      logger,
    });

    expect(replyToChatThread).toHaveBeenCalledWith(expect.any(Object), {
      text: EMPTY_CHAT_CLOSEOUT_FALLBACK_TEXT,
    });
  });

  it('skips a fallback another delivery already claimed', async () => {
    claimDelivery.mockResolvedValue({ claimed: false });

    await deliverMissingChatCloseoutFallback({
      runId: 42,
      completionId: 'completion-1',
      text: 'Final answer.',
      mcpTaskEnv,
      logger,
    });

    expect(replyToChatThread).not.toHaveBeenCalled();
  });

  it('releases the claim without failing settlement when chat delivery fails', async () => {
    replyToChatThread.mockRejectedValue(new Error('chat unavailable'));

    await expect(
      deliverMissingChatCloseoutFallback({
        runId: 42,
        completionId: 'completion-1',
        text: 'Final answer.',
        mcpTaskEnv,
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(releaseDelivery).toHaveBeenCalledWith({
      runId: 42,
      completionId: 'completion-1',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('chat unavailable'),
    );
  });

  it('does nothing when the task did not originate from chat', async () => {
    await deliverMissingChatCloseoutFallback({
      runId: 42,
      completionId: 'completion-1',
      text: 'Final answer.',
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
