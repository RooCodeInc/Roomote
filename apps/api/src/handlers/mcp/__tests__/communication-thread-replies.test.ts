import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTeamsCommunicationProviderFromRuntimeCredentials } from '@roomote/sdk/server';

const {
  buildThreadReplyImagesMock,
  clearLatestUserMessageForReplyQuoteIfIdMock,
  discordAddReactionMock,
  discordCreateThreadFromMessageMock,
  discordEditMessageMock,
  discordPostMessageMock,
  dbTransactionMock,
  envMock,
  getTaskAutomationInitiatorKeyMock,
  getLatestInboundMessageIdMock,
  getLatestUserMessageForReplyQuoteMock,
  postMessageMock,
  sendChatActionMock,
  resolveTelegramRuntimeCredentialsMock,
  resolveDiscordRuntimeCredentialsMock,
  sqlMock,
  upsertBackgroundAutomationSlackThreadMock,
  withThreadReplyFooterLockMock,
} = vi.hoisted(() => ({
  buildThreadReplyImagesMock: vi.fn(),
  clearLatestUserMessageForReplyQuoteIfIdMock: vi.fn(),
  discordAddReactionMock: vi.fn(),
  discordCreateThreadFromMessageMock: vi.fn(),
  discordEditMessageMock: vi.fn(),
  discordPostMessageMock: vi.fn(),
  dbTransactionMock: vi.fn(),
  envMock: { R_APP_URL: 'https://app.example.com' },
  getTaskAutomationInitiatorKeyMock: vi.fn(),
  getLatestInboundMessageIdMock: vi.fn(),
  getLatestUserMessageForReplyQuoteMock: vi.fn(),
  postMessageMock: vi.fn(),
  sendChatActionMock: vi.fn(),
  resolveTelegramRuntimeCredentialsMock: vi.fn(),
  resolveDiscordRuntimeCredentialsMock: vi.fn(),
  sqlMock: vi.fn(),
  upsertBackgroundAutomationSlackThreadMock: vi.fn(),
  withThreadReplyFooterLockMock: vi.fn(),
}));

vi.mock('@roomote/env', () => ({ Env: envMock }));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  db: { transaction: dbTransactionMock },
  eq: vi.fn(),
  getTaskAutomationInitiatorKey: getTaskAutomationInitiatorKeyMock,
  resolveDiscordRuntimeCredentials: resolveDiscordRuntimeCredentialsMock,
  resolveTelegramRuntimeCredentials: resolveTelegramRuntimeCredentialsMock,
  sql: sqlMock,
  taskRuns: { id: 'id', payload: 'payload', taskId: 'taskId' },
  upsertBackgroundAutomationSlackThread:
    upsertBackgroundAutomationSlackThreadMock,
}));

vi.mock('@roomote/communication', () => ({
  buildThreadReplyFooterText: vi.fn().mockReturnValue(null),
  formatMarkdownLink: vi.fn(),
  getThreadReplyFooterRecord: vi.fn(),
  TelegramCommunicationProvider: vi.fn().mockImplementation(function () {
    return { postMessage: postMessageMock, sendChatAction: sendChatActionMock };
  }),
  TeamsCommunicationProvider: vi.fn(),
  DiscordCommunicationProvider: vi.fn().mockImplementation(function () {
    return {
      postMessage: discordPostMessageMock,
      addReaction: discordAddReactionMock,
      createThreadFromMessage: discordCreateThreadFromMessageMock,
      editMessage: discordEditMessageMock,
    };
  }),
  UnsupportedCommunicationOperationError: class UnsupportedCommunicationOperationError extends Error {},
  getLatestInboundMessageId: getLatestInboundMessageIdMock,
  getLatestUserMessageForReplyQuote: getLatestUserMessageForReplyQuoteMock,
  clearLatestUserMessageForReplyQuoteIfId:
    clearLatestUserMessageForReplyQuoteIfIdMock,
  chunkDiscordMessage: (text: string) =>
    text.length <= 2_000 ? [text] : text.split('\n\n'),
  resolveThreadReplyFooterContext: vi.fn().mockResolvedValue({
    linkedPr: null,
    livePreviewUrl: null,
  }),
  setThreadReplyFooterRecord: vi.fn(),
}));

