import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { envMock, getSettingsMock, postMessageMock, providerFactoryMock } =
  vi.hoisted(() => ({
    envMock: {
      ROOMOTE_APP_URL: 'https://app.example.com',
    },
    getSettingsMock: vi.fn(),
    postMessageMock: vi.fn(),
    providerFactoryMock: vi.fn(),
  }));

vi.mock('@roomote/env', () => ({ Env: envMock }));

vi.mock('@roomote/db/server', () => ({
  getBackgroundAgentSettingsForDeployment: getSettingsMock,
}));

vi.mock('@roomote/sdk/server', async () => {
  const { z } = await import('zod');

  return {
    createTeamsCommunicationProviderFromRuntimeCredentials: providerFactoryMock,
    teamsSuggestedTasksOnboardingFollowupRequestSchema: z.object({
      conversationId: z.string(),
      serviceUrl: z.string(),
      introMessageId: z.string(),
      sourceTaskId: z.string(),
    }),
  };
});

import { teamsSuggestedTasksOnboardingFollowupJob } from './teams-suggested-tasks-onboarding-followup';

function buildJob(data: unknown): Job {
  return { id: 'job-1', data } as Job;
}

const JOB_DATA = {
  conversationId: '19:channel@thread.tacv2',
  serviceUrl: 'https://smba.trafficmanager.net/amer/',
  introMessageId: '900',
  sourceTaskId: 'task-1',
};

describe('teamsSuggestedTasksOnboardingFollowupJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettingsMock.mockResolvedValue({ suggesterFrequency: 'off' });
    postMessageMock.mockResolvedValue({ messageId: '901' });
    providerFactoryMock.mockResolvedValue({ postMessage: postMessageMock });
  });

  it('posts the follow-up as a thread reply with an Automations link', async () => {
    await teamsSuggestedTasksOnboardingFollowupJob(buildJob(JOB_DATA));

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    const posted = postMessageMock.mock.calls[0]![0] as {
      channelId: string;
      serviceUrl: string;
      replyToMessageId: string;
      text: string;
    };

    expect(posted.channelId).toBe('19:channel@thread.tacv2');
    expect(posted.replyToMessageId).toBe('900');
    expect(posted.text).toContain(
      'https://app.example.com/automations?utm_source=teams',
    );
  });

  it('skips when the suggester is already enabled', async () => {
    getSettingsMock.mockResolvedValue({ suggesterFrequency: 'weekly' });

    await teamsSuggestedTasksOnboardingFollowupJob(buildJob(JOB_DATA));

    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('skips when the bot is not configured', async () => {
    providerFactoryMock.mockResolvedValue(null);

    await teamsSuggestedTasksOnboardingFollowupJob(buildJob(JOB_DATA));

    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('skips invalid payloads', async () => {
    await teamsSuggestedTasksOnboardingFollowupJob(buildJob({ nope: true }));

    expect(getSettingsMock).not.toHaveBeenCalled();
    expect(postMessageMock).not.toHaveBeenCalled();
  });
});
