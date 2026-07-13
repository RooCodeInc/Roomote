import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  credentialsMock,
  findPrimaryChatMock,
  postMessageMock,
  selectLimitMock,
} = vi.hoisted(() => ({
  credentialsMock: vi.fn(),
  findPrimaryChatMock: vi.fn(),
  postMessageMock: vi.fn(),
  selectLimitMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  slackInstallations: { id: 'id', isActive: 'isActive' },
  eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
  resolveTelegramRuntimeCredentials: credentialsMock,
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: selectLimitMock })),
      })),
    })),
  },
}));

vi.mock('../../../telegram/primary-chat.js', () => ({
  findTelegramPrimaryChatId: findPrimaryChatMock,
}));

vi.mock('../../../telegram/replies.js', () => ({
  postTelegramMessageInNewTopicBestEffort: postMessageMock,
}));

vi.mock('../../../slack/helpers/suggestion-workspace.js', () => ({
  buildSuggestionBadgePrefix: vi.fn(() => ''),
}));

import {
  postLateBoundWorkItemFailureToTelegram,
  resolveAutomationTelegramTarget,
} from '../telegram';

describe('resolveAutomationTelegramTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectLimitMock.mockResolvedValue([]);
    credentialsMock.mockResolvedValue({
      botToken: 'bot-token',
      webhookSecret: null,
      botUsername: null,
    });
    findPrimaryChatMock.mockResolvedValue('8846357662');
  });

  it('resolves the primary chat when no Slack installation exists', async () => {
    await expect(resolveAutomationTelegramTarget()).resolves.toEqual({
      provider: 'telegram',
      chatId: '8846357662',
    });
  });

  it('returns null when an active Slack installation exists, matching the summary gate', async () => {
    selectLimitMock.mockResolvedValueOnce([{ id: 'install-1' }]);

    await expect(resolveAutomationTelegramTarget()).resolves.toBeNull();
    expect(credentialsMock).not.toHaveBeenCalled();
  });

  it('returns null without a bot token or primary chat', async () => {
    credentialsMock.mockResolvedValueOnce({
      botToken: null,
      webhookSecret: null,
      botUsername: null,
    });
    await expect(resolveAutomationTelegramTarget()).resolves.toBeNull();

    findPrimaryChatMock.mockResolvedValueOnce(null);
    await expect(resolveAutomationTelegramTarget()).resolves.toBeNull();
  });

  it('posts automation launch failures in their own topic', async () => {
    await postLateBoundWorkItemFailureToTelegram({
      chatId: '8846357662',
      workItem: {
        id: 'work-1',
        title: 'Fix the flaky test',
        brief: 'Investigate and fix it.',
        category: null,
        priority: null,
      } as never,
      reason: 'No environment was available.',
    });

    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '8846357662',
        topicName: 'Fix the flaky test',
      }),
    );
  });
});