vi.mock('@roomote/communication/chat-messages', () => ({
  buildThreadReplyFooterText: vi.fn(),
  formatMarkdownLink: vi.fn(),
}));

vi.mock('@roomote/communication/thread-reply-footer-state', () => ({
  getThreadReplyFooterRecord: vi.fn(),
  setThreadReplyFooterRecord: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  createTeamsCommunicationProviderFromRuntimeCredentials: vi.fn(),
  createTelegramCommunicationProviderFromRuntimeCredentials: vi.fn(async () => {
    const { botToken } = await resolveTelegramRuntimeCredentialsMock();

    return botToken
      ? { postMessage: postMessageMock, sendChatAction: sendChatActionMock }
      : null;
  }),
  createDiscordCommunicationProviderFromRuntimeCredentials: vi.fn(async () => {
    const { botToken } = await resolveDiscordRuntimeCredentialsMock();

    return botToken
      ? {
          postMessage: discordPostMessageMock,
          addReaction: discordAddReactionMock,
          createThreadFromMessage: discordCreateThreadFromMessageMock,
          editMessage: discordEditMessageMock,
          triggerTyping: vi.fn(async () => undefined),
        }
      : null;
  }),
}));

vi.mock('@roomote/slack', () => ({
  resolveSlackThreadLinkedPr: vi.fn(),
  resolveSlackThreadLivePreviewUrl: vi.fn(),
}));

vi.mock('../chat-reply-helpers.js', () => ({
  buildThreadReplyImages: buildThreadReplyImagesMock,
  errorResponseForThreadReplyImageError: vi.fn(),
  THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE: 'busy',
  withThreadReplyFooterLock: withThreadReplyFooterLockMock,
}));

import {
  buildThreadReplyFooterText,
  getThreadReplyFooterRecord,
  setThreadReplyFooterRecord,
} from '@roomote/communication';
import {
  maybeAddCommunicationReaction,
  maybeSendCommunicationThreadReply,
} from '../communication-thread-replies';

const telegramTaskRun = {
  id: 42,
  taskId: 'task-1',
  prRepo: null,
  prNumber: null,
  payload: {
    communicationProvider: 'telegram',
    communicationChannelId: '222',
    communicationMessageId: '100',
  },
};

const teamsTaskRun = {
  id: 43,
  taskId: 'task-2',
  prRepo: null,
  prNumber: null,
  payload: {
    communicationProvider: 'teams',
    communicationChannelId: '19:conversation@thread.v2',
    communicationServiceUrl: 'https://smba.trafficmanager.net/amer/',
    communicationThreadId: 'activity-root',
    communicationMessageId: 'activity-root',
  },
};

const discordTaskRun = {
  id: 44,
  taskId: 'task-3',
  prRepo: null,
  prNumber: null,
  payload: {
    communicationProvider: 'discord',
    communicationGuildId: 'guild-1',
    communicationChannelId: 'channel-1',
    communicationThreadId: 'thread-1',
    communicationMessageId: 'message-1',
  },
};

