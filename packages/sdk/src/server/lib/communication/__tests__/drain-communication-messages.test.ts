const mocks = vi.hoisted(() => ({
  enqueueTask: vi.fn(),
  getCommunicationMessages: vi.fn(),
  peekCommunicationMessageCount: vi.fn(),
  prependCommunicationMessages: vi.fn(),
  recordTaskRunEvent: vi.fn(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: mocks.enqueueTask,
}));

vi.mock('@roomote/communication', () => ({
  getCommunicationMessages: mocks.getCommunicationMessages,
  peekCommunicationMessageCount: mocks.peekCommunicationMessageCount,
  prependCommunicationMessages: mocks.prependCommunicationMessages,
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  recordTaskRunEvent: mocks.recordTaskRunEvent,
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({ set: mocks.redisSet, del: mocks.redisDel }),
}));

import { drainCommunicationMessagesToResumeRun } from '../drain-communication-messages';

const orphanedMessage = {
  text: 'address the review feedback',
  user: 'roomote',
  userId: 'user-1',
  ts: 'orphaned-ts',
};

const sourceRun = {
  id: 41,
  taskId: 'task-1',
  snapshotId: 'snapshot-1',
  payload: {
    repo: 'acme/repo',
    communicationProvider: 'discord',
    communicationChannelId: 'channel-1',
    communicationThreadId: 'thread-1',
    discordTaskThread: true,
  },
  port: null,
};

describe('drainCommunicationMessagesToResumeRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueueTask.mockResolvedValue({ id: 42, taskId: 'task-1' });
    mocks.peekCommunicationMessageCount.mockResolvedValue(1);
    mocks.getCommunicationMessages.mockResolvedValue([orphanedMessage]);
    mocks.recordTaskRunEvent.mockResolvedValue(undefined);
    mocks.redisSet.mockResolvedValue('OK');
  });

  it('creates a resume run embedding the drained messages', async () => {
    const result = await drainCommunicationMessagesToResumeRun(sourceRun);

    expect(result).toEqual({
      resumed: true,
      runId: 42,
      taskId: 'task-1',
      provider: 'discord',
      messageCount: 1,
    });
    expect(mocks.enqueueTask).toHaveBeenCalledWith({
      task: expect.objectContaining({
        sourceSnapshotId: 'snapshot-1',
        sourceRunId: 41,
        payload: expect.objectContaining({
          communicationProvider: 'discord',
          communicationChannelId: 'channel-1',
          discordTaskThread: true,
          queuedCommunicationMessages: [
            expect.objectContaining({ ts: 'orphaned-ts', provider: 'discord' }),
          ],
        }),
      }),
      actingUserId: 'user-1',
    });
    expect(mocks.recordTaskRunEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 41,
        source: 'snapshot_resume',
        details: expect.objectContaining({
          drainedCount: 1,
          resumeRunId: 42,
        }),
      }),
    );
  });

  it('does nothing when the run has no communication provider', async () => {
    const result = await drainCommunicationMessagesToResumeRun({
      ...sourceRun,
      payload: { repo: 'acme/repo' },
    });

    expect(result).toEqual({
      resumed: false,
      reason: 'no_communication_provider',
    });
    expect(mocks.peekCommunicationMessageCount).not.toHaveBeenCalled();
  });

  it('does nothing when the queue is empty', async () => {
    mocks.peekCommunicationMessageCount.mockResolvedValue(0);

    const result = await drainCommunicationMessagesToResumeRun(sourceRun);

    expect(result).toEqual({
      resumed: false,
      reason: 'no_pending_messages',
      provider: 'discord',
    });
    expect(mocks.enqueueTask).not.toHaveBeenCalled();
  });

  it('skips when another drain holds the lock', async () => {
    mocks.redisSet.mockResolvedValue(null);

    const result = await drainCommunicationMessagesToResumeRun(sourceRun);

    expect(result).toEqual({
      resumed: false,
      reason: 'resume_lock_held',
      provider: 'discord',
    });
    expect(mocks.getCommunicationMessages).not.toHaveBeenCalled();
  });

  it('restores drained messages and releases the lock when enqueue fails', async () => {
    mocks.enqueueTask.mockRejectedValue(new Error('enqueue failed'));

    await expect(
      drainCommunicationMessagesToResumeRun(sourceRun),
    ).rejects.toThrow('enqueue failed');

    expect(mocks.prependCommunicationMessages).toHaveBeenCalledWith(
      'discord',
      41,
      [orphanedMessage],
    );
    expect(mocks.redisDel).toHaveBeenCalledWith('discord:drain-resume-lock:41');
  });

  it('prefers the snapshot id override', async () => {
    await drainCommunicationMessagesToResumeRun(
      { ...sourceRun, snapshotId: null },
      'fresh-snapshot',
    );

    expect(mocks.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          sourceSnapshotId: 'fresh-snapshot',
        }),
      }),
    );
  });
});
