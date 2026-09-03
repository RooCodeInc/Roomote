import { Hono } from 'hono';
import type { RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';

const {
  buildThreadReplyImageBlocksMock,
  clearNextSlackReplyQuoteSuppressionIfIdMock,
  clearLatestUserMessageForReplyQuoteIfIdMock,
  clearLatestUserMessageMock,
  getLatestUserMessageMock,
  getNextSlackReplyQuoteSuppressionMock,
  getActiveSlackRunReplyTargetMock,
  getCustomAutomationByIdMock,
  getTaskChannelBindingsMock,
  isAppInChannelMock,
  maybeSendCommunicationThreadReplyMock,
  postMessageDetailedMock,
  relocateSlackThreadActiveTaskCardsMock,
  resolveAutomationResultSubtitleMock,
  slackInstallationFindFirstMock,
  slackInstallationFindManyMock,
  suppressNextSlackReplyQuoteMock,
  taskRunFindFirstMock,
} = vi.hoisted(() => ({
  buildThreadReplyImageBlocksMock: vi.fn(),
  clearNextSlackReplyQuoteSuppressionIfIdMock: vi.fn(),
  clearLatestUserMessageForReplyQuoteIfIdMock: vi.fn(),
  clearLatestUserMessageMock: vi.fn(),
  getLatestUserMessageMock: vi.fn(),
  getNextSlackReplyQuoteSuppressionMock: vi.fn(),
  getActiveSlackRunReplyTargetMock: vi.fn(),
  getCustomAutomationByIdMock: vi.fn(),
  getTaskChannelBindingsMock: vi.fn(),
  isAppInChannelMock: vi.fn(),
  maybeSendCommunicationThreadReplyMock: vi.fn(),
  postMessageDetailedMock: vi.fn(),
  relocateSlackThreadActiveTaskCardsMock: vi.fn(),
  resolveAutomationResultSubtitleMock: vi.fn(),
  slackInstallationFindFirstMock: vi.fn(),
  slackInstallationFindManyMock: vi.fn(),
  suppressNextSlackReplyQuoteMock: vi.fn(),
  taskRunFindFirstMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  asc: vi.fn(),
  db: {
    query: {
      slackInstallations: {
        findFirst: slackInstallationFindFirstMock,
        findMany: slackInstallationFindManyMock,
      },
      taskRuns: { findFirst: taskRunFindFirstMock },
      tasks: { findFirst: vi.fn().mockResolvedValue(null) },
      workItems: { findFirst: vi.fn() },
    },
  },
  eq: vi.fn(),
  findBackgroundAutomationSlackThread: vi.fn().mockResolvedValue(null),
  getAutomationRuntime: vi.fn().mockResolvedValue({ scheduleMode: 'daily' }),
  getCustomAutomationById: getCustomAutomationByIdMock,
  getTaskAutomationInitiatorKey: vi.fn().mockResolvedValue(null),
  slackInstallations: { isActive: 'isActive', teamId: 'teamId' },
  taskRuns: { id: 'id' },
  tasks: {
    id: 'id',
    slackChannelId: 'slackChannelId',
    slackThreadTs: 'slackThreadTs',
  },
  workItems: { id: 'id' },
}));

vi.mock('@roomote/slack', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/slack')>();
  return {
    ...actual,
    SlackPostDeliveryError: actual.SlackPostDeliveryError,
    buildSlackThreadFooterText: vi.fn().mockReturnValue('Task footer'),
    buildSlackThreadReplyFooterBlock: vi.fn(({ footerText }) => ({
      type: 'context',
      block_id: 'footer',
      elements: [{ type: 'mrkdwn', text: footerText }],
    })),
    clearNextSlackReplyQuoteSuppressionIfId:
      clearNextSlackReplyQuoteSuppressionIfIdMock,
    clearLatestUserMessage: clearLatestUserMessageMock,
    clearSlackThreadReplyFooterMessageTs: vi.fn(),
    getLatestUserMessage: getLatestUserMessageMock,
    getNextSlackReplyQuoteSuppression: getNextSlackReplyQuoteSuppressionMock,
    getActiveSlackRunReplyTarget: getActiveSlackRunReplyTargetMock,
    getSlackThreadReplyFooterMessageTs: vi.fn().mockResolvedValue(null),
    removeSlackThreadReplyFooter: vi.fn(),
    relocateSlackThreadActiveTaskCards: relocateSlackThreadActiveTaskCardsMock,
    resolveSlackThreadFooterContext: vi.fn().mockResolvedValue({
      linkedPrs: [],
      livePreviewUrl: null,
    }),
    resolveSlackThreadLinkedPrs: vi.fn().mockResolvedValue([]),
    ROOMOTE_THREAD_REPLY_QUOTE_BLOCK_ID: 'roomote_thread_reply_quote',
    setLatestSlackBotReply: vi.fn().mockResolvedValue(undefined),
    setSlackThreadReplyFooterMessageTs: vi.fn(),
    SlackNotifier: vi.fn(
      class {
        isAppInChannel = isAppInChannelMock;
        postMessageDetailed = postMessageDetailedMock;
      },
    ),
    suppressNextSlackReplyQuote: suppressNextSlackReplyQuoteMock,
    trackLatestUserMessageForSlackQuote: vi.fn(),
    trackSlackBotReply: vi.fn().mockResolvedValue(undefined),
    withSlackThreadReplyFooterLock: vi.fn(
      async ({ fn }: { fn: () => Promise<unknown> }) => fn(),
    ),
    THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE: 'busy',
  };
});

