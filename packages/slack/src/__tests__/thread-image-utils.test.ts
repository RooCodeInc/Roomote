import {
  collectAndProcessThreadImages,
  resolveCurrentSlackMessageFiles,
  collectThreadImageFiles,
  fetchThreadMessagesSafe,
  MAX_THREAD_IMAGE_FILES,
} from '../thread-image-utils';

describe('collectThreadImageFiles', () => {
  it('collects unique image files in thread order and filters non-images', () => {
    const result = collectThreadImageFiles([
      {
        user: 'U123',
        text: 'first',
        ts: '100.000',
        type: 'message',
        files: [
          {
            id: 'F-image-1',
            name: 'first.png',
            mimetype: 'image/png',
            filetype: 'png',
            url_private: 'https://files.slack.com/F-image-1',
            url_private_download: 'https://files.slack.com/F-image-1/download',
            size: 1024,
          },
          {
            id: 'F-pdf',
            name: 'spec.pdf',
            mimetype: 'application/pdf',
            filetype: 'pdf',
            url_private: 'https://files.slack.com/F-pdf',
            url_private_download: 'https://files.slack.com/F-pdf/download',
            size: 1024,
          },
        ],
      },
      {
        user: 'U456',
        text: 'second',
        ts: '101.000',
        type: 'message',
        files: [
          {
            id: 'F-image-1',
            name: 'duplicate.png',
            mimetype: 'image/png',
            filetype: 'png',
            url_private: 'https://files.slack.com/F-image-1',
            url_private_download: 'https://files.slack.com/F-image-1/download',
            size: 1024,
          },
          {
            id: 'F-image-2',
            name: 'second.jpg',
            mimetype: 'image/jpeg',
            filetype: 'jpg',
            url_private: 'https://files.slack.com/F-image-2',
            url_private_download: 'https://files.slack.com/F-image-2/download',
            size: 2048,
          },
        ],
      },
    ]);

    expect(result).toEqual({
      files: [
        expect.objectContaining({ id: 'F-image-1' }),
        expect.objectContaining({ id: 'F-image-2' }),
      ],
      skippedCount: 0,
    });
  });

  it('excludes provided file ids and keeps the most recent images when capped', () => {
    const result = collectThreadImageFiles(
      Array.from({ length: MAX_THREAD_IMAGE_FILES + 2 }, (_, index) => ({
        user: `U${index}`,
        text: `message ${index}`,
        ts: `${100 + index}.000`,
        type: 'message',
        files: [
          {
            id: `F-${index}`,
            name: `image-${index}.png`,
            mimetype: 'image/png',
            filetype: 'png',
            url_private: `https://files.slack.com/F-${index}`,
            url_private_download: `https://files.slack.com/F-${index}/download`,
            size: 1024,
          },
        ],
      })),
      {
        excludeFileIds: new Set(['F-0']),
        maxFiles: MAX_THREAD_IMAGE_FILES,
      },
    );

    expect(result.skippedCount).toBe(1);
    expect(result.files).toHaveLength(MAX_THREAD_IMAGE_FILES);
    expect(result.files[0]).toEqual(expect.objectContaining({ id: 'F-2' }));
    expect(result.files.at(-1)).toEqual(
      expect.objectContaining({ id: 'F-21' }),
    );
  });
});