describe('maybeSendCommunicationThreadReply (Discord)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const returning = vi.fn().mockResolvedValue([{ id: 44 }]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    dbTransactionMock.mockImplementation(async (callback) =>
      callback({ update }),
    );
    getTaskAutomationInitiatorKeyMock.mockResolvedValue(null);
    resolveDiscordRuntimeCredentialsMock.mockResolvedValue({
      botToken: 'discord-token',
      applicationId: 'application-1',
    });
    buildThreadReplyImagesMock.mockResolvedValue([]);
    getLatestUserMessageForReplyQuoteMock.mockResolvedValue(null);
    clearLatestUserMessageForReplyQuoteIfIdMock.mockResolvedValue(true);
    discordPostMessageMock.mockResolvedValue({ messageId: 'reply-1' });
    discordCreateThreadFromMessageMock.mockResolvedValue({
      channelId: 'automation-thread-1',
      parentChannelId: 'channel-1',
      name: 'Automation report',
      kind: 'thread',
      messageId: 'reply-1',
    });
    discordEditMessageMock.mockResolvedValue(undefined);
    vi.mocked(buildThreadReplyFooterText).mockReturnValue(null as never);
    vi.mocked(getThreadReplyFooterRecord).mockResolvedValue(null);
    withThreadReplyFooterLockMock.mockImplementation(
      async ({ fn }: { fn: () => Promise<unknown> }) => fn(),
    );
    discordAddReactionMock.mockResolvedValue({
      channelId: 'thread-1',
      messageId: 'message-2',
      name: '👀',
    });
  });

  it('posts directly into the task thread without quoting when no web reply is pending', async () => {
    const response = await maybeSendCommunicationThreadReply({
      taskRun: discordTaskRun,
      parsedBody: { text: 'done', images: [] },
    });

    expect(response).not.toBeNull();
    expect(getLatestUserMessageForReplyQuoteMock).toHaveBeenCalledWith(
      'discord',
      44,
    );
    expect(discordPostMessageMock).toHaveBeenCalledWith({
      channelId: 'channel-1',
      threadId: 'thread-1',
      text: 'done',
      textFormat: 'markdown',
      images: [],
    });
    expect(discordPostMessageMock.mock.calls[0]?.[0]).not.toHaveProperty(
      'replyToMessageId',
    );
    expect(clearLatestUserMessageForReplyQuoteIfIdMock).not.toHaveBeenCalled();
  });

  it('creates and binds a real thread for a late-bound automation report', async () => {
    getTaskAutomationInitiatorKeyMock.mockResolvedValue('custom_automation');

    const response = await maybeSendCommunicationThreadReply({
      taskRun: {
        ...discordTaskRun,
        payload: {
          communicationProvider: 'discord',
          communicationChannelId: 'channel-1',
          customAutomationId: 'automation-1',
        },
      },
      parsedBody: { text: 'Weekly documentation audit complete', images: [] },
    });

    expect(response).not.toBeNull();
    expect(discordPostMessageMock).toHaveBeenCalledWith({
      channelId: 'channel-1',
      text: 'Weekly documentation audit complete',
      textFormat: 'markdown',
      images: [],
    });
    expect(discordCreateThreadFromMessageMock).toHaveBeenCalledWith({
      channelId: 'channel-1',
      messageId: 'reply-1',
      name: 'Weekly documentation audit complete',
    });
    expect(dbTransactionMock).toHaveBeenCalledOnce();
    expect(sqlMock.mock.calls.flatMap((call) => call.slice(1))).toContainEqual(
      expect.stringContaining(
        '"communicationThreadId":"automation-thread-1","discordTaskThread":true',
      ),
    );
    expect(upsertBackgroundAutomationSlackThreadMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        surface: 'discord',
        automationKey: 'custom_automation',
        slackChannelId: 'channel-1',
        threadTs: 'reply-1',
        metadata: { sourceTaskId: 'task-3' },
      }),
    );
  });

  it('does not create nested threads for later automation updates', async () => {
    getTaskAutomationInitiatorKeyMock.mockResolvedValue('custom_automation');

    await maybeSendCommunicationThreadReply({
      taskRun: discordTaskRun,
      parsedBody: { text: 'Self-review complete', images: [] },
    });

    expect(discordPostMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-1' }),
    );
    expect(discordCreateThreadFromMessageMock).not.toHaveBeenCalled();
  });

  it('recovers a missing automation thread from its saved root message', async () => {
    getTaskAutomationInitiatorKeyMock.mockResolvedValue('custom_automation');

    await maybeSendCommunicationThreadReply({
      taskRun: {
        ...discordTaskRun,
        payload: {
          communicationProvider: 'discord',
          communicationChannelId: 'channel-1',
          communicationMessageId: 'report-root',
        },
      },
      parsedBody: { text: 'Follow-up result', images: [] },
    });

    expect(discordPostMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: 'report-root' }),
    );
    expect(discordCreateThreadFromMessageMock).toHaveBeenCalledWith({
      channelId: 'channel-1',
      messageId: 'report-root',
      name: 'Follow-up result',
    });
    expect(
      sqlMock.mock.calls.map(([strings, ...values]) => ({
        text: Array.from(strings as string[]).join('?'),
        values,
      })),
    ).toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining("communicationThreadId' IS NULL"),
        values: expect.arrayContaining(['report-root']),
      }),
    );
    expect(sqlMock.mock.calls.flatMap((call) => call.slice(1))).toContainEqual(
      expect.stringContaining(
        '"communicationThreadId":"automation-thread-1","discordTaskThread":true',
      ),
    );
  });

  it('attaches to the investigating opener when only a root message id is present', async () => {
    const response = await maybeSendCommunicationThreadReply({
      taskRun: {
        ...discordTaskRun,
        payload: {
          communicationProvider: 'discord',
          communicationChannelId: 'channel-1',
          communicationMessageId: 'opener-1',
        },
      },
      parsedBody: { text: 'fixed it', images: [] },
    });

    expect(response).not.toBeNull();
    expect(discordPostMessageMock).toHaveBeenCalledWith({
      channelId: 'channel-1',
      replyToMessageId: 'opener-1',
      text: 'fixed it',
      textFormat: 'markdown',
      images: [],
    });
    expect(discordPostMessageMock.mock.calls[0]?.[0]).not.toHaveProperty(
      'threadId',
    );
  });

  it('prepends a pending web-reply quote and clears it by id after a successful Discord post', async () => {
    getLatestUserMessageForReplyQuoteMock.mockResolvedValue({
      id: 'quote-abc',
      text: 'Do it',
      userName: 'Matt Rubens',
    });

    const response = await maybeSendCommunicationThreadReply({
      taskRun: discordTaskRun,
      parsedBody: { text: 'On it — implementing now.', images: [] },
    });

    expect(response).not.toBeNull();
    expect(discordPostMessageMock).toHaveBeenCalledWith({
      channelId: 'channel-1',
      threadId: 'thread-1',
      text: '> **Matt Rubens:** Do it\n\nOn it — implementing now.',
      textFormat: 'markdown',
      images: [],
    });
    expect(clearLatestUserMessageForReplyQuoteIfIdMock).toHaveBeenCalledWith(
      'discord',
      44,
      'quote-abc',
    );
  });

  it('clears a pending web-reply quote after a successful image-only Discord post', async () => {
    getLatestUserMessageForReplyQuoteMock.mockResolvedValue({
      id: 'quote-image',
      text: 'Take a screenshot',
      userName: 'Matt Rubens',
    });
    buildThreadReplyImagesMock.mockResolvedValue([
      { url: 'https://example.com/screenshot.png', altText: 'Screenshot' },
    ]);

    const response = await maybeSendCommunicationThreadReply({
      taskRun: discordTaskRun,
      parsedBody: { images: [{ artifactId: 'artifact-1' }] },
    });

    expect(response).not.toBeNull();
    expect(discordPostMessageMock).toHaveBeenCalledWith({
      channelId: 'channel-1',
      threadId: 'thread-1',
      textFormat: 'markdown',
      images: [
        { url: 'https://example.com/screenshot.png', altText: 'Screenshot' },
      ],
    });
    expect(clearLatestUserMessageForReplyQuoteIfIdMock).toHaveBeenCalledWith(
      'discord',
      44,
      'quote-image',
    );
  });

  it('moves the footer to the latest Discord reply', async () => {
    vi.mocked(buildThreadReplyFooterText).mockReturnValue(
      '[Open task](https://app.example.com/task/task-3)',
    );
    vi.mocked(getThreadReplyFooterRecord).mockResolvedValue({
      messageId: 'previous-reply',
      textWithoutFooter: 'Earlier update',
    });
    discordPostMessageMock.mockResolvedValue({ messageId: 'latest-reply' });

    await maybeSendCommunicationThreadReply({
      taskRun: discordTaskRun,
      parsedBody: { text: 'Latest update', images: [] },
    });

    expect(discordPostMessageMock).toHaveBeenCalledWith({
      channelId: 'channel-1',
      threadId: 'thread-1',
      text: 'Latest update\n\n[Open task](https://app.example.com/task/task-3)',
      textFormat: 'markdown',
      images: [],
    });
    expect(discordEditMessageMock).toHaveBeenCalledWith({
      channelId: 'thread-1',
      messageId: 'previous-reply',
      text: 'Earlier update',
    });
    expect(setThreadReplyFooterRecord).toHaveBeenCalledWith(
      'discord',
      'channel-1',
      'thread-1',
      {
        messageId: 'latest-reply',
        textWithoutFooter: 'Latest update',
      },
    );
  });

  it('tracks the final Discord chunk when a footer-bearing reply is split', async () => {
    vi.mocked(buildThreadReplyFooterText).mockReturnValue('Task footer');
    discordPostMessageMock.mockResolvedValue({
      messageId: 'first-chunk',
      lastTextMessageId: 'footer-chunk',
    });

    await maybeSendCommunicationThreadReply({
      taskRun: discordTaskRun,
      parsedBody: { text: 'a'.repeat(1_990), images: [] },
    });

    expect(setThreadReplyFooterRecord).toHaveBeenCalledWith(
      'discord',
      'channel-1',
      'thread-1',
      {
        messageId: 'footer-chunk',
        textWithoutFooter: '',
      },
    );
  });

  it('adds reactions in the task thread', async () => {
    const response = await maybeAddCommunicationReaction({
      taskRun: discordTaskRun,
      parsedBody: {
        channel: 'channel-1',
        messageTs: 'message-2',
        name: '👀',
      },
    });

    expect(response).not.toBeNull();
    expect(discordAddReactionMock).toHaveBeenCalledWith({
      channelId: 'thread-1',
      messageId: 'message-2',
      name: '👀',
    });
  });
});

