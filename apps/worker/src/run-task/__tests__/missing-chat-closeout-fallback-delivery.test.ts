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
import {
  recordMissingChatCloseoutFallback,
  settleMissingChatCloseoutFallback,
  waitForMissingChatCloseoutFallbackDelivery,
} from '../missing-chat-closeout-fallback-settlement';

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

  it('holds the fallback until the matching completion is settled', async () => {
    const context = {};
    recordMissingChatCloseoutFallback(context, {
      runId: 42,
      completionId: 'completion-settled',
      text: 'Final answer after the goal settles.',
      mcpTaskEnv,
      logger,
    });

    expect(replyToChatThread).not.toHaveBeenCalled();

    await settleMissingChatCloseoutFallback(context, 'another-completion');
    expect(replyToChatThread).not.toHaveBeenCalled();

    await settleMissingChatCloseoutFallback(context, 'completion-settled');
    expect(replyToChatThread).toHaveBeenCalledWith(expect.any(Object), {
      text: 'Final answer after the goal settles.',
    });
  });

  it('drops an exhausted closeout when a later completion supersedes it', async () => {
    const context = {};
    recordMissingChatCloseoutFallback(context, {
      runId: 42,
      completionId: 'continued-completion',
      text: 'Intermediate answer.',
      mcpTaskEnv,
      logger,
    });

    recordMissingChatCloseoutFallback(context, null);
    await settleMissingChatCloseoutFallback(context, 'continued-completion');
    await waitForMissingChatCloseoutFallbackDelivery(context);

    expect(replyToChatThread).not.toHaveBeenCalled();
  });

  it('delivers when settlement wins the event-ordering race', async () => {
    const context = {};
    await settleMissingChatCloseoutFallback(context, 'completion-late-record');

    recordMissingChatCloseoutFallback(context, {
      runId: 42,
      completionId: 'completion-late-record',
      text: 'Final answer recorded after settlement.',
      mcpTaskEnv,
      logger,
    });
    await waitForMissingChatCloseoutFallbackDelivery(context);

    expect(replyToChatThread).toHaveBeenCalledWith(expect.any(Object), {
      text: 'Final answer recorded after settlement.',
    });
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
