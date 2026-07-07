import { Hono } from 'hono';
import type { AuthTokenContext, JobTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';

const {
  fetchChannelMessagesMock,
  resolveChannelIdMock,
  isAppInChannelMock,
  isUserInChannelMock,
  isPublicChannelMock,
} = vi.hoisted(() => ({
  fetchChannelMessagesMock: vi.fn(),
  resolveChannelIdMock: vi.fn(),
  isAppInChannelMock: vi.fn(),
  isUserInChannelMock: vi.fn(),
  isPublicChannelMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      cloudJobs: { findFirst: vi.fn() },
      slackInstallations: { findFirst: vi.fn() },
      slackUserMappings: { findFirst: vi.fn() },
    },
  },
  cloudJobs: { id: 'id' },
  slackInstallations: { orgId: 'orgId', isActive: 'isActive' },
  slackUserMappings: {
    userId: 'userId',
    slackTeamId: 'slackTeamId',
  },
  and: vi.fn(),
  eq: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: vi.fn(
    class {
      fetchChannelMessages = fetchChannelMessagesMock;
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
  currentEpochSeconds: vi.fn(),
  findSlackConversationSubjectByUserId: vi.fn(),
  recordSlackConversationMessageBestEffort: vi.fn(),
}));

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: {
      ROOMOTE_APP_URL: 'https://app.example.com',
      ARTIFACT_SIGNING_KEY: '12345678901234567890123456789012',
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
  requestedOldest?: string;
  requestedLatest?: string;
  messageCount?: number;
  messages?: Array<Record<string, unknown>>;
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

async function postChannelMessages(
  authContext: Variables['authContext'] | undefined,
  body: Record<string, unknown>,
) {
  return createApp(authContext).request('/mcp/channel_messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mockSlackCloudJob(
  overrides: Partial<{
    id: number;
    orgId: string;
    userId: string | null;
    actingUserId: string | null;
    type: string;
    slackThreadTs: string | null;
    payload: Record<string, unknown>;
  }> = {},
) {
  return {
    id: 42,
    userId: 'user-1',
    actingUserId: 'user-1',
    type: 'slack.app.mention',
    slackThreadTs: '111.000',
    payload: {
      channel: 'C123',
      thread_ts: '111.000',
      user: 'U123',
    },
    ...overrides,
  };
}

describe('slack channel messages MCP endpoint', () => {
  const jobToken: JobTokenContext = {
    cloudJobId: 42,
    userId: 'user-1',
    tokenType: 'cj',
    version: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.query.cloudJobs.findFirst).mockResolvedValue(
      mockSlackCloudJob() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
      teamId: 'T123',
    } as never);
    vi.mocked(db.query.slackUserMappings.findFirst).mockResolvedValue({
      slackUserId: 'UACTOR',
    } as never);
    resolveChannelIdMock.mockResolvedValue('CENG');
    isAppInChannelMock.mockResolvedValue(true);
    isUserInChannelMock.mockResolvedValue(true);
    isPublicChannelMock.mockResolvedValue(true);
  });

  it('rejects non-job tokens', async () => {
    const authToken: AuthTokenContext = {
      userId: 'user-1',
      tokenType: 'auth',
      version: 1,
    };

    const response = await postChannelMessages(authToken, {
      channel: 'eng',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(403);
    expect(body.error).toBe(
      'Slack channel message lookup MCP is only available for cloud job tokens',
    );
  });

  it('returns channel history for explicit channels and forwards time bounds', async () => {
    vi.mocked(db.query.cloudJobs.findFirst).mockResolvedValue(
      mockSlackCloudJob({
        type: 'standard',
        slackThreadTs: null,
        payload: {},
      }) as never,
    );
    fetchChannelMessagesMock.mockResolvedValue([
      {
        ts: '1711929600.000000',
        user: 'U123',
        username: 'Alice',
        text: 'root',
        type: 'message',
      },
      {
        ts: '1711929900.000000',
        user: 'U234',
        username: 'Bob',
        thread_ts: '1711929600.000000',
        text: 'reply',
        type: 'message',
      },
    ]);

    const response = await postChannelMessages(jobToken, {
      channel: 'eng',
      oldest: '2026-04-01T00:00:00Z',
      latest: '2026-04-02T00:00:00Z',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      channelId: 'CENG',
      requestedOldest: '2026-04-01T00:00:00Z',
      requestedLatest: '2026-04-02T00:00:00Z',
      messageCount: 2,
      messages: [
        {
          ts: '1711929600.000000',
          user: 'U123',
          username: 'Alice',
          text: 'root',
          fileCount: 0,
        },
        {
          ts: '1711929900.000000',
          user: 'U234',
          username: 'Bob',
          threadTs: '1711929600.000000',
          text: 'reply',
          fileCount: 0,
        },
      ],
    });
    expect(resolveChannelIdMock).toHaveBeenCalledWith('#eng');
    expect(isAppInChannelMock).toHaveBeenCalledWith('CENG');
    expect(isPublicChannelMock).toHaveBeenCalledWith('CENG');
    expect(isUserInChannelMock).toHaveBeenCalledWith({
      channelId: 'CENG',
      userId: 'UACTOR',
    });
    expect(fetchChannelMessagesMock).toHaveBeenCalledWith({
      channel: 'CENG',
      oldest: '1775001600.000000',
      latest: '1775088000.000000',
    });
  });

  it('uses the originating Slack channel when channel is omitted', async () => {
    fetchChannelMessagesMock.mockResolvedValue([
      {
        ts: '1711929600.000000',
        user: 'U123',
        username: 'Alice',
        text: 'root',
        type: 'message',
      },
    ]);

    const response = await postChannelMessages(jobToken, {
      oldest: '1711929600.000000',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body.channelId).toBe('C123');
    expect(fetchChannelMessagesMock).toHaveBeenCalledWith({
      channel: 'C123',
      oldest: '1711929600.000000',
    });
    expect(resolveChannelIdMock).not.toHaveBeenCalled();
    expect(isPublicChannelMock).toHaveBeenCalledWith('C123');
  });

  it('rejects reversed time bounds', async () => {
    const response = await postChannelMessages(jobToken, {
      oldest: '2026-04-02T00:00:00Z',
      latest: '2026-04-01T00:00:00Z',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(400);
    expect(body.error).toBe('oldest must be less than or equal to latest');
    expect(fetchChannelMessagesMock).not.toHaveBeenCalled();
  });

  it('rejects explicit channel lookup when the acting Slack user is not in the channel', async () => {
    vi.mocked(db.query.cloudJobs.findFirst).mockResolvedValue(
      mockSlackCloudJob({
        type: 'standard',
        slackThreadTs: null,
        payload: {},
      }) as never,
    );
    isUserInChannelMock.mockResolvedValue(false);

    const response = await postChannelMessages(jobToken, {
      channel: 'eng',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(403);
    expect(body.error).toBe(
      'Linked Slack user is not a member of channel #eng.',
    );
    expect(fetchChannelMessagesMock).not.toHaveBeenCalled();
  });

  it('rejects explicit channel lookup when the acting user has no linked Slack account before checking visibility', async () => {
    vi.mocked(db.query.cloudJobs.findFirst).mockResolvedValue(
      mockSlackCloudJob({
        type: 'standard',
        slackThreadTs: null,
        payload: {},
      }) as never,
    );
    vi.mocked(db.query.slackUserMappings.findFirst).mockResolvedValue(
      null as never,
    );
    isPublicChannelMock.mockResolvedValue(false);

    const response = await postChannelMessages(jobToken, {
      channel: 'eng',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(403);
    expect(body.error).toBe(
      'Explicit Slack access requires the acting user to have a linked Slack account.',
    );
    expect(isPublicChannelMock).not.toHaveBeenCalled();
    expect(fetchChannelMessagesMock).not.toHaveBeenCalled();
  });

  it('rejects explicit channel lookup for private channels', async () => {
    vi.mocked(db.query.cloudJobs.findFirst).mockResolvedValue(
      mockSlackCloudJob({
        type: 'standard',
        slackThreadTs: null,
        payload: {},
      }) as never,
    );
    isPublicChannelMock.mockResolvedValue(false);

    const response = await postChannelMessages(jobToken, {
      channel: 'eng',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(403);
    expect(body.error).toBe(
      'Slack channel message lookup is limited to public channels the app has joined.',
    );
    expect(isUserInChannelMock).toHaveBeenCalledWith({
      channelId: 'CENG',
      userId: 'UACTOR',
    });
    expect(fetchChannelMessagesMock).not.toHaveBeenCalled();
  });

  it('rejects private originating Slack channels when channel is omitted', async () => {
    isPublicChannelMock.mockResolvedValue(false);

    const response = await postChannelMessages(jobToken, {
      oldest: '1711929600.000000',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(403);
    expect(body.error).toBe(
      'Slack channel message lookup is limited to public channels the app has joined.',
    );
    expect(fetchChannelMessagesMock).not.toHaveBeenCalled();
  });

  it('returns a 502 when Slack channel history fetch fails', async () => {
    vi.mocked(db.query.cloudJobs.findFirst).mockResolvedValue(
      mockSlackCloudJob({
        type: 'standard',
        slackThreadTs: null,
        payload: {},
      }) as never,
    );
    fetchChannelMessagesMock.mockRejectedValue(new Error('rate_limited'));

    const response = await postChannelMessages(jobToken, {
      channel: 'eng',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(502);
    expect(body.error).toBe(
      'Slack channel CENG could not be fetched from Slack',
    );
  });
});
