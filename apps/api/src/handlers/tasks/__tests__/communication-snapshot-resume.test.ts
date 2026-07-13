const mocks = vi.hoisted(() => ({
  enqueueTask: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: mocks.enqueueTask,
}));

import { resumeCommunicationTaskFromSnapshot } from '../communication-snapshot-resume.js';

describe('resumeCommunicationTaskFromSnapshot', () => {
  it('stamps the stable provider event id on a Discord resume', async () => {
    mocks.enqueueTask.mockResolvedValue({ id: 42, taskId: 'task-1' });

    await resumeCommunicationTaskFromSnapshot({
      provider: 'discord',
      completedRun: {
        id: 41,
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
});
