const mocks = vi.hoisted(() => ({
  syncTitle: vi.fn(),
  notifier: vi.fn(function () {}),
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: mocks.notifier,
  syncSlackAgentSessionTitleBestEffort: mocks.syncTitle,
}));

import {
  db,
  fastAgentConversations,
  slackInstallations,
  userFactory,
} from '@roomote/db/server';

import { syncFastAgentSlackTitleBestEffort } from './fast-agent-slack-title-sync';

describe('syncFastAgentSlackTitleBestEffort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.syncTitle.mockResolvedValue(undefined);
  });

  it('resolves a Slack Fast conversation and synchronizes its title', async () => {
    const user = await userFactory.create();
    const workspaceId = `T-title-${Date.now()}`;
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'slack',
        workspaceId,
        conversationId: '100.001',
        currentReplyChannelId: 'C123',
        currentReplyThreadId: '100.001',
        title: 'Generated Fast title',
      })
      .returning();
    await db.insert(slackInstallations).values({
      teamId: workspaceId,
      teamName: 'Title workspace',
      appId: 'A123',
      botUserId: 'B123',
      botAccessToken: 'xoxb-title-test',
      scopes: { bot: ['chat:write'] },
      installedByUserId: user.id,
      isActive: true,
    });

    await syncFastAgentSlackTitleBestEffort({
      conversationId: conversation!.id,
    });

    expect(mocks.notifier).toHaveBeenCalledWith('xoxb-title-test');
    expect(mocks.syncTitle).toHaveBeenCalledWith({
      slack: expect.anything(),
      workspaceId,
      channel: 'C123',
      threadTs: '100.001',
      title: 'Generated Fast title',
      resolveTitle: expect.any(Function),
    });
    await expect(
      mocks.syncTitle.mock.calls[0]![0].resolveTitle(),
    ).resolves.toBe('Generated Fast title');
  });

  it('ignores untitled and non-Slack conversations', async () => {
    const user = await userFactory.create();
    const rows = await db
      .insert(fastAgentConversations)
      .values([
        {
          userId: user.id,
          surface: 'slack',
          workspaceId: 'T123',
          conversationId: `untitled-${Date.now()}`,
          currentReplyChannelId: 'C123',
          currentReplyThreadId: '100.001',
        },
        {
          userId: user.id,
          surface: 'web',
          workspaceId: user.id,
          conversationId: `web-${Date.now()}`,
          title: 'Web title',
        },
      ])
      .returning();

    await Promise.all(
      rows.map((row) =>
        syncFastAgentSlackTitleBestEffort({ conversationId: row.id }),
      ),
    );

    expect(mocks.syncTitle).not.toHaveBeenCalled();
  });

  it('contains title synchronization failures', async () => {
    mocks.syncTitle.mockRejectedValueOnce(new Error('Slack unavailable'));
    const user = await userFactory.create();
    const workspaceId = `T-failure-${Date.now()}`;
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'slack',
        workspaceId,
        conversationId: '100.002',
        currentReplyChannelId: 'C456',
        title: 'Generated Fast title',
      })
      .returning();
    await db.insert(slackInstallations).values({
      teamId: workspaceId,
      teamName: 'Failure workspace',
      appId: 'A456',
      botUserId: 'B456',
      botAccessToken: 'xoxb-failure-test',
      scopes: { bot: ['chat:write'] },
      installedByUserId: user.id,
      isActive: true,
    });

    await expect(
      syncFastAgentSlackTitleBestEffort({
        conversationId: conversation!.id,
      }),
    ).resolves.toBeUndefined();
  });
});
