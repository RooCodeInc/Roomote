import { Hono } from 'hono';
import type { AuthTokenContext, RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';

const {
  addReactionMock,
  resolveChannelIdMock,
  isAppInChannelMock,
  isUserInChannelMock,
  isPublicChannelMock,
  telegramAddReactionMock,
  teamsAddReactionMock,
  createTeamsCommunicationProviderMock,
} = vi.hoisted(() => ({
  addReactionMock: vi.fn(),
  resolveChannelIdMock: vi.fn(),
  isAppInChannelMock: vi.fn(),
  isUserInChannelMock: vi.fn(),
  isPublicChannelMock: vi.fn(),
  telegramAddReactionMock: vi.fn(),
  teamsAddReactionMock: vi.fn(),
  createTeamsCommunicationProviderMock: vi.fn(async () => ({
    addReaction: teamsAddReactionMock,
  })),
}));

vi.mock('@roomote/communication', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@roomote/communication')>();

  return {
    ...actual,
    TelegramCommunicationProvider: vi.fn().mockImplementation(function () {
      return { addReaction: telegramAddReactionMock };
    }),
  };
});

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: { findFirst: vi.fn() },
      tasks: { findFirst: vi.fn() },
      slackInstallations: { findFirst: vi.fn() },
      slackUserMappings: { findFirst: vi.fn() },
    },
  },
  taskRuns: { id: 'id' },
  tasks: { id: 'id' },
  slackInstallations: { orgId: 'orgId', isActive: 'isActive' },
  slackUserMappings: {
    userId: 'userId',
    slackTeamId: 'slackTeamId',
  },
  eq: vi.fn(),
  desc: vi.fn(),
  isVisibleTask: vi.fn(() => ({})),
  and: vi.fn(),
  inArray: vi.fn(),
  resolveTelegramRuntimeCredentials: vi.fn(async () => ({
    botToken: 'telegram-token',
    webhookSecret: null,
    botUsername: null,
  })),
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: vi.fn(
    class {
      addReaction = addReactionMock;
      resolveChannelId = resolveChannelIdMock;
      isAppInChannel = isAppInChannelMock;
      isUserInChannel = isUserInChannelMock;
      isPublicChannel = isPublicChannelMock;
    },
  ),
  clearLatestUserMessage: vi.fn(),
  getLatestUserMessage: vi.fn(),
  getSlackThreadReplyFooterMessageTs: vi.fn(),
  setSlackThreadReplyFooterMessageTs: vi.fn(),
  setLatestSlackBotReply: vi.fn(),
  clearSlackThreadReplyFooterMessageTs: vi.fn(),
  trackSlackBotReply: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  buildSignedArtifactRawUrl: vi.fn(),
  createTeamsCommunicationProviderFromRuntimeCredentials:
    createTeamsCommunicationProviderMock,
  currentEpochSeconds: vi.fn(),
  findSlackConversationSubjectByUserId: vi.fn(),
  recordSlackConversationMessageBestEffort: vi.fn(),
}));

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: {
      R_APP_URL: 'https://app.example.com',
      ARTIFACT_SIGNING_KEY: '12345678901234567890123456789012',
      TELEGRAM_BOT_TOKEN: 'telegram-token',
    },
  };
});

vi.mock('@roomote/redis', () => ({
  getRedis: vi.fn(() => ({
    set: vi.fn(),
    eval: vi.fn(),
  })),
}));

import { db } from '@roomote/db/server';
import { mcpAuthMiddleware } from '../middleware';
import { slackMcp } from '../slack';

type JsonBody = {
  error?: string;
  channelId?: string;
  messageTs?: string;
  name?: string;
};

function createApp(authContext?: Variables['authContext']) {
  const app = new Hono<{
    Variables: Variables;
  }>();

  app.use('*', async (c, next) => {
    if (authContext) {
      c.set('authContext', authContext);
    }
    await next();
  });

  app.use('/mcp/*', mcpAuthMiddleware);
  app.use('/mcp', mcpAuthMiddleware);
  app.route('/mcp', slackMcp);

  return app;
}

