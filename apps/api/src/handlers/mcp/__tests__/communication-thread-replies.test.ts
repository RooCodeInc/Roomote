import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  buildThreadReplyImageBlocksMock,
  envMock,
  getLatestInboundMessageIdMock,
  postMessageMock,
  resolveTelegramRuntimeCredentialsMock,
  withThreadReplyFooterLockMock,
} = vi.hoisted(() => ({
  buildThreadReplyImageBlocksMock: vi.fn(),
  envMock: { ROOMOTE_APP_URL: 'https://app.example.com' },
  getLatestInboundMessageIdMock: vi.fn(),
  postMessageMock: vi.fn(),
  resolveTelegramRuntimeCredentialsMock: vi.fn(),
  withThreadReplyFooterLockMock: vi.fn(),
}));

vi.mock('@roomote/env', () => ({ Env: envMock }));

vi.mock('@roomote/db/server', () => ({
  resolveTelegramRuntimeCredentials: resolveTelegramRuntimeCredentialsMock,
}));

vi.mock('@roomote/communication', () => ({
  TelegramCommunicationProvider: vi.fn().mockImplementation(function () {
    return { postMessage: postMessageMock };
  }),
  TeamsCommunicationProvider: vi.fn(),
  UnsupportedCommunicationOperationError: class UnsupportedCommunicationOperationError extends Error {},
  getLatestInboundMessageId: getLatestInboundMessageIdMock,
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
}));

vi.mock('@roomote/slack', () => ({
  resolveSlackThreadLinkedPr: vi.fn(),
  resolveSlackThreadLivePreviewUrl: vi.fn(),
}));

vi.mock('../chat-reply-helpers.js', () => ({
  buildThreadReplyImageBlocks: buildThreadReplyImageBlocksMock,
  errorResponseForThreadReplyImageError: vi.fn(),
  THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE: 'busy',
  withThreadReplyFooterLock: withThreadReplyFooterLockMock,
}));

import { maybeSendCommunicationThreadReply } from '../communication-thread-replies';

const telegramCloudJob = {
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

describe('maybeSendCommunicationThreadReply (Telegram)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveTelegramRuntimeCredentialsMock.mockResolvedValue({ botToken: 't' });
    buildThreadReplyImageBlocksMock.mockResolvedValue([]);
    getLatestInboundMessageIdMock.mockResolvedValue(null);
    postMessageMock.mockResolvedValue({ messageId: '999' });
    // Skip the footer path by returning null footer (resolveSlackThreadLinkedPr mocked)
  });

  it('prefers the latest inbound message id over the launch message id', async () => {
    getLatestInboundMessageIdMock.mockResolvedValue('200');

    const response = await maybeSendCommunicationThreadReply({
      cloudJob: telegramCloudJob,
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
      cloudJob: telegramCloudJob,
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
      cloudJob: telegramCloudJob,
      parsedBody: { text: 'done', images: [] },
    });

    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '222',
        replyToMessageId: '100',
      }),
    );
  });
});
