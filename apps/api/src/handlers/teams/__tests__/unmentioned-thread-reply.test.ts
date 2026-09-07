import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamsActivity } from '@roomote/communication/teams-activity';
import { getTeamsActivityCommunicationMetadata } from '@roomote/communication/teams-activity';
import type {
  TeamsGraphMessage,
  TeamsGraphMessageMention,
} from '@roomote/communication/teams-graph-client';

const {
  findLatestTeamsThreadTaskRunMock,
  findTaskBackedTeamsAutomationReportRunMock,
} = vi.hoisted(() => ({
  findLatestTeamsThreadTaskRunMock: vi.fn(),
  findTaskBackedTeamsAutomationReportRunMock: vi.fn(),
}));

vi.mock('../find-active-teams-run.js', () => ({
  findLatestTeamsThreadTaskRun: findLatestTeamsThreadTaskRunMock,
  findTaskBackedTeamsAutomationReportRun:
    findTaskBackedTeamsAutomationReportRunMock,
}));

import { shouldRouteUnmentionedTeamsThreadReplyToAgent } from '../unmentioned-thread-reply';

const BOT_APP_ID = 'bot-app-id';
const THREAD_ROOT_ID = '1700000000000';
const EVENT_ID = '1700000000500';

const fetchThreadMessagesMock = vi.fn();

function humanGraphMessage(params: {
  id: string;
  userId: string;
  name?: string;
  text?: string;
  mentions?: TeamsGraphMessageMention[];
}): TeamsGraphMessage {
  return {
    id: params.id,
    author: params.name ?? 'Teams user',
    authorUserId: params.userId,
    text: params.text ?? 'hello',
    attachmentCount: 0,
    hostedContentIds: [],
    mentions: params.mentions ?? [],
  };
}

function botGraphMessage(id: string, text = 'bot reply'): TeamsGraphMessage {
  return {
    id,
    author: 'Roomote',
    authorApplicationId: BOT_APP_ID,
    text,
    attachmentCount: 0,
    hostedContentIds: [],
    mentions: [],
  };
}

function botMention(): TeamsGraphMessageMention {
  return { applicationId: BOT_APP_ID, name: 'Roomote' };
}

function threadReplyActivity(
  overrides: Record<string, unknown> = {},
): TeamsActivity {
  return {
    type: 'message',
    id: EVENT_ID,
    text: 'sounds good, keep going',
    from: {
      id: '29:user-1',
      name: 'Ada Lovelace',
      aadObjectId: 'aad-user-1',
    },
    channelId: 'msteams',
    conversation: {
      id: `19:conversation@thread.tacv2;messageid=${THREAD_ROOT_ID}`,
      tenantId: 'tenant-1',
      conversationType: 'channel',
    },
    recipient: {
      id: `28:${BOT_APP_ID}`,
      name: 'Roomote',
    },
    channelData: {
      tenant: { id: 'tenant-1' },
      team: { id: '19:team' },
      channel: { id: '19:conversation@thread.tacv2' },
    },
    serviceUrl: 'https://smba.trafficmanager.net/amer/',
    ...overrides,
  } as TeamsActivity;
}

async function routeDecision(
  activity: TeamsActivity,
  options: { mappedUserId?: string | null; botAppId?: string | null } = {},
) {
  return shouldRouteUnmentionedTeamsThreadReplyToAgent({
    activity,
    metadata: getTeamsActivityCommunicationMetadata(activity),
    mappedUserId:
      options.mappedUserId === undefined ? 'user-1' : options.mappedUserId,
    botAppId: options.botAppId === undefined ? BOT_APP_ID : options.botAppId,
    fetchThreadMessages: fetchThreadMessagesMock,
  });
}

