import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findPrimaryConversationMock, postMessageMock, selectLimitMock } =
  vi.hoisted(() => ({
    findPrimaryConversationMock: vi.fn(),
    postMessageMock: vi.fn(),
    selectLimitMock: vi.fn(),
  }));

vi.mock('@roomote/db/server', () => ({
  slackInstallations: { id: 'id', isActive: 'isActive' },
  eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: selectLimitMock })),
      })),
    })),
  },
}));

vi.mock('../../../teams/automation-messaging.js', () => ({
  findTeamsPrimaryConversation: findPrimaryConversationMock,
  postTeamsAutomationMessageBestEffort: postMessageMock,
}));

vi.mock('../../../slack/helpers/suggestion-workspace.js', () => ({
  buildSuggestionBadgePrefix: vi.fn(() => ''),
}));

import { resolveAutomationTeamsTarget } from '../teams';

describe('resolveAutomationTeamsTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectLimitMock.mockResolvedValue([]);
    findPrimaryConversationMock.mockResolvedValue({
      conversationId: '19:channel@thread.tacv2',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
    });
  });

  it('resolves the primary conversation when no Slack installation exists', async () => {
    await expect(resolveAutomationTeamsTarget()).resolves.toEqual({
      provider: 'teams',
      conversationId: '19:channel@thread.tacv2',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
    });
  });

  it('returns null when an active Slack installation exists, matching the summary gate', async () => {
    selectLimitMock.mockResolvedValueOnce([{ id: 'install-1' }]);

    await expect(resolveAutomationTeamsTarget()).resolves.toBeNull();
    expect(findPrimaryConversationMock).not.toHaveBeenCalled();
  });

  it('returns null without a primary conversation', async () => {
    findPrimaryConversationMock.mockResolvedValueOnce(null);

    await expect(resolveAutomationTeamsTarget()).resolves.toBeNull();
  });
});
