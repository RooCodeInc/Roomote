import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { envMock, getSettingsMock, postMessageMock } = vi.hoisted(() => ({
  envMock: {
    R_APP_URL: 'https://app.example.com',
    TELEGRAM_BOT_TOKEN: 'bot-token' as string | undefined,
  },
  getSettingsMock: vi.fn(),
  postMessageMock: vi.fn(),
}));

vi.mock('@roomote/env', () => ({ Env: envMock }));

vi.mock('@roomote/db/server', () => ({
  getBackgroundAgentSettingsForDeployment: getSettingsMock,
  resolveTelegramRuntimeCredentials: vi.fn(async () => ({
    botToken: envMock.TELEGRAM_BOT_TOKEN ?? null,
    webhookSecret: null,
    botUsername: null,
  })),
}));

vi.mock('@roomote/sdk/server', async () => {
  const { z } = await import('zod');

  return {
    telegramSuggestedTasksOnboardingFollowupRequestSchema: z.object({
      chatId: z.string(),
      introMessageId: z.string(),
      sourceTaskId: z.string(),
    }),
  };
});

vi.mock('@roomote/communication/telegram-provider', () => ({
  TelegramCommunicationProvider: vi.fn().mockImplementation(function () {
    return { postMessage: postMessageMock };
  }),
}));

import { telegramSuggestedTasksOnboardingFollowupJob } from './telegram-suggested-tasks-onboarding-followup';

function buildJob(data: unknown): Job {
  return { id: 'job-1', data } as Job;
}

describe('telegramSuggestedTasksOnboardingFollowupJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.TELEGRAM_BOT_TOKEN = 'bot-token';
    getSettingsMock.mockResolvedValue({ suggesterFrequency: 'off' });
    postMessageMock.mockResolvedValue({ messageId: '901' });
  });

  it('posts the follow-up with an Automations link when the suggester is off', async () => {
    await telegramSuggestedTasksOnboardingFollowupJob(
      buildJob({
        chatId: '8846357662',
        introMessageId: '900',
        sourceTaskId: 'task-1',
      }),
    );

    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '8846357662',
        replyToMessageId: '900',
        textFormat: 'markdown',
        buttons: [
          [
            expect.objectContaining({
              text: 'Open Automations',
              url: expect.stringContaining('#suggest-ideas'),
            }),
          ],
        ],
      }),
    );
  });

  it('skips delivery when the suggester is already enabled', async () => {
    getSettingsMock.mockResolvedValue({ suggesterFrequency: 'daily' });

    await telegramSuggestedTasksOnboardingFollowupJob(
      buildJob({
        chatId: '8846357662',
        introMessageId: '900',
        sourceTaskId: 'task-1',
      }),
    );

    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('skips delivery when the bot token is not configured', async () => {
    envMock.TELEGRAM_BOT_TOKEN = undefined;

    await telegramSuggestedTasksOnboardingFollowupJob(
      buildJob({
        chatId: '8846357662',
        introMessageId: '900',
        sourceTaskId: 'task-1',
      }),
    );

    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it('skips invalid payloads', async () => {
    await telegramSuggestedTasksOnboardingFollowupJob(
      buildJob({ chatId: 123 }),
    );

    expect(postMessageMock).not.toHaveBeenCalled();
    expect(getSettingsMock).not.toHaveBeenCalled();
  });
});
