import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock, getJobMock, redisDelMock, redisSetMock } = vi.hoisted(() => ({
  addMock: vi.fn(),
  getJobMock: vi.fn(),
  redisDelMock: vi.fn(),
  redisSetMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(function () {
    return { add: addMock, getJob: getJobMock };
  }),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: vi.fn(() => ({
    del: redisDelMock,
    set: redisSetMock,
  })),
}));

import {
  DISCORD_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_QUEUE_NAME,
  SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_DELAY_MS,
  enqueueDiscordSuggestedTasksOnboardingFollowup,
} from './suggested-tasks-onboarding-followup';

describe('enqueueDiscordSuggestedTasksOnboardingFollowup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisSetMock.mockResolvedValue('OK');
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'job-1' });
  });

  it('schedules one deterministic delayed job for the Discord thread', async () => {
    const request = {
      guildId: 'guild-1',
      channelId: 'channel-1',
      threadId: 'thread-1',
      introMessageId: 'message-1',
      sourceTaskId: 'task-1',
    };

    await expect(
      enqueueDiscordSuggestedTasksOnboardingFollowup(request),
    ).resolves.toEqual({
      enqueued: true,
      jobId:
        'discord-suggested-tasks-onboarding-followup-guild-1-thread-1-task-1',
    });

    expect(DISCORD_SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_QUEUE_NAME).toBe(
      'discord-suggested-tasks-onboarding-followup-jobs',
    );
    expect(SUGGESTED_TASKS_ONBOARDING_FOLLOWUP_DELAY_MS).toBe(86_400_000);
    expect(addMock).toHaveBeenCalledWith(
      'send-suggested-tasks-onboarding-followup',
      request,
      {
        jobId:
          'discord-suggested-tasks-onboarding-followup-guild-1-thread-1-task-1',
        delay: 86_400_000,
      },
    );
  });

  it('uses a deterministic DM job id when no guild is involved', async () => {
    const request = {
      guildId: null,
      channelId: 'dm-channel-1',
      threadId: 'dm-channel-1',
      introMessageId: 'message-1',
      sourceTaskId: 'task-1',
    };

    await expect(
      enqueueDiscordSuggestedTasksOnboardingFollowup(request),
    ).resolves.toEqual({
      enqueued: true,
      jobId:
        'discord-suggested-tasks-onboarding-followup-dm-dm-channel-1-task-1',
    });
    expect(addMock).toHaveBeenCalledWith(
      'send-suggested-tasks-onboarding-followup',
      request,
      expect.objectContaining({
        jobId:
          'discord-suggested-tasks-onboarding-followup-dm-dm-channel-1-task-1',
      }),
    );
  });
});
