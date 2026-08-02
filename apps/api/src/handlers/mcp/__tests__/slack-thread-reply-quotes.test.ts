import { Hono } from 'hono';
import type { RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';

const {
  buildThreadReplyImageBlocksMock,
  clearLatestUserMessageForReplyQuoteIfContentMock,
  clearLatestUserMessageForReplyQuoteIfIdMock,
  clearLatestUserMessageMock,
  getLatestUserMessageMock,
  getTaskChannelBindingsMock,
  maybeSendCommunicationThreadReplyMock,
  postMessageMock,
  slackInstallationFindFirstMock,
  taskRunFindFirstMock,
} = vi.hoisted(() => ({
  buildThreadReplyImageBlocksMock: vi.fn(),
  clearLatestUserMessageForReplyQuoteIfContentMock: vi.fn(),
  clearLatestUserMessageForReplyQuoteIfIdMock: vi.fn(),
  clearLatestUserMessageMock: vi.fn(),
  getLatestUserMessageMock: vi.fn(),
  getTaskChannelBindingsMock: vi.fn(),
  maybeSendCommunicationThreadReplyMock: vi.fn(),
  postMessageMock: vi.fn(),
  slackInstallationFindFirstMock: vi.fn(),
  taskRunFindFirstMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  asc: vi.fn(),
  db: {
    query: {
      slackInstallations: { findFirst: slackInstallationFindFirstMock },
      taskRuns: { findFirst: taskRunFindFirstMock },
      tasks: { findFirst: vi.fn().mockResolvedValue(null) },
      workItems: { findFirst: vi.fn() },
    },
  },
  eq: vi.fn(),
  findBackgroundAutomationSlackThread: vi.fn().mockResolvedValue(null),
  getCustomAutomationById: vi.fn(),
  getTaskAutomationInitiatorKey: vi.fn().mockResolvedValue(null),
  slackInstallations: { isActive: 'isActive' },
  taskRuns: { id: 'id' },
  tasks: {
    id: 'id',
    slackChannelId: 'slackChannelId',
    slackThreadTs: 'slackThreadTs',
  },
  workItems: { id: 'id' },
}));

vi.mock('@roomote/slack', () => ({
  buildSlackThreadFooterText: vi.fn().mockReturnValue('Task footer'),
  buildSlackThreadReplyFooterBlock: vi.fn(({ footerText }) => ({
    type: 'context',
    block_id: 'footer',
    elements: [{ type: 'mrkdwn', text: footerText }],
  })),
  clearLatestUserMessage: clearLatestUserMessageMock,
  clearSlackThreadReplyFooterMessageTs: vi.fn(),
  getLatestUserMessage: getLatestUserMessageMock,
  getSlackThreadReplyFooterMessageTs: vi.fn().mockResolvedValue(null),
  removeSlackThreadReplyFooter: vi.fn(),
  resolveSlackThreadFooterContext: vi.fn().mockResolvedValue({
    linkedPr: null,
    livePreviewUrl: null,
  }),
  resolveSlackThreadLinkedPr: vi.fn(),
  resolveSlackThreadLivePreviewUrl: vi.fn(),
  ROOMOTE_THREAD_REPLY_QUOTE_BLOCK_ID: 'roomote_thread_reply_quote',
  setLatestSlackBotReply: vi.fn(),
  setSlackThreadReplyFooterMessageTs: vi.fn(),
  SlackNotifier: vi.fn(
    class {
      postMessage = postMessageMock;
    },
  ),
  trackLatestUserMessageForSlackQuote: vi.fn(),
  trackSlackBotReply: vi.fn(),
  withSlackThreadReplyFooterLock: vi.fn(
    async ({ fn }: { fn: () => Promise<unknown> }) => fn(),
  ),
  THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE: 'busy',
}));

vi.mock('@roomote/communication/messages', () => ({
  clearLatestUserMessageForReplyQuoteIfContent:
    clearLatestUserMessageForReplyQuoteIfContentMock,
  clearLatestUserMessageForReplyQuoteIfId:
    clearLatestUserMessageForReplyQuoteIfIdMock,
  setLatestUserMessageForReplyQuote: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  findSlackConversationSubjectByUserId: vi.fn().mockResolvedValue(null),
  recordSlackConversationMessageBestEffort: vi.fn(),
}));

vi.mock('../communication-thread-replies', () => ({
  maybeAddCommunicationReaction: vi.fn(),
  maybeSendCommunicationThreadReply: maybeSendCommunicationThreadReplyMock,
}));

vi.mock('../chat-reply-helpers', () => ({
  buildThreadReplyImageBlocks: buildThreadReplyImageBlocksMock,
  errorResponseForThreadReplyImageError: vi.fn(),
}));

vi.mock('../../tasks/helpers', () => ({
  getTaskChannelBindings: getTaskChannelBindingsMock,
}));

vi.mock('../../tasks/automation-work-items/slack.js', () => ({
  bindLateSlackThreadToTask: vi.fn(),
}));

vi.mock('../../tasks/automation-slack-root-footer.js', () => ({
  buildAutomationRootFooterBlocks: vi.fn(),
  refreshAutomationRootFooter: vi.fn(),
}));

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: { R_APP_URL: 'https://app.example.com' },
  };
});

import { mcpAuthMiddleware } from '../middleware';
import { slackMcp } from '../slack';

const runToken: RunTokenContext = {
  runId: 42,
  userId: 'user-1',
  principal: 'user',
  tokenType: 'run',
  version: 1,
};

function createApp() {
  const app = new Hono<{ Variables: Variables }>();
  app.onError(() => new Response(null, { status: 500 }));
  app.use('*', async (c, next) => {
    c.set('authContext', runToken);
    await next();
  });
  app.use('/mcp/*', mcpAuthMiddleware);
  app.route('/mcp', slackMcp);
  return app;
}

