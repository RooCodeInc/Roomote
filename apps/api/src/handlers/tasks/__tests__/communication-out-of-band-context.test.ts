const mocks = vi.hoisted(() => ({
  claimPending: vi.fn(),
  releaseClaimed: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  claimPendingOutOfBandTaskMessages: mocks.claimPending,
  releaseClaimedOutOfBandTaskMessages: mocks.releaseClaimed,
}));

import {
  attachOutOfBandContextToCommunicationMessage,
  releaseCommunicationOutOfBandClaim,
} from '../communication-out-of-band-context.js';

describe('attachOutOfBandContextToCommunicationMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('leaves message unchanged when there is nothing to re-surface', async () => {
    mocks.claimPending.mockResolvedValue([]);

    const message = {
      text: 'please fix those',
      user: 'Matt',
      ts: 'message-2',
      channel: 'thread-1',
    };

    await expect(
      attachOutOfBandContextToCommunicationMessage({
        taskId: 'task-1',
        provider: 'discord',
        message,
      }),
    ).resolves.toEqual({ message, claim: null });
  });

  it('prepends claimed PR review notifications for Discord follow-ups', async () => {
    mocks.claimPending.mockResolvedValue([
      {
        id: 'msg-1',
        ts: 1_720_000_000_000,
        text: 'I left two review comments on PR #42',
      },
    ]);

    const message = {
      text: 'yes, please fix those',
      user: 'Matt',
      userId: 'user-1',
      ts: 'message-2',
      channel: 'thread-1',
      threadTs: 'thread-1',
    };

    const result = await attachOutOfBandContextToCommunicationMessage({
      taskId: 'task-1',
      provider: 'discord',
      message,
    });

    expect(result.claim).toEqual({ messageIds: ['msg-1'] });
    expect(result.message.formattedPrompt).toContain('<out_of_band_context>');
    expect(result.message.formattedPrompt).toContain(
      'I left two review comments on PR #42',
    );
    expect(result.message.formattedPrompt).toContain(
      '<communication_message provider="discord" ts="message-2" author="Matt" channel="thread-1" thread="thread-1">',
    );
    expect(result.message.formattedPrompt).toContain('yes, please fix those');
  });

  it('releases claimed rows when the claim only produced empty text', async () => {
    mocks.claimPending.mockResolvedValue([{ id: 'msg-2', ts: 1, text: '   ' }]);
    mocks.releaseClaimed.mockResolvedValue(undefined);

    const message = {
      text: 'hello',
      user: 'Matt',
      ts: 'message-3',
    };

    await expect(
      attachOutOfBandContextToCommunicationMessage({
        taskId: 'task-1',
        provider: 'discord',
        message,
      }),
    ).resolves.toEqual({ message, claim: null });
    expect(mocks.releaseClaimed).toHaveBeenCalledWith(['msg-2']);
  });

  it('releases claimed message ids on demand', async () => {
    mocks.releaseClaimed.mockResolvedValue(undefined);
    await releaseCommunicationOutOfBandClaim({ messageIds: ['a', 'b'] });
    expect(mocks.releaseClaimed).toHaveBeenCalledWith(['a', 'b']);
  });
});
