import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSettingsMock, postMessageMock, resolveCredentialsMock } = vi.hoisted(
  () => ({
    getSettingsMock: vi.fn(),
    postMessageMock: vi.fn(),
    resolveCredentialsMock: vi.fn(),
  }),
);

vi.mock('@roomote/env', () => ({
  Env: { R_APP_URL: 'https://app.example.com' },
}));

vi.mock('@roomote/db/server', () => ({
  getBackgroundAgentSettingsForDeployment: getSettingsMock,
  resolveDiscordRuntimeCredentials: resolveCredentialsMock,
}));

vi.mock('@roomote/sdk/server', async () => {
  const { z } = await import('zod');

  return {
    discordSuggestedTasksOnboardingFollowupRequestSchema: z.object({
      guildId: z.string().nullable(),
      channelId: z.string(),
      threadId: z.string(),
      introMessageId: z.string(),
      sourceTaskId: z.string(),
    }),
  };
});

vi.mock('@roomote/communication/discord-provider', () => ({
  DiscordCommunicationProvider: vi.fn().mockImplementation(function () {
    return { postMessage: postMessageMock };
  }),
}));

import { discordSuggestedTasksOnboardingFollowupJob } from './discord-suggested-tasks-onboarding-followup';

function buildJob(data: unknown): Job {
  return { id: 'job-1', data } as Job;
}

const JOB_DATA = {
  guildId: 'guild-1',
  channelId: 'channel-1',
  threadId: 'thread-1',
  introMessageId: 'message-1',
  sourceTaskId: 'task-1',
};

describe('discordSuggestedTasksOnboardingFollowupJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettingsMock.mockResolvedValue({ suggesterFrequency: 'off' });
    resolveCredentialsMock.mockResolvedValue({
      botToken: 'bot-token',
      applicationId: 'application-1',
    });
    postMessageMock.mockResolvedValue({
      provider: 'discord',
      channelId: 'thread-1',
      messageId: 'message-2',
    });
  });

  it('posts the follow-up in the existing thread with an Automations button', async () => {
    await discordSuggestedTasksOnboardingFollowupJob(buildJob(JOB_DATA));

    expect(postMessageMock).toHaveBeenCalledWith({
      channelId: 'channel-1',
      threadId: 'thread-1',
      text: expect.any(String),
      textFormat: 'markdown',
      buttons: [
        [
          expect.objectContaining({
            text: 'Open Automations',
            url: expect.stringContaining(
              '/automations?utm_source=discord&utm_medium=link&utm_campaign=discord.suggested_tasks_followup#suggest-ideas',
            ),
          }),
        ],
      ],
    });
    expect(postMessageMock.mock.calls[0]?.[0]).not.toHaveProperty(
      'replyToMessageId',
    );
  });

  it('posts the follow-up in the linked user DM', async () => {
    await discordSuggestedTasksOnboardingFollowupJob(
      buildJob({
        ...JOB_DATA,
        guildId: null,
        channelId: 'dm-channel-1',
        threadId: 'dm-channel-1',
      }),
    );

    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'dm-channel-1',
        threadId: 'dm-channel-1',
      }),
    );
  });

  it('skips when the suggester is already enabled', async () => {
    getSettingsMock.mockResolvedValue({ suggesterFrequency: 'daily' });

    await discordSuggestedTasksOnboardingFollowupJob(buildJob(JOB_DATA));

    expect(resolveCredentialsMock).not.toHaveBeenCalled();
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('skips when Discord is not configured', async () => {
    resolveCredentialsMock.mockResolvedValue({
      botToken: null,
      applicationId: null,
    });

    await discordSuggestedTasksOnboardingFollowupJob(buildJob(JOB_DATA));

    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('skips invalid payloads', async () => {
    await discordSuggestedTasksOnboardingFollowupJob(
      buildJob({ guildId: 123 }),
    );

    expect(getSettingsMock).not.toHaveBeenCalled();
    expect(postMessageMock).not.toHaveBeenCalled();
  });
});