describe('shouldRouteUnmentionedTeamsThreadReplyToAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findLatestTeamsThreadTaskRunMock.mockResolvedValue({
      id: 7,
      userId: 'user-1',
    });
    findTaskBackedTeamsAutomationReportRunMock.mockResolvedValue(undefined);
    fetchThreadMessagesMock.mockResolvedValue(null);
  });

  it('routes an unmentioned reply directly after the bot last spoke', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanGraphMessage({
        id: THREAD_ROOT_ID,
        userId: 'aad-user-1',
        text: '@Roomote please fix the bug',
        mentions: [botMention()],
      }),
      botGraphMessage('1700000000100'),
    ]);

    await expect(routeDecision(threadReplyActivity())).resolves.toBe(true);
  });

  it('recognizes an announcer report root when no regular task run owns the thread', async () => {
    findLatestTeamsThreadTaskRunMock.mockResolvedValue(undefined);
    findTaskBackedTeamsAutomationReportRunMock.mockResolvedValue({
      id: 8,
      userId: null,
    });
    fetchThreadMessagesMock.mockResolvedValue([
      humanGraphMessage({
        id: THREAD_ROOT_ID,
        userId: 'aad-user-1',
        mentions: [botMention()],
      }),
      botGraphMessage('1700000000100'),
    ]);

    await expect(routeDecision(threadReplyActivity())).resolves.toBe(true);
    expect(findTaskBackedTeamsAutomationReportRunMock).toHaveBeenCalledWith({
      conversationId: `19:conversation@thread.tacv2;messageid=${THREAD_ROOT_ID}`,
      threadId: THREAD_ROOT_ID,
    });
  });

  it('keeps routing consecutive replies from the same sender before the bot answers', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanGraphMessage({
        id: THREAD_ROOT_ID,
        userId: 'aad-user-1',
        mentions: [botMention()],
      }),
      botGraphMessage('1700000000100'),
      humanGraphMessage({
        id: '1700000000200',
        userId: 'aad-user-1',
        text: 'also add tests',
      }),
    ]);

    await expect(routeDecision(threadReplyActivity())).resolves.toBe(true);
  });

  it('keeps routing after the sender mentions themself', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanGraphMessage({
        id: THREAD_ROOT_ID,
        userId: 'aad-user-1',
        mentions: [botMention()],
      }),
      botGraphMessage('1700000000100'),
      humanGraphMessage({
        id: '1700000000200',
        userId: 'aad-user-1',
        text: '@Ada note to self',
        mentions: [{ userId: 'aad-user-1', name: 'Ada' }],
      }),
    ]);

    await expect(routeDecision(threadReplyActivity())).resolves.toBe(true);
  });

  it('requires a mention when somebody else posted since the bot last spoke', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanGraphMessage({
        id: THREAD_ROOT_ID,
        userId: 'aad-user-1',
        mentions: [botMention()],
      }),
      botGraphMessage('1700000000100'),
      humanGraphMessage({
        id: '1700000000200',
        userId: 'aad-user-2',
        text: 'interesting thread',
      }),
    ]);

    await expect(routeDecision(threadReplyActivity())).resolves.toBe(false);
  });

  it('requires a mention when somebody else was mentioned since the bot last spoke', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanGraphMessage({
        id: THREAD_ROOT_ID,
        userId: 'aad-user-1',
        mentions: [botMention()],
      }),
      botGraphMessage('1700000000100'),
      humanGraphMessage({
        id: '1700000000200',
        userId: 'aad-user-1',
        text: 'cc @Grace for visibility',
        mentions: [{ userId: 'aad-user-3', name: 'Grace' }],
      }),
    ]);

    await expect(routeDecision(threadReplyActivity())).resolves.toBe(false);
  });

  it('reopens the no-mention window when the bot posts a new reply after an interjection', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanGraphMessage({
        id: THREAD_ROOT_ID,
        userId: 'aad-user-1',
        mentions: [botMention()],
      }),
      botGraphMessage('1700000000100'),
      humanGraphMessage({
        id: '1700000000200',
        userId: 'aad-user-2',
        text: 'interesting thread',
      }),
      humanGraphMessage({
        id: '1700000000300',
        userId: 'aad-user-1',
        text: '@Roomote continue',
        mentions: [botMention()],
      }),
      botGraphMessage('1700000000400'),
    ]);

    await expect(routeDecision(threadReplyActivity())).resolves.toBe(true);
  });

  it('ignores a first-time sender replying after the bot until they mention the bot', async () => {
    findLatestTeamsThreadTaskRunMock.mockResolvedValue({
      id: 7,
      userId: 'user-1',
    });
    fetchThreadMessagesMock.mockResolvedValue([
      humanGraphMessage({
        id: THREAD_ROOT_ID,
        userId: 'aad-user-1',
        mentions: [botMention()],
      }),
      botGraphMessage('1700000000100'),
    ]);

    await expect(
      routeDecision(
        threadReplyActivity({
          from: { id: '29:user-2', name: 'Grace', aadObjectId: 'aad-user-2' },
        }),
        { mappedUserId: 'user-2' },
      ),
    ).resolves.toBe(false);
  });

  it('lets a sender who joined via an earlier bot mention reply without a mention', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanGraphMessage({
        id: THREAD_ROOT_ID,
        userId: 'aad-user-1',
        mentions: [botMention()],
      }),
      botGraphMessage('1700000000100'),
      humanGraphMessage({
        id: '1700000000200',
        userId: 'aad-user-2',
        text: '@Roomote also update the docs',
        mentions: [botMention()],
      }),
      botGraphMessage('1700000000300'),
    ]);

    await expect(
      routeDecision(
        threadReplyActivity({
          from: { id: '29:user-2', name: 'Grace', aadObjectId: 'aad-user-2' },
        }),
        { mappedUserId: 'user-2' },
      ),
    ).resolves.toBe(true);
  });

  it('lets the thread root author reply without a mention even without a prior bot mention', async () => {
    findLatestTeamsThreadTaskRunMock.mockResolvedValue({ id: 7, userId: null });
    fetchThreadMessagesMock.mockResolvedValue([
      humanGraphMessage({
        id: THREAD_ROOT_ID,
        userId: 'aad-user-1',
        text: 'please fix the login bug',
      }),
      botGraphMessage('1700000000100'),
    ]);

    await expect(routeDecision(threadReplyActivity())).resolves.toBe(true);
  });

  it('lets the thread task owner reply without a mention in a bot-started thread', async () => {
    findLatestTeamsThreadTaskRunMock.mockResolvedValue({
      id: 7,
      userId: 'user-4',
    });
    fetchThreadMessagesMock.mockResolvedValue([
      botGraphMessage(THREAD_ROOT_ID, 'Getting started on your task'),
      botGraphMessage('1700000000100'),
    ]);

    await expect(
      routeDecision(
        threadReplyActivity({
          from: { id: '29:user-4', name: 'Mary', aadObjectId: 'aad-user-4' },
        }),
        { mappedUserId: 'user-4' },
      ),
    ).resolves.toBe(true);
  });

  it('treats the whole thread as the window when no bot message is found in history', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanGraphMessage({
        id: THREAD_ROOT_ID,
        userId: 'aad-user-1',
        mentions: [botMention()],
      }),
      humanGraphMessage({
        id: '1700000000100',
        userId: 'aad-user-2',
        text: 'interesting thread',
      }),
    ]);

    await expect(routeDecision(threadReplyActivity())).resolves.toBe(false);
  });

  it('routes a single-sender thread without any bot message in history', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanGraphMessage({
        id: THREAD_ROOT_ID,
        userId: 'aad-user-1',
        mentions: [botMention()],
      }),
    ]);

    await expect(routeDecision(threadReplyActivity())).resolves.toBe(true);
  });

  it('ignores messages that mention the bot (handled by the mention path)', async () => {
    await expect(
      routeDecision(
        threadReplyActivity({
          text: '<at>Roomote</at> please continue',
          entities: [
            {
              type: 'mention',
              text: '<at>Roomote</at>',
              mentioned: { id: `28:${BOT_APP_ID}`, name: 'Roomote' },
            },
          ],
        }),
      ),
    ).resolves.toBe(false);
    expect(fetchThreadMessagesMock).not.toHaveBeenCalled();
  });

  it('ignores replies that mention another user', async () => {
    await expect(
      routeDecision(
        threadReplyActivity({
          text: '<at>Grace</at> what do you think?',
          entities: [
            {
              type: 'mention',
              text: '<at>Grace</at>',
              mentioned: { id: '29:user-3', name: 'Grace' },
            },
          ],
        }),
      ),
    ).resolves.toBe(false);
    expect(fetchThreadMessagesMock).not.toHaveBeenCalled();
  });

  it('ignores top-level channel messages that start their own thread', async () => {
    await expect(
      routeDecision(
        threadReplyActivity({
          conversation: {
            id: '19:conversation@thread.tacv2',
            tenantId: 'tenant-1',
            conversationType: 'channel',
          },
        }),
      ),
    ).resolves.toBe(false);
    expect(findLatestTeamsThreadTaskRunMock).not.toHaveBeenCalled();
  });

  it('ignores personal conversations (they already route without a mention)', async () => {
    await expect(
      routeDecision(
        threadReplyActivity({
          conversation: {
            id: 'a:personal',
            tenantId: 'tenant-1',
            conversationType: 'personal',
          },
        }),
      ),
    ).resolves.toBe(false);
    expect(findLatestTeamsThreadTaskRunMock).not.toHaveBeenCalled();
  });

  it('requires a mention from unlinked senders', async () => {
    await expect(
      routeDecision(threadReplyActivity(), { mappedUserId: null }),
    ).resolves.toBe(false);
    expect(findLatestTeamsThreadTaskRunMock).not.toHaveBeenCalled();
  });

  it('requires a mention when thread history is unavailable', async () => {
    fetchThreadMessagesMock.mockResolvedValue(null);

    await expect(routeDecision(threadReplyActivity())).resolves.toBe(false);
  });

  it('ignores replies in threads Roomote does not own', async () => {
    findLatestTeamsThreadTaskRunMock.mockResolvedValue(undefined);

    await expect(routeDecision(threadReplyActivity())).resolves.toBe(false);
    expect(fetchThreadMessagesMock).not.toHaveBeenCalled();
  });
});
