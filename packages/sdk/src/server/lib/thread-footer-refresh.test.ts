const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  managed: vi.fn(),
  slackRefresh: vi.fn(),
  sourceRefresh: vi.fn(),
  discordEdit: vi.fn(),
  textEdit: vi.fn(),
  installation: vi.fn(),
  redisGet: vi.fn(),
  forget: vi.fn(),
}));
vi.mock('@roomote/communication', () => ({
  claimThreadFooterRefreshTargets: mocks.claim,
  refreshManagedThreadReplyFooter: mocks.managed,
  editTextThreadFooterMessage: mocks.textEdit,
  forgetThreadFooterRefresh: mocks.forget,
}));
vi.mock('@roomote/db/server', () => ({
  db: { query: { slackInstallations: { findFirst: mocks.installation } } },
  and: vi.fn(),
  eq: vi.fn(),
  slackInstallations: {},
}));
vi.mock('@roomote/redis', () => ({
  getRedis: () => ({ get: mocks.redisGet }),
}));
vi.mock('@roomote/slack', () => ({
  SlackNotifier: class {
    constructor(readonly token: string) {}
  },
  refreshSlackThreadReplyFooter: mocks.slackRefresh,
  withSlackThreadReplyFooterLock: async ({ fn }: { fn: () => Promise<void> }) =>
    fn(),
}));
vi.mock('./discord-communication', () => ({
  createDiscordCommunicationProviderFromRuntimeCredentials: async () => ({
    editMessage: mocks.discordEdit,
  }),
}));
vi.mock('./teams-communication', () => ({
  createTeamsCommunicationProviderFromRuntimeCredentials: async () => ({
    provider: 'teams',
  }),
}));
vi.mock('./telegram-communication', () => ({
  createTelegramCommunicationProviderFromRuntimeCredentials: async () => ({
    provider: 'telegram',
  }),
}));
vi.mock('./source-control-fast-delivery', () => ({
  refreshSourceControlThreadFooter: mocks.sourceRefresh,
}));

import {
  refreshCurrentThreadFooters,
  refreshThreadFooterTarget,
} from './thread-footer-refresh';

describe('footer refresh control-plane dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claim.mockResolvedValue([]);
    mocks.redisGet.mockResolvedValue('team');
    mocks.installation.mockResolvedValue({ botAccessToken: 'test-token' });
  });

  it('does no provider work when there are no recorded due carriers', async () => {
    await refreshCurrentThreadFooters();
    expect(mocks.managed).not.toHaveBeenCalled();
    expect(mocks.slackRefresh).not.toHaveBeenCalled();
    expect(mocks.sourceRefresh).not.toHaveBeenCalled();
  });

  it('routes source control and Slack only to recorded destinations and the recorded workspace credential', async () => {
    await refreshThreadFooterTarget({
      provider: 'source-control',
      channelId: 'discussion',
      threadId: 'review',
    });
    expect(mocks.sourceRefresh).toHaveBeenCalledWith({
      provider: 'source-control',
      channelId: 'discussion',
      threadId: 'review',
    });
    await refreshThreadFooterTarget({
      provider: 'slack',
      channelId: 'C',
      threadId: 'T',
    });
    expect(mocks.redisGet).toHaveBeenCalledWith(
      'slack:thread_footer_workspace:C:T',
    );
    expect(mocks.slackRefresh).toHaveBeenCalledWith({
      slack: expect.objectContaining({ token: 'test-token' }),
      channel: 'C',
      threadTs: 'T',
    });
  });

  it('preserves Discord controls and uses the carrier destination rather than the parent channel', async () => {
    mocks.managed.mockImplementation(async ({ edit }) =>
      edit(
        {
          messageId: 'current',
          textWithoutFooter: 'Body',
          refresh: { channelId: 'thread-channel', footerText: 'old' },
        },
        'Body\n\nnew footer',
      ),
    );
    await refreshThreadFooterTarget({
      provider: 'discord',
      channelId: 'parent-channel',
      threadId: 'thread-channel',
    });
    expect(mocks.discordEdit).toHaveBeenCalledWith({
      channelId: 'thread-channel',
      messageId: 'current',
      text: 'Body\n\nnew footer',
      preserveButtons: true,
    });
  });

  it('bounds concurrent work to five destinations and isolates a failed target', async () => {
    mocks.claim.mockResolvedValue(
      Array.from({ length: 13 }, (_, index) => ({
        provider: 'discord',
        channelId: `C${index}`,
        threadId: 'T',
      })),
    );
    let active = 0;
    let maximum = 0;
    mocks.managed.mockImplementation(async ({ channelId }) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      if (channelId === 'C2') throw new Error('temporary failure');
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await refreshCurrentThreadFooters();
    expect(mocks.managed).toHaveBeenCalledTimes(13);
    expect(maximum).toBe(5);
    expect(warning).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });
});
