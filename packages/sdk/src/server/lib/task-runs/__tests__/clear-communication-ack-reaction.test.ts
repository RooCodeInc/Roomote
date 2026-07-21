import { TaskPayloadKind } from '@roomote/types';

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

  it('clears eyes for SnapshotResume Discord wakes with a pending intake ack', async () => {
    const removeReaction = vi.fn().mockResolvedValue(undefined);
    mockFindTaskRun.mockResolvedValue({
      id: 2,
      payloadKind: TaskPayloadKind.SnapshotResume,
      payload: {
        communicationProvider: 'discord',
        communicationChannelId: 'chan',
        communicationMessageId: 'resume-msg',
        discordReactionChannelId: 'c-1',
        discordReactionMessageId: 'm-1',
        discordIntakeAckPending: true,
      },
    });
    mockGetCommunicationProviderAdapter.mockResolvedValue({
      removeReaction,
    });

    await expect(clearCommunicationAckReaction({ runId: 2 })).resolves.toEqual({
      cleared: true,
    });
    expect(removeReaction).toHaveBeenCalledWith({
      channelId: 'c-1',
      messageId: 'm-1',
      name: 'eyes',
    });
  });

  it('no-ops SnapshotResume wakes without a pending intake ack flag', async () => {
    mockFindTaskRun.mockResolvedValue({
      id: 3,
      payloadKind: TaskPayloadKind.SnapshotResume,
      payload: {
        communicationProvider: 'discord',
        discordReactionChannelId: 'c-1',
        discordReactionMessageId: 'm-1',
      },
    });

    await expect(clearCommunicationAckReaction({ runId: 3 })).resolves.toEqual({
      cleared: false,
      reason: 'missing_target',
    });
    expect(mockGetCommunicationProviderAdapter).not.toHaveBeenCalled();
  });

  it('skips non-Discord providers', async () => {
    mockFindTaskRun.mockResolvedValue({
      id: 1,
      payloadKind: TaskPayloadKind.StandardTask,
      payload: { communicationProvider: 'telegram' },
    });

    await expect(clearCommunicationAckReaction({ runId: 1 })).resolves.toEqual({
      cleared: false,
      reason: 'unsupported_provider',
    });
    expect(mockGetCommunicationProviderAdapter).not.toHaveBeenCalled();
  });

  it('removes eyes only when intake ack is pending on a dedicated target', async () => {
    const removeReaction = vi.fn().mockResolvedValue(undefined);
    mockFindTaskRun.mockResolvedValue({
      id: 7,
      payloadKind: TaskPayloadKind.StandardTask,
      payload: {
        communicationProvider: 'discord',
        discordReactionChannelId: 'c-1',
        discordReactionMessageId: 'm-1',
        discordIntakeAckPending: true,
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

  it('does not use communication message ids as intake-ack targets', async () => {
    mockFindTaskRun.mockResolvedValue({
      id: 8,
      payloadKind: TaskPayloadKind.StandardTask,
      payload: {
        communicationProvider: 'discord',
        communicationChannelId: 'chan',
        communicationMessageId: 'origin',
      },
    });

    await expect(clearCommunicationAckReaction({ runId: 8 })).resolves.toEqual({
      cleared: false,
      reason: 'missing_target',
    });
    expect(mockGetCommunicationProviderAdapter).not.toHaveBeenCalled();
  });

  it('skips when dedicated reaction targets exist without intake pending', async () => {
    mockFindTaskRun.mockResolvedValue({
      id: 10,
      payloadKind: TaskPayloadKind.StandardTask,
      payload: {
        communicationProvider: 'discord',
        discordReactionChannelId: 'c-10',
        discordReactionMessageId: 'm-10',
      },
    });

    await expect(clearCommunicationAckReaction({ runId: 10 })).resolves.toEqual(
      {
        cleared: false,
        reason: 'missing_target',
      },
    );
    expect(mockGetCommunicationProviderAdapter).not.toHaveBeenCalled();
  });

  it('retries once when removeReaction fails, then reports remove_failed', async () => {
    const removeReaction = vi
      .fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockRejectedValueOnce(new Error('still failing'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockFindTaskRun.mockResolvedValue({
      id: 9,
      payloadKind: TaskPayloadKind.StandardTask,
      payload: {
        communicationProvider: 'discord',
        discordReactionChannelId: 'c-9',
        discordReactionMessageId: 'm-9',
        discordIntakeAckPending: true,
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
