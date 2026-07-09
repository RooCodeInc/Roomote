import { Hono } from 'hono';
import type { AuthTokenContext, JobTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';

const {
  getMessageMock,
  fetchThreadMessagesMock,
  resolveChannelIdMock,
  isAppInChannelMock,
  isUserInChannelMock,
  isPublicChannelMock,
} = vi.hoisted(() => ({
  getMessageMock: vi.fn(),
  fetchThreadMessagesMock: vi.fn(),
  resolveChannelIdMock: vi.fn(),
  isAppInChannelMock: vi.fn(),
  isUserInChannelMock: vi.fn(),
  isPublicChannelMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: { findFirst: vi.fn() },
      tasks: { findFirst: vi.fn() },
      slackInstallations: { findFirst: vi.fn() },
      slackUserMappings: { findFirst: vi.fn() },
      taskArtifacts: { findMany: vi.fn() },
      taskPullRequests: { findFirst: vi.fn() },
    },
  },
  taskRuns: { id: 'id' },
  tasks: { id: 'id' },
  slackInstallations: { orgId: 'orgId', isActive: 'isActive' },
  slackUserMappings: {
    userId: 'userId',
    slackTeamId: 'slackTeamId',
  },
  taskArtifacts: { id: 'id' },
  taskPullRequests: { taskId: 'taskId' },
  and: vi.fn(),
  eq: vi.fn(),
  desc: vi.fn(),
  isVisibleTask: vi.fn(() => ({})),
  inArray: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: vi.fn(
    class {
      getMessage = getMessageMock;
      fetchThreadMessages = fetchThreadMessagesMock;
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
  requestedMessageTs?: string;
  threadTs?: string;
  matchedMessageIndex?: number;
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

async function postThreadLookup(
  authContext: Variables['authContext'] | undefined,
  body: Record<string, unknown>,
) {
  return createApp(authContext).request('/mcp/thread_lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mockSlackCloudJob(
  overrides: Partial<{
    id: number;
    orgId: string;
    actingUserId: string | null;
    type: string;
    slackThreadTs: string | null;
    payload: Record<string, unknown>;
  }> = {},
) {
  return {
    id: 42,
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

describe('slack thread lookup MCP endpoint', () => {
  const jobToken: JobTokenContext = {
    cloudJobId: 42,
    userId: 'user-1',
    principal: 'user',
    tokenType: 'cj',
    version: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
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

    const response = await postThreadLookup(authToken, {
      messageTs: '111.222',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(403);
    expect(body.error).toBe(
      'Slack thread lookup MCP is only available for cloud job tokens',
    );
  });

  it('returns the full thread containing the requested message', async () => {
    getMessageMock.mockResolvedValue({
      text: 'reply',
      ts: '111.222',
      thread_ts: '111.000',
      user: 'U234',
      files: [],
    });
    fetchThreadMessagesMock.mockResolvedValue([
      {
        ts: '111.000',
        user: 'U123',
        username: 'Alice',
        text: 'root',
        type: 'message',
      },
      {
        ts: '111.222',
        user: 'U234',
        username: 'Bob',
        text: 'reply',
        type: 'message',
        files: [
          {
            id: 'F1',
            name: 'screenshot.png',
            mimetype: 'image/png',
            filetype: 'png',
            size: 1024,
          },
        ],
      },
    ]);

    const response = await postThreadLookup(jobToken, {
      messageTs: '111.222',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      channelId: 'C123',
      requestedMessageTs: '111.222',
      threadTs: '111.000',
      matchedMessageIndex: 1,
      messageCount: 2,
      messages: [
        {
          ts: '111.000',
          user: 'U123',
          username: 'Alice',
          text: 'root',
          fileCount: 0,
        },
        {
          ts: '111.222',
          user: 'U234',
          username: 'Bob',
          text: 'reply',
          fileCount: 1,
          files: [
            {
              id: 'F1',
              name: 'screenshot.png',
              mimetype: 'image/png',
              filetype: 'png',
              size: 1024,
            },
          ],
        },
      ],
    });
    expect(getMessageMock).toHaveBeenCalledWith({
      channel: 'C123',
      messageTs: '111.222',
    });
    expect(fetchThreadMessagesMock).toHaveBeenCalledWith({
      channel: 'C123',
      threadTs: '111.000',
    });
    expect(resolveChannelIdMock).not.toHaveBeenCalled();
    expect(isAppInChannelMock).not.toHaveBeenCalled();
    expect(isUserInChannelMock).not.toHaveBeenCalled();
    expect(isPublicChannelMock).not.toHaveBeenCalled();
  });

  it('uses Slack-linked suggested task metadata as the implicit thread target', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockSlackCloudJob({
        type: 'suggested.tasks',
        slackThreadTs: '111.000',
        payload: {
          channel: 'C123',
        },
      }) as never,
    );
    getMessageMock.mockResolvedValue({
      text: 'reply',
      ts: '111.222',
      thread_ts: '111.000',
      user: 'U234',
      files: [],
    });
    fetchThreadMessagesMock.mockResolvedValue([
      {
        ts: '111.000',
        user: 'U123',
        username: 'Alice',
        text: 'root',
        type: 'message',
      },
      {
        ts: '111.222',
        user: 'U234',
        username: 'Bob',
        text: 'reply',
        type: 'message',
      },
    ]);

    const response = await postThreadLookup(jobToken, {
      messageTs: '111.222',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body.channelId).toBe('C123');
    expect(body.threadTs).toBe('111.000');
    expect(getMessageMock).toHaveBeenCalledWith({
      channel: 'C123',
      messageTs: '111.222',
    });
    expect(resolveChannelIdMock).not.toHaveBeenCalled();
  });

  it('looks up an explicit channel for non-Slack jobs', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockSlackCloudJob({
        type: 'standard',
        slackThreadTs: null,
        payload: {},
      }) as never,
    );
    getMessageMock.mockResolvedValue({
      text: 'reply',
      ts: '111.222',
      thread_ts: '111.000',
      user: 'U234',
      files: [],
    });
    fetchThreadMessagesMock.mockResolvedValue([
      {
        ts: '111.000',
        user: 'U123',
        username: 'Alice',
        text: 'root',
        type: 'message',
      },
      {
        ts: '111.222',
        user: 'U234',
        username: 'Bob',
        text: 'reply',
        type: 'message',
      },
    ]);

    const response = await postThreadLookup(jobToken, {
      channel: 'eng',
      messageTs: '111.222',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body.channelId).toBe('CENG');
    expect(resolveChannelIdMock).toHaveBeenCalledWith('#eng');
    expect(isAppInChannelMock).toHaveBeenCalledWith('CENG');
    expect(isUserInChannelMock).toHaveBeenCalledWith({
      channelId: 'CENG',
      userId: 'UACTOR',
    });
    expect(isPublicChannelMock).not.toHaveBeenCalled();
    expect(getMessageMock).toHaveBeenCalledWith({
      channel: 'CENG',
      messageTs: '111.222',
    });
    expect(fetchThreadMessagesMock).toHaveBeenCalledWith({
      channel: 'CENG',
      threadTs: '111.000',
    });
  });

  it('requires a channel when the job has no Slack thread context', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockSlackCloudJob({
        type: 'standard',
        slackThreadTs: null,
        payload: {},
      }) as never,
    );

    const response = await postThreadLookup(jobToken, {
      messageTs: '111.222',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      'channel is required when Slack thread lookup is not running from a Slack-originated job',
    );
  });

  it('rejects explicit channel lookup when the acting user has no linked Slack account', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockSlackCloudJob({
        type: 'standard',
        slackThreadTs: null,
        payload: {},
      }) as never,
    );
    vi.mocked(db.query.slackUserMappings.findFirst).mockResolvedValue(
      null as never,
    );

    const response = await postThreadLookup(jobToken, {
      channel: 'eng',
      messageTs: '111.222',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(403);
    expect(body.error).toBe(
      'Explicit Slack thread lookup requires the acting user to have a linked Slack account.',
    );
    expect(getMessageMock).not.toHaveBeenCalled();
    expect(isUserInChannelMock).not.toHaveBeenCalled();
  });

  it('rejects explicit channel lookup when the acting Slack user is not in the channel', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockSlackCloudJob({
        type: 'standard',
        slackThreadTs: null,
        payload: {},
      }) as never,
    );
    isUserInChannelMock.mockResolvedValue(false);

    const response = await postThreadLookup(jobToken, {
      channel: 'eng',
      messageTs: '111.222',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(403);
    expect(body.error).toBe(
      'Linked Slack user is not a member of channel #eng.',
    );
    expect(getMessageMock).not.toHaveBeenCalled();
  });

  it('allows bot-context explicit channel lookup only in public channels', async () => {
    // A run with no acting user is a deployment-principal run; its job token
    // carries a null user.
    const deploymentToken: JobTokenContext = {
      cloudJobId: 42,
      userId: null,
      principal: 'deployment',
      tokenType: 'cj',
      version: 1,
    };
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockSlackCloudJob({
        actingUserId: null,
        payload: {
          channel: 'C123',
          thread_ts: '111.000',
          user: 'UBOT',
        },
      }) as never,
    );
    getMessageMock.mockResolvedValue({
      text: 'reply',
      ts: '111.222',
      thread_ts: '111.000',
      user: 'U234',
      files: [],
    });
    fetchThreadMessagesMock.mockResolvedValue([
      {
        ts: '111.000',
        user: 'U123',
        username: 'Alice',
        text: 'root',
        type: 'message',
      },
      {
        ts: '111.222',
        user: 'U234',
        username: 'Bob',
        text: 'reply',
        type: 'message',
      },
    ]);

    const response = await postThreadLookup(deploymentToken, {
      channel: 'eng',
      messageTs: '111.222',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body.channelId).toBe('CENG');
    expect(isPublicChannelMock).toHaveBeenCalledWith('CENG');
    expect(isUserInChannelMock).not.toHaveBeenCalled();
  });

  it('rejects bot-context explicit channel lookup for private channels', async () => {
    const deploymentToken: JobTokenContext = {
      cloudJobId: 42,
      userId: null,
      principal: 'deployment',
      tokenType: 'cj',
      version: 1,
    };
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockSlackCloudJob({
        actingUserId: null,
        payload: {
          channel: 'C123',
          thread_ts: '111.000',
          user: 'UBOT',
        },
      }) as never,
    );
    isPublicChannelMock.mockResolvedValue(false);

    const response = await postThreadLookup(deploymentToken, {
      channel: 'eng',
      messageTs: '111.222',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(403);
    expect(body.error).toBe(
      'Explicit Slack thread lookup without a linked acting Slack user is limited to public channels the app has joined.',
    );
    expect(getMessageMock).not.toHaveBeenCalled();
  });

  it('rejects direct-message channel targets', async () => {
    const response = await postThreadLookup(jobToken, {
      channel: 'D123ABC456',
      messageTs: '111.222',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      'direct message IDs are not supported; use a Slack channel ID or channel name instead',
    );
  });

  it('returns 502 when Slack cannot fetch the thread payload', async () => {
    getMessageMock.mockResolvedValue({
      text: 'standalone message',
      ts: '222.333',
      user: 'U123',
      files: [],
    });
    fetchThreadMessagesMock.mockResolvedValue([]);

    const response = await postThreadLookup(jobToken, {
      messageTs: '222.333',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(502);
    expect(body.error).toBe(
      'Slack thread for message 222.333 could not be fetched from the originating channel',
    );
  });

  it('returns 404 when the message cannot be found', async () => {
    getMessageMock.mockResolvedValue(null);

    const response = await postThreadLookup(jobToken, {
      messageTs: '999.999',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(404);
    expect(body.error).toBe(
      'Slack message 999.999 was not found in the originating channel',
    );
  });

  it('rejects missing message timestamps', async () => {
    const response = await postThreadLookup(jobToken, {});
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(400);
    expect(body.error).toBe('messageTs is required');
  });
});