vi.mock('@roomote/communication/messages', () => ({
  clearLatestUserMessageForReplyQuoteIfId:
    clearLatestUserMessageForReplyQuoteIfIdMock,
  setLatestUserMessageForReplyQuote: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  buildAutomationIconUrl: (icon: string) =>
    `https://app.example.com/automation-icons/${icon}.png`,
  buildCustomAutomationSettingsUrl: (id: string) =>
    `https://app.example.com/automations#custom-automation-${id}`,
  buildManagerSlackSettingsUrl: () => 'https://app.example.com/automations',
  findSlackConversationSubjectByUserId: vi.fn().mockResolvedValue(null),
  recordSlackConversationMessageBestEffort: vi.fn(),
  resolveAutomationResultSubtitle: resolveAutomationResultSubtitleMock,
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
import { eq } from '@roomote/db/server';

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
    getActiveSlackRunReplyTargetMock.mockResolvedValue(null);
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
    slackInstallationFindManyMock.mockResolvedValue([
      { botAccessToken: 'xoxb-test', teamId: 'T123' },
    ]);
    isAppInChannelMock.mockResolvedValue(true);
    getTaskChannelBindingsMock.mockResolvedValue(null);
    maybeSendCommunicationThreadReplyMock.mockResolvedValue(null);
    resolveAutomationResultSubtitleMock.mockResolvedValue({
      type: 'plain_text',
      text: 'Daily · GPT 5.6 High · $0.56 · 02:37s',
    });
    getLatestUserMessageMock.mockResolvedValue({
      id: 'quote-image',
      text: 'Take a screenshot',
      userName: 'Brock',
    });
    getNextSlackReplyQuoteSuppressionMock.mockResolvedValue(null);
    buildThreadReplyImageBlocksMock.mockResolvedValue([
      {
        type: 'image',
        image_url: 'https://example.com/screenshot.png',
        alt_text: 'Screenshot',
      },
    ]);
    postMessageDetailedMock.mockResolvedValue({ ts: '333.444' });
    relocateSlackThreadActiveTaskCardsMock.mockResolvedValue(undefined);
    clearLatestUserMessageForReplyQuoteIfIdMock.mockResolvedValue(true);
    clearNextSlackReplyQuoteSuppressionIfIdMock.mockResolvedValue(true);
    suppressNextSlackReplyQuoteMock.mockResolvedValue('suppression-1');
  });

  it('renders a pending quote on text replies and clears that exact record', async () => {
    buildThreadReplyImageBlocksMock.mockResolvedValue([]);

    const response = await createApp().request('/mcp/thread_reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'On it' }),
    });

    expect(response.status).toBe(200);
    expect(
      relocateSlackThreadActiveTaskCardsMock.mock.invocationCallOrder[0],
    ).toBeLessThan(postMessageDetailedMock.mock.invocationCallOrder[0]!);
    expect(postMessageDetailedMock).toHaveBeenCalledWith(
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

  it('keeps the primary reply isolated from relocation failure', async () => {
    buildThreadReplyImageBlocksMock.mockResolvedValue([]);
    relocateSlackThreadActiveTaskCardsMock.mockRejectedValueOnce(
      new Error('redis unavailable'),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await createApp().request('/mcp/thread_reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Still deliver this' }),
    });

    expect(response.status).toBe(200);
    expect(postMessageDetailedMock).toHaveBeenCalledOnce();
  });

  it('consumes an older pending quote without rendering it when the turn is suppressed', async () => {
    buildThreadReplyImageBlocksMock.mockResolvedValue([]);
    getNextSlackReplyQuoteSuppressionMock.mockResolvedValue('suppression-1');

    const response = await createApp().request('/mcp/thread_reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Fast orchestration reply' }),
    });

    expect(response.status).toBe(200);
    expect(postMessageDetailedMock.mock.calls[0]?.[0]?.blocks).not.toEqual(
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
    expect(clearNextSlackReplyQuoteSuppressionIfIdMock).toHaveBeenCalledWith(
      42,
      'suppression-1',
    );
  });

  it('persists quote suppression for the authenticated task run', async () => {
    const response = await createApp().request('/mcp/suppress_reply_quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 42 }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      quoteId: 'suppression-1',
    });
    expect(suppressNextSlackReplyQuoteMock).toHaveBeenCalledWith(42);
  });

  it('replies to the active turn target instead of the task source thread', async () => {
    getActiveSlackRunReplyTargetMock.mockResolvedValue({
      slackTeamId: 'T_ALERT',
      channel: 'C_ALERT',
      threadTs: '222.333',
    });
    getTaskChannelBindingsMock.mockResolvedValue({
      slackChannelId: 'C_SOURCE',
      slackThreadTs: '111.222',
    });
    slackInstallationFindFirstMock.mockResolvedValue({
      botAccessToken: 'xoxb-alert',
      teamId: 'T_ALERT',
    });

    const response = await createApp().request('/mcp/thread_reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Responding in the alert thread' }),
    });

    expect(response.status).toBe(200);
    expect(eq).toHaveBeenCalledWith('teamId', 'T_ALERT');
    expect(postMessageDetailedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C_ALERT',
        thread_ts: '222.333',
      }),
    );
  });

  it('uses the task Slack workspace when selecting the reply installation', async () => {
    taskRunFindFirstMock.mockResolvedValue({
      id: 42,
      actingUserId: null,
      taskId: 'task-1',
      payload: {
        channel: 'D123',
        thread_ts: '111.222',
        slackTeamId: 'T_DM',
      },
    });

    const response = await createApp().request('/mcp/thread_reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Private report' }),
    });

    expect(response.status).toBe(200);
    expect(eq).toHaveBeenCalledWith('teamId', 'T_DM');
    expect(postMessageDetailedMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'D123' }),
    );
  });

  it('preserves custom automation root report Markdown at the top level', async () => {
    taskRunFindFirstMock.mockResolvedValue({
      id: 42,
      actingUserId: null,
      taskId: 'task-1',
      payload: { channel: 'C123', customAutomationId: 'automation-1' },
    });
    getCustomAutomationByIdMock.mockResolvedValue({
      id: 'automation-1',
      name: 'Daily demo ideas',
      scheduleMode: 'daily',
    });
    buildThreadReplyImageBlocksMock.mockResolvedValue([]);

    const response = await createApp().request('/mcp/thread_reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: '**Summary**\n\n| Idea | Priority |\n| --- | --- |\n| Demo | High |',
      }),
    });

    expect(response.status).toBe(200);
    expect(postMessageDetailedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        blocks: [
          expect.objectContaining({
            type: 'context',
            elements: expect.arrayContaining([
              expect.objectContaining({ text: 'Daily demo ideas' }),
              expect.objectContaining({
                text: 'Daily · GPT 5.6 High · $0.56 · 02:37s',
              }),
            ]),
          }),
          {
            type: 'markdown',
            text: '**Summary**\n\n| Idea | Priority |\n| --- | --- |\n| Demo | High |',
          },
          expect.objectContaining({
            type: 'actions',
            elements: expect.arrayContaining([
              expect.objectContaining({
                action_id: 'late_bound_automation_view_task',
              }),
              expect.objectContaining({
                action_id: 'late_bound_automation_configure',
                url: 'https://app.example.com/automations#custom-automation-automation-1',
              }),
            ]),
          }),
        ],
      }),
    );
  });

  it('selects the Slack installation that owns a late-bound automation channel', async () => {
    taskRunFindFirstMock.mockResolvedValue({
      id: 42,
      actingUserId: null,
      taskId: 'task-1',
      payload: { channel: 'C123', customAutomationId: 'automation-1' },
    });
    slackInstallationFindManyMock.mockResolvedValue([
      { botAccessToken: 'xoxb-other', teamId: 'T_OTHER' },
      { botAccessToken: 'xoxb-owner', teamId: 'T_OWNER' },
    ]);
    isAppInChannelMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    getCustomAutomationByIdMock.mockResolvedValue({
      id: 'automation-1',
      name: 'Daily demo ideas',
      scheduleMode: 'daily',
    });
    buildThreadReplyImageBlocksMock.mockResolvedValue([]);

    const response = await createApp().request('/mcp/thread_reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'A result worth reporting' }),
    });

    expect(response.status).toBe(200);
    expect(slackInstallationFindFirstMock).not.toHaveBeenCalled();
    expect(isAppInChannelMock).toHaveBeenNthCalledWith(1, 'C123');
    expect(isAppInChannelMock).toHaveBeenNthCalledWith(2, 'C123');
    expect(postMessageDetailedMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C123' }),
    );
  });

  it('rejects an ambiguous late-bound automation channel', async () => {
    taskRunFindFirstMock.mockResolvedValue({
      id: 42,
      actingUserId: null,
      taskId: 'task-1',
      payload: { channel: 'C123', customAutomationId: 'automation-1' },
    });
    slackInstallationFindManyMock.mockResolvedValue([
      { botAccessToken: 'xoxb-first', teamId: 'T_FIRST' },
      { botAccessToken: 'xoxb-second', teamId: 'T_SECOND' },
    ]);
    isAppInChannelMock.mockResolvedValue(true);

    const response = await createApp().request('/mcp/thread_reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'A result worth reporting' }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error:
        'Slack report destination could not be resolved to one active installation',
    });
    expect(slackInstallationFindFirstMock).not.toHaveBeenCalled();
    expect(postMessageDetailedMock).not.toHaveBeenCalled();
  });

  it('returns a retryable error when late-bound channel membership is indeterminate', async () => {
    taskRunFindFirstMock.mockResolvedValue({
      id: 42,
      actingUserId: null,
      taskId: 'task-1',
      payload: { channel: 'C123', customAutomationId: 'automation-1' },
    });
    slackInstallationFindManyMock.mockResolvedValue([
      { botAccessToken: 'xoxb-owner', teamId: 'T_OWNER' },
      { botAccessToken: 'xoxb-unknown', teamId: 'T_UNKNOWN' },
    ]);
    isAppInChannelMock.mockResolvedValueOnce(true).mockResolvedValueOnce(null);

    const response = await createApp().request('/mcp/thread_reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'A result worth reporting' }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'Slack report destination could not be verified; retry shortly',
      retryable: true,
    });
    expect(slackInstallationFindFirstMock).not.toHaveBeenCalled();
    expect(postMessageDetailedMock).not.toHaveBeenCalled();
  });

  it('consumes the exact pending quote after an image-only reply without rendering it', async () => {
    const response = await createApp().request('/mcp/thread_reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ images: [{ artifactId: 'artifact-1' }] }),
    });

    expect(response.status).toBe(200);
    expect(postMessageDetailedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '111.222',
        blocks: expect.arrayContaining([
          expect.objectContaining({ type: 'image' }),
        ]),
      }),
    );
    expect(postMessageDetailedMock.mock.calls[0]?.[0]?.blocks).not.toEqual(
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
    expect(postMessageDetailedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: expect.arrayContaining([
          expect.objectContaining({
            block_id: 'roomote_thread_reply_quote',
          }),
        ]),
      }),
    );
    expect(postMessageDetailedMock.mock.calls[0]?.[0]?.blocks).not.toEqual(
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
    getNextSlackReplyQuoteSuppressionMock.mockResolvedValue('suppression-1');
    postMessageDetailedMock.mockRejectedValueOnce(
      new Error('Slack unavailable'),
    );

    const response = await createApp().request('/mcp/thread_reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'On it' }),
    });

    expect(response.status).toBe(500);
    expect(clearLatestUserMessageForReplyQuoteIfIdMock).not.toHaveBeenCalled();
    expect(clearNextSlackReplyQuoteSuppressionIfIdMock).not.toHaveBeenCalled();
  });

  it('maps a permanent Slack posting error to a non-retryable structured response', async () => {
    buildThreadReplyImageBlocksMock.mockResolvedValue([]);
    postMessageDetailedMock.mockResolvedValue({
      slackErrorCode: 'not_in_channel',
    });

    const response = await createApp().request('/mcp/thread_reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'On it' }),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: 'Slack chat.postMessage failed: not_in_channel',
      slackErrorCode: 'not_in_channel',
      retryable: false,
    });
  });

  it('maps a transport-level Slack posting failure to a retryable 502', async () => {
    buildThreadReplyImageBlocksMock.mockResolvedValue([]);
    postMessageDetailedMock.mockResolvedValue({ transportError: true });

    const response = await createApp().request('/mcp/thread_reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'On it' }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'Slack chat.postMessage failed: transport error',
      slackErrorCode: null,
      retryable: true,
    });
  });

  it('keeps reporting a deleted thread root as a 409', async () => {
    buildThreadReplyImageBlocksMock.mockResolvedValue([]);
    postMessageDetailedMock.mockResolvedValue({
      skippedMissingThreadRoot: true,
    });

    const response = await createApp().request('/mcp/thread_reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'On it' }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Slack thread source message no longer exists',
    });
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
    expect(clearNextSlackReplyQuoteSuppressionIfIdMock).toHaveBeenCalledWith(
      42,
      'quote-1',
    );
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
  });
});
