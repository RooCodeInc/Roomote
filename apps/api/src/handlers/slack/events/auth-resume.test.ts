import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authTokenFindFirst: vi.fn(),
  installationFindFirst: vi.fn(),
  lookupSlackUserMapping: vi.fn(),
  deleteReturning: vi.fn(),
  startFastAgentResponse: vi.fn(),
  abort: vi.fn(),
  SlackNotifier: vi.fn(function SlackNotifier() {}),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...conditions) => conditions),
  eq: vi.fn((column, value) => ({ column, value })),
  gt: vi.fn((column, value) => ({ column, value })),
  slackAuthTokens: {
    token: 'slack_auth_tokens.token',
    expiresAt: 'slack_auth_tokens.expires_at',
  },
  slackInstallations: { teamId: 'slack_installations.team_id' },
  db: {
    query: {
      slackAuthTokens: { findFirst: mocks.authTokenFindFirst },
      slackInstallations: { findFirst: mocks.installationFindFirst },
    },
    delete: vi.fn(() => ({
      where: vi.fn(() => ({ returning: mocks.deleteReturning })),
    })),
  },
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: mocks.SlackNotifier,
  resolveSlackReactionNames: vi.fn().mockResolvedValue({ ackEmoji: 'eyes' }),
  shouldResumeSlackAuthThread: vi.fn(
    (originalText: string) => originalText !== '__roomote:no-resume__',
  ),
}));

vi.mock('../helpers/user-mapping.js', () => ({
  lookupSlackUserMapping: mocks.lookupSlackUserMapping,
}));

vi.mock('./message-entry.js', () => ({
  startFastAgentResponse: mocks.startFastAgentResponse,
}));

describe('resumePendingSlackAuthRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.abort.mockResolvedValue(undefined);
    mocks.authTokenFindFirst.mockResolvedValue({
      token: 'state-1',
      slackUserId: 'U123',
      slackTeamId: 'T123',
      channel: 'C123',
      threadTs: '111.000',
      messageTs: '111.001',
      originalText: '<@UBOT> investigate this',
    });
    mocks.lookupSlackUserMapping.mockResolvedValue({
      activeMapping: { userId: 'user-1' },
      hasInactiveMapping: false,
    });
    mocks.installationFindFirst.mockResolvedValue({
      teamId: 'T123',
      botAccessToken: 'xoxb-test',
      botUserId: 'UBOT',
      botName: 'Roomote',
      appName: 'Roomote',
    });
    mocks.deleteReturning.mockResolvedValue([
      {
        token: 'state-1',
        slackUserId: 'U123',
        slackTeamId: 'T123',
        channel: 'C123',
        threadTs: '111.000',
        messageTs: '111.001',
        originalText: '<@UBOT> investigate this',
      },
    ]);
    mocks.startFastAgentResponse.mockResolvedValue({
      accepted: true,
      abort: mocks.abort,
    });
  });

  it('starts Fast with the original Slack message identity after linking', async () => {
    const { resumePendingSlackAuthRequest } = await import('./auth-resume.js');

    await expect(resumePendingSlackAuthRequest('state-1')).resolves.toEqual({
      success: true,
      status: 'resumed',
    });

    expect(mocks.startFastAgentResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        event: {
          type: 'app_mention',
          channel: 'C123',
          user: 'U123',
          text: '<@UBOT> investigate this',
          ts: '111.001',
          thread_ts: '111.000',
        },
        continuation: true,
        directedAtRoomote: true,
        userId: 'user-1',
      }),
    );
    expect(mocks.deleteReturning).toHaveBeenCalledTimes(1);
  });

  it('does not consume or replay the request before account linking completes', async () => {
    mocks.lookupSlackUserMapping.mockResolvedValue({
      activeMapping: null,
      hasInactiveMapping: false,
    });
    const { resumePendingSlackAuthRequest } = await import('./auth-resume.js');

    await expect(resumePendingSlackAuthRequest('state-1')).resolves.toEqual({
      success: false,
      error: 'account_link_required',
    });

    expect(mocks.deleteReturning).not.toHaveBeenCalled();
    expect(mocks.startFastAgentResponse).not.toHaveBeenCalled();
  });

  it('aborts a duplicate Fast admission when another resume claims the request', async () => {
    mocks.deleteReturning.mockResolvedValue([]);
    const { resumePendingSlackAuthRequest } = await import('./auth-resume.js');

    await expect(resumePendingSlackAuthRequest('state-1')).resolves.toEqual({
      success: false,
      error: 'invalid_or_expired_auth_token',
    });

    expect(mocks.abort).toHaveBeenCalledTimes(1);
  });

  it('keeps the pending request when Fast does not accept it', async () => {
    mocks.startFastAgentResponse.mockResolvedValue({
      accepted: false,
      reason: 'busy',
    });
    const { resumePendingSlackAuthRequest } = await import('./auth-resume.js');

    await expect(resumePendingSlackAuthRequest('state-1')).resolves.toEqual({
      success: false,
      error: 'fast_session_not_accepted',
    });

    expect(mocks.deleteReturning).not.toHaveBeenCalled();
  });
});