describe('Slack thread reply quotes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskRunFindFirstMock.mockResolvedValue({
      id: 42,
      actingUserId: null,
      taskId: 'task-1',
      payload: { channel: 'C123', thread_ts: '111.222' },
    });
    slackInstallationFindFirstMock.mockResolvedValue({
      botAccessToken: 'xoxb-test',
      teamId: 'T123',
    });
    getTaskChannelBindingsMock.mockResolvedValue(null);
    maybeSendCommunicationThreadReplyMock.mockResolvedValue(null);
    getLatestUserMessageMock.mockResolvedValue({
      id: 'quote-image',
      text: 'Take a screenshot',
      userName: 'Brock',
    });
    buildThreadReplyImageBlocksMock.mockResolvedValue([
      {
        type: 'image',
        image_url: 'https://example.com/screenshot.png',
        alt_text: 'Screenshot',
      },
    ]);
    postMessageMock.mockResolvedValue('333.444');
    clearLatestUserMessageForReplyQuoteIfIdMock.mockResolvedValue(true);
  });

  it('renders a pending quote on text replies and clears that exact record', async () => {
    buildThreadReplyImageBlocksMock.mockResolvedValue([]);

    const response = await createApp().request('/mcp/thread_reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'On it' }),
    });

    expect(response.status).toBe(200);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '111.222',
        blocks: expect.arrayContaining([
          expect.objectContaining({
            block_id: 'roomote_thread_reply_quote',
            text: {
              type: 'mrkdwn',
              text: '>*Brock:* Take a screenshot',
            },
          }),
        ]),
      }),
    );
    expect(clearLatestUserMessageForReplyQuoteIfIdMock).toHaveBeenCalledWith(
      'slack',
      42,
      'quote-image',
    );
  });

  it('consumes the exact pending quote after an image-only reply without rendering it', async () => {
    const response = await createApp().request('/mcp/thread_reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ images: [{ artifactId: 'artifact-1' }] }),
    });

    expect(response.status).toBe(200);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '111.222',
        blocks: expect.arrayContaining([
          expect.objectContaining({ type: 'image' }),
        ]),
      }),
    );
    expect(postMessageMock.mock.calls[0]?.[0]?.blocks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          block_id: 'roomote_thread_reply_quote',
        }),
      ]),
    );
    expect(clearLatestUserMessageForReplyQuoteIfIdMock).toHaveBeenCalledWith(
      'slack',
      42,
      'quote-image',
    );
  });

  it('quotes and consumes web follow-ups in setup threads without a footer', async () => {
    taskRunFindFirstMock.mockResolvedValue({
      id: 42,
      actingUserId: null,
      taskId: 'task-1',
      payload: {
        channel: 'C123',
        thread_ts: '111.222',
        webPath: '/setup',
      },
    });
    buildThreadReplyImageBlocksMock.mockResolvedValue([]);

    const response = await createApp().request('/mcp/thread_reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'On it' }),
    });

    expect(response.status).toBe(200);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: expect.arrayContaining([
          expect.objectContaining({
            block_id: 'roomote_thread_reply_quote',
          }),
        ]),
      }),
    );
    expect(postMessageMock.mock.calls[0]?.[0]?.blocks).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ block_id: 'footer' })]),
    );
    expect(clearLatestUserMessageForReplyQuoteIfIdMock).toHaveBeenCalledWith(
      'slack',
      42,
      'quote-image',
    );
  });

  it('keeps the pending quote when Slack delivery fails', async () => {
    buildThreadReplyImageBlocksMock.mockResolvedValue([]);
    postMessageMock.mockRejectedValueOnce(new Error('Slack unavailable'));

    const response = await createApp().request('/mcp/thread_reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'On it' }),
    });

    expect(response.status).toBe(500);
    expect(clearLatestUserMessageForReplyQuoteIfIdMock).not.toHaveBeenCalled();
  });

  it('clears exactly by id when the clear request carries a quoteId', async () => {
    const response = await createApp().request('/mcp/clear_reply_quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 42, quoteId: 'quote-1' }),
    });

    expect(response.status).toBe(200);
    expect(clearLatestUserMessageForReplyQuoteIfIdMock).toHaveBeenCalledWith(
      'slack',
      42,
      'quote-1',
    );
    expect(
      clearLatestUserMessageForReplyQuoteIfContentMock,
    ).not.toHaveBeenCalled();
    expect(clearLatestUserMessageMock).not.toHaveBeenCalled();
  });

  it('scopes id-less clears by tracked content so a newer quote survives', async () => {
    const response = await createApp().request('/mcp/clear_reply_quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 42,
        text: 'Follow up from web',
        userName: 'Casey',
      }),
    });

    expect(response.status).toBe(200);
    expect(
      clearLatestUserMessageForReplyQuoteIfContentMock,
    ).toHaveBeenCalledWith('slack', 42, {
      text: 'Follow up from web',
      userName: 'Casey',
    });
    expect(clearLatestUserMessageForReplyQuoteIfIdMock).not.toHaveBeenCalled();
    expect(clearLatestUserMessageMock).not.toHaveBeenCalled();
  });

  it('keeps the run-scoped clear contract for bare previous-release requests', async () => {
    const response = await createApp().request('/mcp/clear_reply_quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 42 }),
    });

    expect(response.status).toBe(200);
    expect(clearLatestUserMessageMock).toHaveBeenCalledWith(42);
    expect(clearLatestUserMessageForReplyQuoteIfIdMock).not.toHaveBeenCalled();
    expect(
      clearLatestUserMessageForReplyQuoteIfContentMock,
    ).not.toHaveBeenCalled();
  });
});
