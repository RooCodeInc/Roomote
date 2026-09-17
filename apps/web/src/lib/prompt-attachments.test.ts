import { afterEach, describe, expect, it, vi } from 'vitest';

import { preparePromptAttachments } from './prompt-attachments';

describe('preparePromptAttachments', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([403, 404, 500])(
    'rejects an attachment download that returns HTTP %s',
    async (status) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response('permission denied', {
            status,
            headers: { 'content-type': 'text/plain' },
          }),
        )
        .mockResolvedValueOnce(
          Response.json({ attachmentTexts: ['permission denied'] }),
        );
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        preparePromptAttachments({
          text: 'Analyze',
          attachments: [
            {
              url: 'https://attachments.example/report.txt',
              filename: 'report.txt',
              mediaType: 'text/plain',
            },
          ],
        }),
      ).rejects.toThrow(`Failed to download "report.txt" (HTTP ${status}).`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('can retry a failed download without forwarding the error body', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('permission denied', { status: 403 }))
      .mockResolvedValueOnce(
        new Response('quarterly results', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ attachmentTexts: ['Extracted quarterly results'] }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const input = {
      text: 'Analyze',
      attachments: [
        {
          url: 'https://attachments.example/report.txt',
          filename: 'report.txt',
          mediaType: 'text/plain',
        },
      ],
    };

    await expect(preparePromptAttachments(input)).rejects.toThrow(
      'Failed to download "report.txt" (HTTP 403).',
    );
    await expect(preparePromptAttachments(input)).resolves.toEqual({
      text: 'Analyze\n\nExtracted quarterly results',
      attachmentTexts: ['Extracted quarterly results'],
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/file-attachments/extract',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('preserves network download errors', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      preparePromptAttachments({
        text: 'Analyze',
        attachments: [
          {
            url: 'https://attachments.example/report.txt',
            filename: 'report.txt',
            mediaType: 'text/plain',
          },
        ],
      }),
    ).rejects.toThrow('Failed to fetch');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
