import { Hono } from 'hono';
import type { AuthTokenContext, RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';

const {
  postMessageMock,
  resolveChannelIdMock,
  isAppInChannelMock,
  getCommunicationProviderAdapterMock,
  slackAdapterPostMessageMock,
  buildSignedArtifactRawUrlMock,
  currentEpochSecondsMock,
} = vi.hoisted(() => ({
  postMessageMock: vi.fn(),
  resolveChannelIdMock: vi.fn(),
  isAppInChannelMock: vi.fn(),
  getCommunicationProviderAdapterMock: vi.fn(),
  slackAdapterPostMessageMock: vi.fn(),
  buildSignedArtifactRawUrlMock: vi.fn(),
  currentEpochSecondsMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: { findFirst: vi.fn() },
      tasks: { findFirst: vi.fn() },
      slackInstallations: { findFirst: vi.fn() },
      taskArtifacts: { findMany: vi.fn() },
    },
  },
  taskRuns: { id: 'id' },
  tasks: { id: 'id' },
  slackInstallations: { orgId: 'orgId', isActive: 'isActive' },
  taskArtifacts: { id: 'id' },
  eq: vi.fn(),
  desc: vi.fn(),
  isVisibleTask: vi.fn(() => ({})),
  and: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  SlackNotifier: vi.fn(
    class {
      postMessage = postMessageMock;
      resolveChannelId = resolveChannelIdMock;
      isAppInChannel = isAppInChannelMock;
    },
  ),
  getSlackThreadReplyFooterMessageTs: vi.fn(),
  setSlackThreadReplyFooterMessageTs: vi.fn(),
  clearSlackThreadReplyFooterMessageTs: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  buildSignedArtifactRawUrl: buildSignedArtifactRawUrlMock,
  currentEpochSeconds: currentEpochSecondsMock,
  getCommunicationProviderAdapter: getCommunicationProviderAdapterMock,
  findTeamsConversationServiceUrl: vi.fn(),
}));

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: {
      R_APP_URL: 'https://app.example.com',
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

type JsonBody = { error?: string; messageTs?: string; channelId?: string };
const expectedNoUnfurl = {
  unfurl_links: false,
  unfurl_media: false,
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

async function postChannelMessage(
  authContext: Variables['authContext'] | undefined,
  body: Record<string, unknown>,
) {
  return createApp(authContext).request('/mcp/channel_post', {
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
    taskId: string;
  }> = {},
) {
  return {
    id: 42,
    actingUserId: 'user-1',
    taskId: 'task-1',
    ...overrides,
  };
}

describe('slack channel post MCP endpoint', () => {
  const runToken: RunTokenContext = {
    runId: 42,
    userId: 'user-1',
    principal: 'user',
    tokenType: 'run',
    version: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    currentEpochSecondsMock.mockReturnValue(1_700_000_000);
    buildSignedArtifactRawUrlMock.mockImplementation(
      ({ artifactId }: { artifactId: string }) =>
        `https://app.example.com/api/artifacts/${artifactId}/raw?sig=test&ts=1700000000`,
    );
    postMessageMock.mockResolvedValue('999.888');
    resolveChannelIdMock.mockResolvedValue('C123');
    isAppInChannelMock.mockResolvedValue(true);
    slackAdapterPostMessageMock.mockImplementation(
      async (input: {
        channelId: string;
        threadId?: string;
        text?: string;
        blocks?: unknown[];
        images?: Array<{ url: string; altText: string }>;
      }) => {
        const blocks = [
          ...(input.blocks ?? []),
          ...(input.images ?? []).map((image) => ({
            type: 'image',
            image_url: image.url,
            alt_text: image.altText,
          })),
        ];
        const messageId = await postMessageMock({
          channel: input.channelId,
          ...(input.threadId ? { thread_ts: input.threadId } : {}),
          ...(input.text ? { text: input.text } : {}),
          unfurl_links: false,
          unfurl_media: false,
          ...(blocks.length > 0 ? { blocks } : {}),
        });
        if (!messageId) {
          throw new Error(
            'Slack chat.postMessage returned no message timestamp',
          );
        }
        return {
          provider: 'slack',
          channelId: input.channelId,
          messageId,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        };
      },
    );
    getCommunicationProviderAdapterMock.mockResolvedValue({
      provider: 'slack',
      resolveChannelId: resolveChannelIdMock,
      isAppInChannel: isAppInChannelMock,
      postMessage: slackAdapterPostMessageMock,
    });
  });

  it('rejects non-run tokens', async () => {
    const authToken: AuthTokenContext = {
      userId: 'user-1',
      tokenType: 'auth',
      version: 1,
    };

    const response = await postChannelMessage(authToken, {
      channel: '#eng',
      text: 'hello',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(403);
    expect(body.error).toBe(
      'Channel post MCP is only available for task run tokens',
    );
  });

  it('rejects invalid channel formats', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun() as never,
    );

    const response = await postChannelMessage(runToken, {
      channel: 'eng room',
      text: 'hello',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      'channel must be a Slack channel ID, channel name, or Slack channel mention like C123ABC456, #eng, eng, or <#C123ABC456>',
    );
  });

  it('rejects direct-message IDs', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun() as never,
    );

    const response = await postChannelMessage(runToken, {
      channel: 'D123ABC456',
      text: 'hello',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      'direct message IDs are not supported; use a Slack channel ID or channel name instead',
    );
  });

  it('rejects lowercase direct-message IDs', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun() as never,
    );

    const response = await postChannelMessage(runToken, {
      channel: 'd123abc456',
      text: 'hello',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      'direct message IDs are not supported; use a Slack channel ID or channel name instead',
    );
  });

  it('accepts raw channel IDs', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);
    resolveChannelIdMock.mockResolvedValueOnce('C123ABC456');

    const response = await postChannelMessage(runToken, {
      channel: 'C123ABC456',
      text: 'hello',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body).toEqual({ messageTs: '999.888', channelId: 'C123ABC456' });
    expect(resolveChannelIdMock).toHaveBeenCalledWith('C123ABC456');
    expect(isAppInChannelMock).toHaveBeenCalledWith('C123ABC456');
    expect(postMessageMock).toHaveBeenCalledWith({
      channel: 'C123ABC456',
      text: 'hello',
      ...expectedNoUnfurl,
      blocks: [{ type: 'markdown', text: 'hello' }],
    });
  });

  it('posts with a token minted for user A after the acting user switched to user B', async () => {
    // Web steer / follow-up delivery mutate task_runs.actingUserId mid-run;
    // the run-scoped token stays authorized (the token's userId is mint-time
    // attribution and is never compared against the mutable acting user).
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun({ actingUserId: 'user-2' }) as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);
    resolveChannelIdMock.mockResolvedValueOnce('C123ABC456');

    const response = await postChannelMessage(runToken, {
      channel: 'C123ABC456',
      text: 'closeout message',
    });

    expect(response.status).toBe(200);
    expect(postMessageMock).toHaveBeenCalled();
  });

  it('posts with a deployment-principal token after a human became the acting user', async () => {
    // A human replying in the thread of an automation run switches the acting
    // user from null to that human; the run-scoped null-principal token must
    // keep working so the automation can still post its Slack closeout.
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun({ actingUserId: 'user-2' }) as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);
    resolveChannelIdMock.mockResolvedValueOnce('C123ABC456');

    const response = await postChannelMessage(
      {
        runId: 42,
        userId: null,
        principal: 'deployment',
        tokenType: 'run',
        version: 1,
      },
      {
        channel: 'C123ABC456',
        text: 'automation closeout',
      },
    );

    expect(response.status).toBe(200);
    expect(postMessageMock).toHaveBeenCalled();
  });

  it('passes markdown tables through channel posts unchanged', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);
    resolveChannelIdMock.mockResolvedValueOnce('C123ABC456');

    const tableText = [
      '| Idea | Status |',
      '| --- | --- |',
      '| Retry jobs | ready |',
      '| Slack CTA | in progress |',
    ].join('\n');

    const response = await postChannelMessage(runToken, {
      channel: 'C123ABC456',
      text: tableText,
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body).toEqual({ messageTs: '999.888', channelId: 'C123ABC456' });
    expect(postMessageMock).toHaveBeenCalledWith({
      channel: 'C123ABC456',
      text: tableText,
      ...expectedNoUnfurl,
      blocks: [{ type: 'markdown', text: tableText }],
    });
  });

  it('accepts lowercase raw channel IDs', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);
    resolveChannelIdMock.mockResolvedValueOnce('C123ABC456');

    const response = await postChannelMessage(runToken, {
      channel: 'c123abc456',
      text: 'hello',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body).toEqual({ messageTs: '999.888', channelId: 'C123ABC456' });
    expect(resolveChannelIdMock).toHaveBeenCalledWith('C123ABC456');
    expect(isAppInChannelMock).toHaveBeenCalledWith('C123ABC456');
    expect(postMessageMock).toHaveBeenCalledWith({
      channel: 'C123ABC456',
      text: 'hello',
      ...expectedNoUnfurl,
      blocks: [{ type: 'markdown', text: 'hello' }],
    });
  });

  it('accepts Slack channel mentions', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);
    resolveChannelIdMock.mockResolvedValueOnce('C123ABC456');

    const response = await postChannelMessage(runToken, {
      channel: '<#C123ABC456|eng>',
      text: 'hello',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body).toEqual({ messageTs: '999.888', channelId: 'C123ABC456' });
    expect(resolveChannelIdMock).toHaveBeenCalledWith('C123ABC456');
  });

  it('accepts lowercase Slack channel mentions', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);
    resolveChannelIdMock.mockResolvedValueOnce('C123ABC456');

    const response = await postChannelMessage(runToken, {
      channel: '<#c123abc456|eng>',
      text: 'hello',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body).toEqual({ messageTs: '999.888', channelId: 'C123ABC456' });
    expect(resolveChannelIdMock).toHaveBeenCalledWith('C123ABC456');
  });

  it('normalizes bare channel names before resolving them', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);

    const response = await postChannelMessage(runToken, {
      channel: 'eng',
      text: 'hello world',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body).toEqual({ messageTs: '999.888', channelId: 'C123' });
    expect(resolveChannelIdMock).toHaveBeenCalledWith('#eng');
  });

  it('treats c/g-prefixed bare names as channel names, not IDs', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);

    const response = await postChannelMessage(runToken, {
      channel: 'general',
      text: 'hello world',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body).toEqual({ messageTs: '999.888', channelId: 'C123' });
    expect(resolveChannelIdMock).toHaveBeenCalledWith('#general');
  });

  it('rejects when the Slack app cannot resolve the channel', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);
    resolveChannelIdMock.mockResolvedValue(null);

    const response = await postChannelMessage(runToken, {
      channel: '#unknown',
      text: 'hello',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(404);
    expect(body.error).toBe('Could not resolve Slack channel #unknown.');
  });

  it('rejects channels the Slack app is not a member of', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);
    isAppInChannelMock.mockResolvedValue(false);

    const response = await postChannelMessage(runToken, {
      channel: '#eng',
      text: 'hello',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(403);
    expect(body.error).toBe('Slack app is not a member of channel #eng.');
  });

  it('posts top-level messages to resolved channels', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);

    const response = await postChannelMessage(runToken, {
      channel: '#eng',
      text: 'hello world',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body).toEqual({ messageTs: '999.888', channelId: 'C123' });
    expect(resolveChannelIdMock).toHaveBeenCalledWith('#eng');
    expect(isAppInChannelMock).toHaveBeenCalledWith('C123');
    expect(postMessageMock).toHaveBeenCalledWith({
      channel: 'C123',
      text: 'hello world',
      ...expectedNoUnfurl,
      blocks: [{ type: 'markdown', text: 'hello world' }],
    });
  });

  it('normalizes hashed channel names before resolving them', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);

    const response = await postChannelMessage(runToken, {
      channel: '#Eng',
      text: 'hello world',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body).toEqual({ messageTs: '999.888', channelId: 'C123' });
    expect(resolveChannelIdMock).toHaveBeenCalledWith('#eng');
  });

  it('posts inside existing threads and includes image blocks', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);
    vi.mocked(db.query.taskArtifacts.findMany).mockResolvedValue([
      {
        id: 'art-1',
        taskId: 'task-1',
        runId: 42,
        contentType: 'image/png',
        uploaded: true,
        path: 'screenshots/capture.png',
      },
    ] as never);

    const response = await postChannelMessage(runToken, {
      channel: 'C123',
      threadTs: '111.222',
      images: [{ artifactId: 'art-1' }],
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body).toEqual({ messageTs: '999.888', channelId: 'C123' });
    expect(postMessageMock).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '111.222',
      text: 'Shared 1 image attachment',
      ...expectedNoUnfurl,
      blocks: [
        {
          type: 'image',
          image_url:
            'https://app.example.com/api/artifacts/art-1/raw?sig=test&ts=1700000000',
          alt_text: 'capture.png',
        },
      ],
    });
  });

  it('rejects threaded channel posts when the Slack thread source message is gone', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);
    postMessageMock.mockResolvedValue(undefined);

    const response = await postChannelMessage(runToken, {
      channel: 'C123',
      threadTs: '111.222',
      text: 'hello world',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(409);
    expect(body.error).toBe('Slack thread source message no longer exists');
    expect(postMessageMock).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '111.222',
      text: 'hello world',
      ...expectedNoUnfurl,
      blocks: [{ type: 'markdown', text: 'hello world' }],
    });
  });

  it('returns 502 when Slack does not return a message timestamp', async () => {
    vi.mocked(db.query.taskRuns.findFirst).mockResolvedValue(
      mockTaskRun() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);
    postMessageMock.mockResolvedValue(undefined);

    const response = await postChannelMessage(runToken, {
      channel: '#eng',
      text: 'hello',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(502);
    expect(body.error).toBe(
      'Slack chat.postMessage returned no message timestamp',
    );
  });
});
