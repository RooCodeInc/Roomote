import { Hono } from 'hono';
import type { AuthTokenContext, JobTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';

const {
  postMessageMock,
  resolveChannelIdMock,
  isAppInChannelMock,
  buildSignedArtifactRawUrlMock,
  currentEpochSecondsMock,
} = vi.hoisted(() => ({
  postMessageMock: vi.fn(),
  resolveChannelIdMock: vi.fn(),
  isAppInChannelMock: vi.fn(),
  buildSignedArtifactRawUrlMock: vi.fn(),
  currentEpochSecondsMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      cloudJobs: { findFirst: vi.fn() },
      slackInstallations: { findFirst: vi.fn() },
      taskArtifacts: { findMany: vi.fn() },
    },
  },
  cloudJobs: { id: 'id' },
  slackInstallations: { orgId: 'orgId', isActive: 'isActive' },
  taskArtifacts: { id: 'id' },
  eq: vi.fn(),
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

function mockCloudJob(
  overrides: Partial<{
    id: number;
    orgId: string;
    userId: string | null;
    taskId: string;
  }> = {},
) {
  return {
    id: 42,
    userId: 'user-1',
    taskId: 'task-1',
    ...overrides,
  };
}

describe('slack channel post MCP endpoint', () => {
  const jobToken: JobTokenContext = {
    cloudJobId: 42,
    userId: 'user-1',
    tokenType: 'cj',
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
  });

  it('rejects non-job tokens', async () => {
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
      'Slack channel post MCP is only available for cloud job tokens',
    );
  });

  it('rejects invalid channel formats', async () => {
    vi.mocked(db.query.cloudJobs.findFirst).mockResolvedValue(
      mockCloudJob() as never,
    );

    const response = await postChannelMessage(jobToken, {
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
    vi.mocked(db.query.cloudJobs.findFirst).mockResolvedValue(
      mockCloudJob() as never,
    );

    const response = await postChannelMessage(jobToken, {
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
    vi.mocked(db.query.cloudJobs.findFirst).mockResolvedValue(
      mockCloudJob() as never,
    );

    const response = await postChannelMessage(jobToken, {
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
    vi.mocked(db.query.cloudJobs.findFirst).mockResolvedValue(
      mockCloudJob() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);
    resolveChannelIdMock.mockResolvedValueOnce('C123ABC456');

    const response = await postChannelMessage(jobToken, {
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

  it('passes markdown tables through channel posts unchanged', async () => {
    vi.mocked(db.query.cloudJobs.findFirst).mockResolvedValue(
      mockCloudJob() as never,
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

    const response = await postChannelMessage(jobToken, {
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
    vi.mocked(db.query.cloudJobs.findFirst).mockResolvedValue(
      mockCloudJob() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);
    resolveChannelIdMock.mockResolvedValueOnce('C123ABC456');

    const response = await postChannelMessage(jobToken, {
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
    vi.mocked(db.query.cloudJobs.findFirst).mockResolvedValue(
      mockCloudJob() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);
    resolveChannelIdMock.mockResolvedValueOnce('C123ABC456');

    const response = await postChannelMessage(jobToken, {
      channel: '<#C123ABC456|eng>',
      text: 'hello',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body).toEqual({ messageTs: '999.888', channelId: 'C123ABC456' });
    expect(resolveChannelIdMock).toHaveBeenCalledWith('C123ABC456');
  });

  it('accepts lowercase Slack channel mentions', async () => {
    vi.mocked(db.query.cloudJobs.findFirst).mockResolvedValue(
      mockCloudJob() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);
    resolveChannelIdMock.mockResolvedValueOnce('C123ABC456');

    const response = await postChannelMessage(jobToken, {
      channel: '<#c123abc456|eng>',
      text: 'hello',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body).toEqual({ messageTs: '999.888', channelId: 'C123ABC456' });
    expect(resolveChannelIdMock).toHaveBeenCalledWith('C123ABC456');
  });

  it('normalizes bare channel names before resolving them', async () => {
    vi.mocked(db.query.cloudJobs.findFirst).mockResolvedValue(
      mockCloudJob() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);

    const response = await postChannelMessage(jobToken, {
      channel: 'eng',
      text: 'hello world',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body).toEqual({ messageTs: '999.888', channelId: 'C123' });
    expect(resolveChannelIdMock).toHaveBeenCalledWith('#eng');
  });

  it('treats c/g-prefixed bare names as channel names, not IDs', async () => {
    vi.mocked(db.query.cloudJobs.findFirst).mockResolvedValue(
      mockCloudJob() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);

    const response = await postChannelMessage(jobToken, {
      channel: 'general',
      text: 'hello world',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body).toEqual({ messageTs: '999.888', channelId: 'C123' });
    expect(resolveChannelIdMock).toHaveBeenCalledWith('#general');
  });

  it('rejects when the Slack app cannot resolve the channel', async () => {
    vi.mocked(db.query.cloudJobs.findFirst).mockResolvedValue(
      mockCloudJob() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);
    resolveChannelIdMock.mockResolvedValue(null);

    const response = await postChannelMessage(jobToken, {
      channel: '#unknown',
      text: 'hello',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(404);
    expect(body.error).toBe('Could not resolve Slack channel #unknown.');
  });

  it('rejects channels the Slack app is not a member of', async () => {
    vi.mocked(db.query.cloudJobs.findFirst).mockResolvedValue(
      mockCloudJob() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);
    isAppInChannelMock.mockResolvedValue(false);

    const response = await postChannelMessage(jobToken, {
      channel: '#eng',
      text: 'hello',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(403);
    expect(body.error).toBe('Slack app is not a member of channel #eng.');
  });

  it('posts top-level messages to resolved channels', async () => {
    vi.mocked(db.query.cloudJobs.findFirst).mockResolvedValue(
      mockCloudJob() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);

    const response = await postChannelMessage(jobToken, {
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
    vi.mocked(db.query.cloudJobs.findFirst).mockResolvedValue(
      mockCloudJob() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);

    const response = await postChannelMessage(jobToken, {
      channel: '#Eng',
      text: 'hello world',
    });
    const body = (await response.json()) as JsonBody;

    expect(response.status).toBe(200);
    expect(body).toEqual({ messageTs: '999.888', channelId: 'C123' });
    expect(resolveChannelIdMock).toHaveBeenCalledWith('#eng');
  });

  it('posts inside existing threads and includes image blocks', async () => {
    vi.mocked(db.query.cloudJobs.findFirst).mockResolvedValue(
      mockCloudJob() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);
    vi.mocked(db.query.taskArtifacts.findMany).mockResolvedValue([
      {
        id: 'art-1',
        taskId: 'task-1',
        cloudJobId: 42,
        contentType: 'image/png',
        uploaded: true,
        path: 'screenshots/capture.png',
      },
    ] as never);

    const response = await postChannelMessage(jobToken, {
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
    vi.mocked(db.query.cloudJobs.findFirst).mockResolvedValue(
      mockCloudJob() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);
    postMessageMock.mockResolvedValue(undefined);

    const response = await postChannelMessage(jobToken, {
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
    vi.mocked(db.query.cloudJobs.findFirst).mockResolvedValue(
      mockCloudJob() as never,
    );
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue({
      botAccessToken: 'xoxb-test',
    } as never);
    postMessageMock.mockResolvedValue(undefined);

    const response = await postChannelMessage(jobToken, {
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
