import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTeamsCommunicationProviderFromRuntimeCredentials } from '@roomote/sdk/server';

const {
  buildThreadReplyImagesMock,
  envMock,
  getLatestInboundMessageIdMock,
  postMessageMock,
  resolveTelegramRuntimeCredentialsMock,
  withThreadReplyFooterLockMock,
} = vi.hoisted(() => ({
  buildThreadReplyImagesMock: vi.fn(),
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
  buildThreadReplyFooterText: vi.fn().mockReturnValue(null),
  formatMarkdownLink: vi.fn(),
  getThreadReplyFooterRecord: vi.fn(),
  TelegramCommunicationProvider: vi.fn().mockImplementation(function () {
    return { postMessage: postMessageMock };
  }),
  TeamsCommunicationProvider: vi.fn(),
  UnsupportedCommunicationOperationError: class UnsupportedCommunicationOperationError extends Error {},
  getLatestInboundMessageId: getLatestInboundMessageIdMock,
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

const teamsCloudJob = {
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
      cloudJob: teamsCloudJob,
      parsedBody: { text: 'done', images: [{ artifactId: 'art-1' }] },
    });

    expect(response).not.toBeNull();
    expect(buildThreadReplyImagesMock).toHaveBeenCalledWith({
      artifactIds: ['art-1'],
      cloudJob: { id: 43, taskId: 'task-2' },
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
      cloudJob: teamsCloudJob,
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
