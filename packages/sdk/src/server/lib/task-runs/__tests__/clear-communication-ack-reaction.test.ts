const { mockFindTaskRun, mockGetCommunicationProviderAdapter } = vi.hoisted(
  () => ({
    mockFindTaskRun: vi.fn(),
    mockGetCommunicationProviderAdapter: vi.fn(),
  }),
);

vi.mock('../find-task-run', () => ({
  findTaskRun: mockFindTaskRun,
}));

vi.mock('../../communication-providers', () => ({
  getCommunicationProviderAdapter: mockGetCommunicationProviderAdapter,
}));

import { clearCommunicationAckReaction } from '../clear-communication-ack-reaction';

describe('clearCommunicationAckReaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns run_not_found when the task run is missing', async () => {
    mockFindTaskRun.mockResolvedValue(undefined);

    await expect(clearCommunicationAckReaction({ runId: 99 })).resolves.toEqual(
      { cleared: false, reason: 'run_not_found' },
    );
  });

  it('skips non-Discord providers', async () => {
    mockFindTaskRun.mockResolvedValue({
      id: 1,
      payload: { communicationProvider: 'telegram' },
    });

    await expect(clearCommunicationAckReaction({ runId: 1 })).resolves.toEqual({
      cleared: false,
      reason: 'unsupported_provider',
    });
    expect(mockGetCommunicationProviderAdapter).not.toHaveBeenCalled();
  });

  it('removes eyes from the Discord reaction target', async () => {
    const removeReaction = vi.fn().mockResolvedValue(undefined);
    mockFindTaskRun.mockResolvedValue({
      id: 7,
      payload: {
        communicationProvider: 'discord',
        discordReactionChannelId: 'c-1',
        discordReactionMessageId: 'm-1',
      },
    });
    mockGetCommunicationProviderAdapter.mockResolvedValue({
      removeReaction,
    });

    await expect(clearCommunicationAckReaction({ runId: 7 })).resolves.toEqual({
      cleared: true,
    });

    expect(mockGetCommunicationProviderAdapter).toHaveBeenCalledWith('discord');
    expect(removeReaction).toHaveBeenCalledWith({
      channelId: 'c-1',
      messageId: 'm-1',
      name: 'eyes',
    });
  });

  it('falls back to communication channel/message ids', async () => {
    const removeReaction = vi.fn().mockResolvedValue(undefined);
    mockFindTaskRun.mockResolvedValue({
      id: 8,
      payload: {
        communicationProvider: 'discord',
        communicationChannelId: 'chan',
        communicationMessageId: 'origin',
      },
    });
    mockGetCommunicationProviderAdapter.mockResolvedValue({
      removeReaction,
    });

    await expect(clearCommunicationAckReaction({ runId: 8 })).resolves.toEqual({
      cleared: true,
    });

    expect(removeReaction).toHaveBeenCalledWith({
      channelId: 'chan',
      messageId: 'origin',
      name: 'eyes',
    });
  });

  it('retries once when removeReaction fails, then reports remove_failed', async () => {
    const removeReaction = vi
      .fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockRejectedValueOnce(new Error('still failing'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockFindTaskRun.mockResolvedValue({
      id: 9,
      payload: {
        communicationProvider: 'discord',
        discordReactionChannelId: 'c-9',
        discordReactionMessageId: 'm-9',
      },
    });
    mockGetCommunicationProviderAdapter.mockResolvedValue({
      removeReaction,
    });

    await expect(clearCommunicationAckReaction({ runId: 9 })).resolves.toEqual({
      cleared: false,
      reason: 'remove_failed',
    });

    expect(removeReaction).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });
});
