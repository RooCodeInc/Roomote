const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  managed: vi.fn(),
  slackRefresh: vi.fn(),
  sourceRefresh: vi.fn(),
  discordEdit: vi.fn(),
  textEdit: vi.fn(),
  installation: vi.fn(),
  taskRun: vi.fn(),
  task: vi.fn(),
  redisGet: vi.fn(),
  forget: vi.fn(),
  reschedule: vi.fn(),
  jobLock: vi.fn(),
  jobRelease: vi.fn(),
}));
vi.mock('@roomote/communication', () => ({
  claimThreadFooterRefreshTargets: mocks.claim,
  refreshManagedThreadReplyFooter: mocks.managed,
  editTextThreadFooterMessage: mocks.textEdit,
  forgetThreadFooterRefresh: mocks.forget,
  rescheduleThreadFooterRefresh: mocks.reschedule,
}));
vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      slackInstallations: { findFirst: mocks.installation },
      taskRuns: { findFirst: mocks.taskRun },
      tasks: { findFirst: mocks.task },
    },
  },
  and: vi.fn(),
  eq: vi.fn(),
  slackInstallations: {},
  taskRuns: {},
  tasks: {},
}));
vi.mock('@roomote/redis', () => ({
  getRedis: () => ({ get: mocks.redisGet }),
  acquireRedisLock: mocks.jobLock,
}));
vi.mock('@roomote/slack', () => ({
  SlackNotifier: class {
    constructor(readonly token: string) {}
  },
  refreshSlackThreadReplyFooter: mocks.slackRefresh,
  withSlackThreadReplyFooterLock: async ({
    fn,
  }: {
    fn: (assertLock: () => Promise<void>) => Promise<void>;
  }) => fn(async () => {}),
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
  refreshTaskRunThreadFooter,
  refreshThreadFooterTarget,
} from './thread-footer-refresh';

describe('footer refresh control-plane dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claim.mockResolvedValue([]);
    mocks.redisGet.mockResolvedValue('team');
    mocks.installation.mockResolvedValue({ botAccessToken: 'test-token' });
    mocks.taskRun.mockResolvedValue({
      taskId: 'task-1',
      payload: {
        communicationProvider: 'slack',
        communicationChannelId: 'C',
        communicationThreadId: 'T',
      },
    });
    mocks.managed.mockResolvedValue('active');
    mocks.slackRefresh.mockResolvedValue('active');
    mocks.sourceRefresh.mockResolvedValue('active');
    mocks.jobLock.mockResolvedValue(mocks.jobRelease);
  });

  it('runs one pass at a time and releases the pass lock when done', async () => {
    mocks.jobLock.mockResolvedValueOnce(null);
    await refreshCurrentThreadFooters();
    expect(mocks.claim).not.toHaveBeenCalled();
    mocks.claim.mockRejectedValueOnce(new Error('redis down'));
    await expect(refreshCurrentThreadFooters()).rejects.toThrow('redis down');
    expect(mocks.jobRelease).toHaveBeenCalledTimes(1);
  });

  it('reschedules each destination by what the refresh learned and drops unregistered ones', async () => {
    const targets = ['active', 'idle', 'gone'].map((outcome) => ({
      provider: 'discord' as const,
      channelId: outcome,
      threadId: 'T',
    }));
    mocks.claim.mockResolvedValue(targets);
    mocks.managed.mockImplementation(async ({ channelId }) => channelId);
    await refreshCurrentThreadFooters();
    expect(mocks.reschedule).toHaveBeenCalledTimes(2);
    expect(mocks.reschedule).toHaveBeenCalledWith(targets[0], 'active');
    expect(mocks.reschedule).toHaveBeenCalledWith(targets[1], 'idle');
  });

  it('retires a Slack footer whose workspace has no active installation', async () => {
    mocks.installation.mockResolvedValue(null);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      await refreshThreadFooterTarget({
        provider: 'slack',
        channelId: 'C',
        threadId: 'T',
      }),
    ).toBe('gone');
    expect(mocks.forget).toHaveBeenCalledWith({
      provider: 'slack',
      channelId: 'C',
      threadId: 'T',
    });
    expect(mocks.slackRefresh).not.toHaveBeenCalled();
    warning.mockRestore();
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

  it('refreshes and re-registers a settled Slack footer when its task starts again', async () => {
    await refreshTaskRunThreadFooter(42);

    expect(mocks.taskRun).toHaveBeenCalled();
    expect(mocks.task).not.toHaveBeenCalled();
    expect(mocks.slackRefresh).toHaveBeenCalledWith({
      slack: expect.objectContaining({ token: 'test-token' }),
      channel: 'C',
      threadTs: 'T',
    });
    expect(mocks.reschedule).toHaveBeenCalledWith(
      { provider: 'slack', channelId: 'C', threadId: 'T' },
      'active',
    );
    expect(mocks.claim).not.toHaveBeenCalled();
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