describe('maybeSendCommunicationThreadReply (Teams)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildThreadReplyImagesMock.mockResolvedValue([
      {
        url: 'https://app.example.com/api/artifacts/art-1/raw?sig=signed',
        altText: 'screenshot.png',
        contentType: 'image/png',
      },
    ]);
    postMessageMock.mockResolvedValue({ messageId: 'activity-reply' });
    // Tests force no managed-footer path unless they override this.
    vi.mocked(buildThreadReplyFooterText).mockReturnValue(null as never);
    vi.mocked(getThreadReplyFooterRecord).mockResolvedValue(null);
    withThreadReplyFooterLockMock.mockImplementation(
      async ({ fn }: { fn: () => Promise<unknown> }) => fn(),
    );
    vi.mocked(
      createTeamsCommunicationProviderFromRuntimeCredentials,
    ).mockResolvedValue({
      postMessage: postMessageMock,
      updateMessage: vi.fn(),
    } as never);
  });

  it('sends image artifacts as Teams images instead of markdown links', async () => {
    const response = await maybeSendCommunicationThreadReply({
      taskRun: teamsTaskRun,
      parsedBody: { text: 'done', images: [{ artifactId: 'art-1' }] },
    });

    expect(response).not.toBeNull();
    expect(buildThreadReplyImagesMock).toHaveBeenCalledWith({
      artifactIds: ['art-1'],
      taskRun: { id: 43, taskId: 'task-2' },
    });
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '19:conversation@thread.v2',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        text: 'done',
        images: [
          {
            url: 'https://app.example.com/api/artifacts/art-1/raw?sig=signed',
            altText: 'screenshot.png',
            contentType: 'image/png',
          },
        ],
      }),
    );
    expect(postMessageMock.mock.calls[0]?.[0]?.text).not.toContain(
      'Attachments:',
    );
  });

  it('re-sends previous reply images when clearing a managed footer', async () => {
    const updateMessageMock = vi.fn().mockResolvedValue(undefined);
    const footerImages = [
      {
        url: 'https://app.example.com/api/artifacts/art-1/raw?sig=signed',
        altText: 'screenshot.png',
        contentType: 'image/png',
      },
    ];

    withThreadReplyFooterLockMock.mockImplementation(
      async ({ fn }: { fn: () => Promise<unknown> }) => fn(),
    );
    vi.mocked(buildThreadReplyFooterText).mockReturnValue(
      '[View task](https://app.example.com/task/task-2)',
    );
    vi.mocked(getThreadReplyFooterRecord).mockResolvedValue({
      messageId: 'previous-reply',
      textWithoutFooter: 'earlier reply with image',
      images: footerImages,
    });
    vi.mocked(setThreadReplyFooterRecord).mockResolvedValue(undefined);
    postMessageMock.mockResolvedValue({ messageId: 'new-reply' });
    vi.mocked(
      createTeamsCommunicationProviderFromRuntimeCredentials,
    ).mockResolvedValue({
      postMessage: postMessageMock,
      updateMessage: updateMessageMock,
    } as never);

    const response = await maybeSendCommunicationThreadReply({
      taskRun: teamsTaskRun,
      parsedBody: {
        text: 'later update',
        images: [{ artifactId: 'art-1' }],
      },
    });

    expect(response).not.toBeNull();
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('later update'),
        images: footerImages,
      }),
    );
    expect(updateMessageMock).toHaveBeenCalledWith({
      channelId: '19:conversation@thread.v2',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      messageId: 'previous-reply',
      text: 'earlier reply with image',
      textFormat: 'markdown',
      images: footerImages,
    });
    expect(setThreadReplyFooterRecord).toHaveBeenCalledWith(
      'teams',
      '19:conversation@thread.v2',
      'activity-root',
      {
        messageId: 'new-reply',
        textWithoutFooter: 'later update',
        images: footerImages,
      },
    );
  });
});

