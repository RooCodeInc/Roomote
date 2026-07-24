const mocks = vi.hoisted(() => ({
  enqueueTask: vi.fn(),
  attachOutOfBand: vi.fn(),
  releaseOutOfBand: vi.fn(),
  getCommunicationMessages: vi.fn(),
  prependCommunicationMessages: vi.fn(),
  recordTaskRunEvent: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: mocks.enqueueTask,
}));

vi.mock('@roomote/communication', () => ({
  getCommunicationMessages: mocks.getCommunicationMessages,
  prependCommunicationMessages: mocks.prependCommunicationMessages,
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  recordTaskRunEvent: mocks.recordTaskRunEvent,
}));

vi.mock('../communication-out-of-band-context', () => ({
  attachOutOfBandContextToCommunicationMessage: mocks.attachOutOfBand,
  releaseCommunicationOutOfBandClaim: mocks.releaseOutOfBand,
}));

import { resumeCommunicationTaskFromSnapshot } from '../communication-snapshot-resume';

describe('resumeCommunicationTaskFromSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueueTask.mockResolvedValue({ id: 42, taskId: 'task-1' });
    mocks.getCommunicationMessages.mockResolvedValue([]);
    mocks.recordTaskRunEvent.mockResolvedValue(undefined);
    mocks.attachOutOfBand.mockImplementation(
      async ({ message }: { message: Record<string, unknown> }) => ({
        message,
        claim: null,
      }),
    );
  });

  it('stamps the stable provider event id on a Discord resume', async () => {
    await resumeCommunicationTaskFromSnapshot({
      provider: 'discord',
      completedRun: {
        id: 41,
        taskId: 'task-1',
        payload: {
          repo: 'acme/repo',
          communicationProvider: 'discord',
          communicationChannelId: 'channel-1',
          communicationThreadId: 'thread-1',
        },
        port: null,
        snapshotId: 'snapshot-1',
      },
      queuedMessage: {
        provider: 'discord',
        text: 'Make one more change',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-resume',
      },
      channelId: 'channel-1',
      threadId: 'thread-1',
      messageId: 'message-resume',
      guildId: 'guild-1',
    });

    expect(mocks.attachOutOfBand).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        provider: 'discord',
      }),
    );
    expect(mocks.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            communicationProvider: 'discord',
            communicationSourceEventId: 'message-resume',
          }),
        }),
      }),
      { launchClass: 'human' },
    );
  });

  it('includes claimed out-of-band context on Discord snapshot resume', async () => {
    mocks.attachOutOfBand.mockResolvedValue({
      message: {
        provider: 'discord',
        text: 'fix the review comments',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-resume',
        formattedPrompt:
          '<out_of_band_context>\nreview notice\n</out_of_band_context>\n\n<communication_message provider="discord" ts="message-resume">\nfix the review comments\n</communication_message>',
      },
      claim: { messageIds: ['oob-1'] },
    });

    await resumeCommunicationTaskFromSnapshot({
      provider: 'discord',
      completedRun: {
        id: 41,
        taskId: 'task-1',
        payload: {
          repo: 'acme/repo',
          communicationProvider: 'discord',
          communicationChannelId: 'channel-1',
          communicationThreadId: 'thread-1',
        },
        port: null,
        snapshotId: 'snapshot-1',
      },
      queuedMessage: {
        provider: 'discord',
        text: 'fix the review comments',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-resume',
      },
      channelId: 'channel-1',
      threadId: 'thread-1',
      messageId: 'message-resume',
    });

    expect(mocks.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            queuedCommunicationMessages: [
              expect.objectContaining({
                formattedPrompt: expect.stringContaining(
                  '<out_of_band_context>',
                ),
              }),
            ],
          }),
        }),
      }),
      { launchClass: 'human' },
    );
  });

  it('releases claimed out-of-band context when resume enqueue fails', async () => {
    mocks.attachOutOfBand.mockResolvedValue({
      message: {
        provider: 'discord',
        text: 'fix those',
        user: 'Matt',
        ts: 'message-resume',
        formattedPrompt:
          '<out_of_band_context>\nnotice\n</out_of_band_context>',
      },
      claim: { messageIds: ['oob-1'] },
    });
    mocks.enqueueTask.mockRejectedValue(new Error('enqueue failed'));

    await expect(
      resumeCommunicationTaskFromSnapshot({
        provider: 'discord',
        completedRun: {
          id: 41,
          taskId: 'task-1',
          payload: {
            repo: 'acme/repo',
            communicationProvider: 'discord',
            communicationChannelId: 'channel-1',
          },
          port: null,
          snapshotId: 'snapshot-1',
        },
        queuedMessage: {
          provider: 'discord',
          text: 'fix those',
          user: 'Matt',
          ts: 'message-resume',
        },
        channelId: 'channel-1',
      }),
    ).rejects.toThrow('enqueue failed');

    expect(mocks.releaseOutOfBand).toHaveBeenCalledWith({
      messageIds: ['oob-1'],
    });
  });

  it('records Discord wake eyes targets when the resume ack was pinned', async () => {
    await resumeCommunicationTaskFromSnapshot({
      provider: 'discord',
      completedRun: {
        id: 41,
        taskId: 'task-1',
        payload: {
          repo: 'acme/repo',
          communicationProvider: 'discord',
          communicationChannelId: 'channel-1',
          communicationThreadId: 'thread-1',
        },
        port: null,
        snapshotId: 'snapshot-1',
      },
      queuedMessage: {
        provider: 'discord',
        text: 'Make one more change',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-resume',
      },
      channelId: 'channel-1',
      threadId: 'thread-1',
      messageId: 'message-resume',
      guildId: 'guild-1',
      discordWakeAckReaction: {
        channelId: 'thread-1',
        messageId: 'message-resume',
        intakeAckPinned: true,
      },
    });

    expect(mocks.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            communicationSourceEventId: 'message-resume',
            discordReactionChannelId: 'thread-1',
            discordReactionMessageId: 'message-resume',
            discordIntakeAckPending: true,
          }),
        }),
      }),
      { launchClass: 'human' },
    );
  });

  it('carries undelivered source-run queue messages ahead of the new message', async () => {
    const orphanedMessage = {
      provider: 'discord',
      text: 'address the review feedback',
      user: 'roomote',
      userId: 'user-1',
      ts: 'orphaned-ts',
    };
    mocks.getCommunicationMessages.mockResolvedValue([orphanedMessage]);

    await resumeCommunicationTaskFromSnapshot({
      provider: 'discord',
      completedRun: {
        id: 41,
        taskId: 'task-1',
        payload: {
          repo: 'acme/repo',
          communicationProvider: 'discord',
          communicationChannelId: 'channel-1',
        },
        port: null,
        snapshotId: 'snapshot-1',
      },
      queuedMessage: {
        provider: 'discord',
        text: 'new follow-up',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-resume',
      },
      channelId: 'channel-1',
    });

    expect(mocks.getCommunicationMessages).toHaveBeenCalledWith('discord', 41);
    expect(mocks.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            queuedCommunicationMessages: [
              expect.objectContaining({ ts: 'orphaned-ts' }),
              expect.objectContaining({ ts: 'message-resume' }),
            ],
          }),
        }),
      }),
      { launchClass: 'human' },
    );
    expect(mocks.recordTaskRunEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 41,
        source: 'snapshot_resume',
        details: expect.objectContaining({
          carriedCount: 1,
          carriedTs: ['orphaned-ts'],
        }),
      }),
    );
  });

  it('does not duplicate the new message when it is still in the source queue', async () => {
    mocks.getCommunicationMessages.mockResolvedValue([
      {
        provider: 'discord',
        text: 'new follow-up',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-resume',
      },
    ]);

    await resumeCommunicationTaskFromSnapshot({
      provider: 'discord',
      completedRun: {
        id: 41,
        taskId: 'task-1',
        payload: { repo: 'acme/repo' },
        port: null,
        snapshotId: 'snapshot-1',
      },
      queuedMessage: {
        provider: 'discord',
        text: 'new follow-up',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-resume',
      },
      channelId: 'channel-1',
    });

    const payload = mocks.enqueueTask.mock.calls[0]?.[0]?.task?.payload as {
      queuedCommunicationMessages: Array<{ ts: string }>;
    };
    expect(payload.queuedCommunicationMessages).toHaveLength(1);
    expect(mocks.recordTaskRunEvent).not.toHaveBeenCalled();
  });

  it('requeues drained messages when the resume enqueue fails', async () => {
    const orphanedMessage = {
      provider: 'discord',
      text: 'address the review feedback',
      user: 'roomote',
      userId: 'user-1',
      ts: 'orphaned-ts',
    };
    mocks.getCommunicationMessages.mockResolvedValue([orphanedMessage]);
    mocks.enqueueTask.mockRejectedValue(new Error('enqueue failed'));

    await expect(
      resumeCommunicationTaskFromSnapshot({
        provider: 'discord',
        completedRun: {
          id: 41,
          taskId: 'task-1',
          payload: { repo: 'acme/repo' },
          port: null,
          snapshotId: 'snapshot-1',
        },
        queuedMessage: {
          provider: 'discord',
          text: 'new follow-up',
          user: 'Matt',
          userId: 'user-1',
          ts: 'message-resume',
        },
        channelId: 'channel-1',
      }),
    ).rejects.toThrow('enqueue failed');

    expect(mocks.prependCommunicationMessages).toHaveBeenCalledWith(
      'discord',
      41,
      [orphanedMessage],
    );
  });

  it('omits discordIntakeAckPending when wake eyes were not pinned', async () => {
    await resumeCommunicationTaskFromSnapshot({
      provider: 'discord',
      completedRun: {
        id: 41,
        taskId: 'task-1',
        payload: {
          repo: 'acme/repo',
          communicationProvider: 'discord',
          communicationChannelId: 'channel-1',
        },
        port: null,
        snapshotId: 'snapshot-1',
      },
      queuedMessage: {
        provider: 'discord',
        text: 'try again',
        user: 'Matt',
        userId: 'user-1',
        ts: 'message-resume-2',
      },
      channelId: 'channel-1',
      discordWakeAckReaction: {
        channelId: 'channel-1',
        messageId: 'message-resume-2',
        intakeAckPinned: false,
      },
    });

    const payload = mocks.enqueueTask.mock.calls[0]?.[0]?.task?.payload as {
      discordIntakeAckPending?: boolean;
      discordReactionChannelId?: string;
      discordReactionMessageId?: string;
    };
    expect(payload.discordReactionChannelId).toBe('channel-1');
    expect(payload.discordReactionMessageId).toBe('message-resume-2');
    expect(payload.discordIntakeAckPending).toBeUndefined();
  });
});