async function addReaction(
  authContext: Variables['authContext'] | undefined,
  body: Record<string, unknown>,
) {
  return createApp(authContext).request('/mcp/reaction_add', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mockTaskRun(
  overrides: Partial<{
    id: number;
    orgId: string;
    actingUserId: string | null;
  }> = {},
) {
  return {
    id: 42,
    actingUserId: 'user-1',
    ...overrides,
  };
}

describe('slack reaction add MCP endpoint', () => {
  const runToken: RunTokenContext = {
    runId: 42,
    userId: 'user-1',
    principal: 'user',
    tokenType: 'run',
    version: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resolveChannelIdMock.mockResolvedValue('C123');
    isAppInChannelMock.mockResolvedValue(true);
    isUserInChannelMock.mockResolvedValue(true);
    isPublicChannelMock.mockResolvedValue(true);
    addReactionMock.mockResolvedValue(true);
    vi.mocked(db.query.slackUserMappings.findFirst).mockResolvedValue({
      slackUserId: 'UACTOR',
    } as never);
  });

  it('rejects non-run tokens', async () => {
    const authToken: AuthTokenContext = {
      userId: 'user-1',
      tokenType: 'auth',
      version: 1,
    };

    const response = await addReaction(authToken, {
      channel: '#eng',
      messageTs: '111.222',
      name: 'eyes',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(403);
    expect(body.error).toBe(
      'Slack reaction add MCP is only available for task run tokens',
    );
  });

  it('rejects invalid reaction names', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun() as never,
    );

    const response = await addReaction(runToken, {
      channel: '#eng',
      messageTs: '111.222',
      name: 'white check mark',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      'name must be a Slack emoji name without surrounding colons, for example eyes or white_check_mark',
    );
  });

  it('adds a reaction to a resolved channel', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
      teamId: 'T123',
    } as never);
    resolveChannelIdMock.mockResolvedValueOnce('C123ABC456');

    const response = await addReaction(runToken, {
      channel: '<#c123abc456|eng>',
      messageTs: '111.222',
      name: ':white_check_mark:',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      channelId: 'C123ABC456',
      messageTs: '111.222',
      name: 'white_check_mark',
    });
    expect(resolveChannelIdMock).toHaveBeenCalledWith('C123ABC456');
    expect(isAppInChannelMock).toHaveBeenCalledWith('C123ABC456');
    expect(isUserInChannelMock).toHaveBeenCalledWith({
      channelId: 'C123ABC456',
      userId: 'UACTOR',
    });
    expect(addReactionMock).toHaveBeenCalledWith({
      channel: 'C123ABC456',
      timestamp: '111.222',
      name: 'white_check_mark',
    });
  });

  it('rejects channels the Slack app is not a member of', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
      teamId: 'T123',
    } as never);
    isAppInChannelMock.mockResolvedValue(false);

    const response = await addReaction(runToken, {
      channel: '#eng',
      messageTs: '111.222',
      name: 'eyes',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(403);
    expect(body.error).toBe('Slack app is not a member of channel #eng.');
  });

  it('rejects explicit reaction adds when the acting user has no linked Slack account', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
      teamId: 'T123',
    } as never);
    vi.mocked(db.query.slackUserMappings.findFirst).mockResolvedValue(
      null as never,
    );

    const response = await addReaction(runToken, {
      channel: '#eng',
      messageTs: '111.222',
      name: 'eyes',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(403);
    expect(body.error).toBe(
      'Explicit Slack access requires the acting user to have a linked Slack account.',
    );
    expect(addReactionMock).not.toHaveBeenCalled();
  });

  it('rejects explicit reaction adds when the acting Slack user is not in the channel', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
      teamId: 'T123',
    } as never);
    isUserInChannelMock.mockResolvedValue(false);

    const response = await addReaction(runToken, {
      channel: '#eng',
      messageTs: '111.222',
      name: 'eyes',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(403);
    expect(body.error).toBe(
      'Linked Slack user is not a member of channel #eng.',
    );
    expect(addReactionMock).not.toHaveBeenCalled();
  });

  it('rejects bot-context explicit reaction adds for private channels', async () => {
    // A run with no acting user is a deployment-principal run; its run token
    // carries a null user.
    const deploymentToken: RunTokenContext = {
      runId: 42,
      userId: null,
      principal: 'deployment',
      tokenType: 'run',
      version: 1,
    };
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun({ actingUserId: null }) as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
      teamId: 'T123',
    } as never);
    isPublicChannelMock.mockResolvedValue(false);

    const response = await addReaction(deploymentToken, {
      channel: '#eng',
      messageTs: '111.222',
      name: 'eyes',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(403);
    expect(body.error).toBe(
      'Explicit Slack access without a linked acting Slack user is limited to public channels the app has joined.',
    );
    expect(addReactionMock).not.toHaveBeenCalled();
  });

  it('returns 502 when Slack rejects the reaction add', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
      teamId: 'T123',
    } as never);
    addReactionMock.mockResolvedValue(false);

    const response = await addReaction(runToken, {
      channel: 'C123',
      messageTs: '111.222',
      name: 'eyes',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(502);
    expect(body.error).toBe(
      'Slack reactions.add failed for channel C123 at 111.222.',
    );
  });

  it('dispatches Telegram-context reactions through the Telegram provider', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue({
      ...mockTaskRun(),
      payload: {
        communicationProvider: 'telegram',
        communicationChannelId: '8846357662',
      },
    } as never);
    telegramAddReactionMock.mockResolvedValue({
      provider: 'telegram',
      channelId: '8846357662',
      messageId: '77',
      name: 'eyes',
    });

    const response = await addReaction(runToken, {
      channel: '8846357662',
      messageTs: '77',
      name: 'eyes',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      channelId: '8846357662',
      messageTs: '77',
      name: 'eyes',
    });
    expect(telegramAddReactionMock).toHaveBeenCalledWith({
      channelId: '8846357662',
      messageId: '77',
      name: 'eyes',
    });
    expect(addReactionMock).not.toHaveBeenCalled();
  });

  it('rejects Telegram reactions targeting a different chat', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue({
      ...mockTaskRun(),
      payload: {
        communicationProvider: 'telegram',
        communicationChannelId: '8846357662',
      },
    } as never);

    const response = await addReaction(runToken, {
      channel: '999999',
      messageTs: '77',
      name: 'eyes',
    });

    expect(response.status).toBe(403);
    expect(telegramAddReactionMock).not.toHaveBeenCalled();
  });

  it('dispatches Teams-context reactions as emoji-only Teams messages', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue({
      ...mockTaskRun(),
      payload: {
        communicationProvider: 'teams',
        communicationChannelId: '19:conversation@thread.v2',
        communicationServiceUrl: 'https://smba.trafficmanager.net/amer/',
        communicationThreadId: 'activity-root',
      },
    } as never);
    teamsAddReactionMock.mockResolvedValue({
      provider: 'teams',
      channelId: '19:conversation@thread.v2',
      messageId: 'activity-followup',
      name: 'eyes',
    });

    const response = await addReaction(runToken, {
      channel: '19:conversation@thread.v2',
      messageTs: 'activity-followup',
      name: 'eyes',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      channelId: '19:conversation@thread.v2',
      messageTs: 'activity-followup',
      name: 'eyes',
    });
    expect(createTeamsCommunicationProviderMock).toHaveBeenCalled();
    expect(teamsAddReactionMock).toHaveBeenCalledWith({
      channelId: '19:conversation@thread.v2',
      messageId: 'activity-followup',
      name: 'eyes',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      threadId: 'activity-root',
    });
    expect(addReactionMock).not.toHaveBeenCalled();
  });

  it('rejects Teams reactions targeting a different conversation', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue({
      ...mockTaskRun(),
      payload: {
        communicationProvider: 'teams',
        communicationChannelId: '19:conversation@thread.v2',
      },
    } as never);

    const response = await addReaction(runToken, {
      channel: '19:other@thread.v2',
      messageTs: 'activity-followup',
      name: 'eyes',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(403);
    expect(body.error).toBe(
      'Teams reactions are only available for the conversation this task was launched from',
    );
    expect(teamsAddReactionMock).not.toHaveBeenCalled();
  });
});