describe('maybeSendCommunicationThreadReply (Telegram)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveTelegramRuntimeCredentialsMock.mockResolvedValue({ botToken: 't' });
    buildThreadReplyImagesMock.mockResolvedValue([]);
    getLatestInboundMessageIdMock.mockResolvedValue(null);
    postMessageMock.mockResolvedValue({ messageId: '999' });
    sendChatActionMock.mockResolvedValue(undefined);
    // Skip the footer path by returning null footer (resolveSlackThreadLinkedPr mocked)
  });

  it('prefers the latest inbound message id over the launch message id', async () => {
    getLatestInboundMessageIdMock.mockResolvedValue('200');

    const response = await maybeSendCommunicationThreadReply({
      taskRun: telegramTaskRun,
      parsedBody: { text: 'done', images: [] },
    });

    expect(response).not.toBeNull();
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        replyToMessageId: '200',
      }),
    );
  });

  it('falls back to the launch communicationMessageId when no follow-up is recorded', async () => {
    getLatestInboundMessageIdMock.mockResolvedValue(null);

    await maybeSendCommunicationThreadReply({
      taskRun: telegramTaskRun,
      parsedBody: { text: 'done', images: [] },
    });

    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        replyToMessageId: '100',
      }),
    );
  });

  it('falls back to the launch message id when the latest tracker throws', async () => {
    getLatestInboundMessageIdMock.mockRejectedValue(new Error('redis down'));

    await maybeSendCommunicationThreadReply({
      taskRun: telegramTaskRun,
      parsedBody: { text: 'done', images: [] },
    });

    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        replyToMessageId: '100',
      }),
    );
  });

  it('shows a typing action for the chat while delivering the reply', async () => {
    await maybeSendCommunicationThreadReply({
      taskRun: telegramTaskRun,
      parsedBody: { text: 'done', images: [] },
    });

    expect(sendChatActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: '222' }),
    );
  });

  it('does not post the managed live-preview footer in Telegram', async () => {
    await maybeSendCommunicationThreadReply({
      taskRun: telegramTaskRun,
      parsedBody: { text: 'done', images: [] },
    });

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'done' }),
    );
  });

  it('delivers the reply even if the typing action fails', async () => {
    sendChatActionMock.mockRejectedValue(new Error('typing failed'));

    const response = await maybeSendCommunicationThreadReply({
      taskRun: telegramTaskRun,
      parsedBody: { text: 'done', images: [] },
    });

    expect(response).not.toBeNull();
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: '222', text: 'done' }),
    );
  });
});
