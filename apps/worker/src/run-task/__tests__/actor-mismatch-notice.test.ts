const { mockReplyToChatThread, mockGetRoomoteConfig } = vi.hoisted(() => ({
  mockReplyToChatThread: vi.fn(),
  mockGetRoomoteConfig: vi.fn(),
}));

vi.mock('../../mcp/roomote-mcp-server/chat-api-client', () => ({
  replyToChatThread: mockReplyToChatThread,
}));

vi.mock('../../mcp/roomote-mcp-server/config', () => ({
  getRoomoteConfig: mockGetRoomoteConfig,
}));

import {
  ACTOR_MISMATCH_SKIP_NOTICE_TEXT,
  createActorMismatchSkipNotifier,
} from '../actor-mismatch-notice';

describe('createActorMismatchSkipNotifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRoomoteConfig.mockReturnValue({
      token: 'run-token',
      platformApiUrl: 'https://api.example.test',
    });
    mockReplyToChatThread.mockResolvedValue({ ok: true });
  });

  it('posts the resend notice to the task chat thread once per sender', async () => {
    const notify = createActorMismatchSkipNotifier({
      runId: 42,
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    await notify({ senderUserId: 'user-2', serverActorUserId: 'user-1' });
    await notify({ senderUserId: 'user-2', serverActorUserId: 'user-1' });
    await notify({ senderUserId: 'user-3', serverActorUserId: 'user-1' });

    // Deduped per sender: a burst of skipped messages from the same sender
    // produces a single notice.
    expect(mockReplyToChatThread).toHaveBeenCalledTimes(2);
    expect(mockReplyToChatThread).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'run-token' }),
      { text: ACTOR_MISMATCH_SKIP_NOTICE_TEXT },
    );
  });

  it('never throws when the post fails (skipping is the security decision, the notice is UX)', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    mockReplyToChatThread.mockRejectedValueOnce(
      new Error('no Slack channel context'),
    );

    const notify = createActorMismatchSkipNotifier({ runId: 42, logger });

    await expect(
      notify({ senderUserId: 'user-2', serverActorUserId: 'user-1' }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to post skip notice for run 42'),
    );
  });

  it('logs and returns when no cloud token is available', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    mockGetRoomoteConfig.mockReturnValueOnce(null);

    const notify = createActorMismatchSkipNotifier({ runId: 42, logger });

    await expect(
      notify({ senderUserId: 'user-2', serverActorUserId: 'user-1' }),
    ).resolves.toBeUndefined();

    expect(mockReplyToChatThread).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no cloud token available'),
    );
  });
});