describe('collectAndProcessThreadImages', () => {
  it('processes collected images after filtering and dedupe', async () => {
    const processSlackFiles = vi
      .fn()
      .mockResolvedValue(['thread-image-1', 'thread-image-2']);

    const result = await collectAndProcessThreadImages({
      processSlackFiles,
      messages: [
        {
          user: 'U123',
          text: 'first',
          ts: '100.000',
          type: 'message',
          files: [
            {
              id: 'F-image-1',
              name: 'first.png',
              mimetype: 'image/png',
              filetype: 'png',
              url_private: 'https://files.slack.com/F-image-1',
              url_private_download:
                'https://files.slack.com/F-image-1/download',
              size: 1024,
            },
          ],
        },
        {
          user: 'U456',
          text: 'second',
          ts: '101.000',
          type: 'message',
          files: [
            {
              id: 'F-image-1',
              name: 'duplicate.png',
              mimetype: 'image/png',
              filetype: 'png',
              url_private: 'https://files.slack.com/F-image-1',
              url_private_download:
                'https://files.slack.com/F-image-1/download',
              size: 1024,
            },
            {
              id: 'F-image-2',
              name: 'second.png',
              mimetype: 'image/png',
              filetype: 'png',
              url_private: 'https://files.slack.com/F-image-2',
              url_private_download:
                'https://files.slack.com/F-image-2/download',
              size: 2048,
            },
          ],
        },
      ],
      excludeFileIds: new Set(['F-image-3']),
      logContext: 'test thread',
    });

    expect(processSlackFiles).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'F-image-1' }),
      expect.objectContaining({ id: 'F-image-2' }),
    ]);
    expect(result).toEqual(['thread-image-1', 'thread-image-2']);
  });

  it('returns an empty array and logs when file processing fails', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    const result = await collectAndProcessThreadImages({
      processSlackFiles: vi.fn().mockRejectedValue(new Error('boom')),
      messages: [
        {
          user: 'U123',
          text: 'first',
          ts: '100.000',
          type: 'message',
          files: [
            {
              id: 'F-image-1',
              name: 'first.png',
              mimetype: 'image/png',
              filetype: 'png',
              url_private: 'https://files.slack.com/F-image-1',
              url_private_download:
                'https://files.slack.com/F-image-1/download',
              size: 1024,
            },
          ],
        },
      ],
      logContext: 'test thread',
    });

    expect(result).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[thread-image-utils] Failed to process thread image files for test thread: boom',
    );
  });
});

describe('resolveCurrentSlackMessageFiles', () => {
  it('prefers files provided on the current event', () => {
    const eventFiles = [
      {
        id: 'F-event',
        name: 'event.txt',
        mimetype: 'text/plain',
        filetype: 'text',
        url_private: 'https://files.slack.com/F-event',
        url_private_download: 'https://files.slack.com/F-event/download',
        size: 512,
      },
    ];

    const result = resolveCurrentSlackMessageFiles({
      currentMessageTs: '101.000',
      eventFiles,
      messages: [
        {
          user: 'U123',
          text: 'current',
          ts: '101.000',
          type: 'message',
          files: [
            {
              id: 'F-thread',
              name: 'thread.txt',
              mimetype: 'text/plain',
              filetype: 'text',
              url_private: 'https://files.slack.com/F-thread',
              url_private_download: 'https://files.slack.com/F-thread/download',
              size: 512,
            },
          ],
        },
      ],
    });

    expect(result).toEqual(eventFiles);
  });

  it('falls back to the fetched current thread message files when event files are missing', () => {
    const result = resolveCurrentSlackMessageFiles({
      currentMessageTs: '101.000',
      messages: [
        {
          user: 'U123',
          text: 'earlier',
          ts: '100.000',
          type: 'message',
        },
        {
          user: 'U123',
          text: 'current',
          ts: '101.000',
          type: 'message',
          files: [
            {
              id: 'F-thread',
              name: 'thread.txt',
              mimetype: 'text/plain',
              filetype: 'text',
              url_private: 'https://files.slack.com/F-thread',
              url_private_download: 'https://files.slack.com/F-thread/download',
              size: 512,
            },
          ],
        },
      ],
    });

    expect(result).toEqual([expect.objectContaining({ id: 'F-thread' })]);
  });
});

describe('fetchThreadMessagesSafe', () => {
  it('returns fetched thread messages unchanged on success', async () => {
    const threadMessages = [
      {
        user: 'U123',
        text: 'hello',
        ts: '100.000',
        type: 'message' as const,
      },
    ];

    const result = await fetchThreadMessagesSafe({
      fetchThreadMessages: vi.fn().mockResolvedValue(threadMessages),
      channel: 'C123',
      threadTs: '100.000',
      logContext: 'active job 1 in C123:100.000',
    });

    expect(result).toEqual(threadMessages);
  });

  it('returns an empty array and logs a warning on fetch failure', async () => {
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {});

    const result = await fetchThreadMessagesSafe({
      fetchThreadMessages: vi.fn().mockRejectedValue(new Error('fetch failed')),
      channel: 'C123',
      threadTs: '100.000',
      logContext: 'active job 1 in C123:100.000',
    });

    expect(result).toEqual([]);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[thread-image-utils] Failed to fetch thread messages for active job 1 in C123:100.000: fetch failed',
    );
  });
});
