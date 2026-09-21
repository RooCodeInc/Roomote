import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ROOMOTE_FILE_ATTACHMENT_ACCEPT,
  preparePromptAttachments,
} from './prompt-attachments';

describe('ROOMOTE_FILE_ATTACHMENT_ACCEPT', () => {
  it('allows scientific source files in the browser picker', () => {
    const accepted = new Set(ROOMOTE_FILE_ATTACHMENT_ACCEPT.split(','));

    expect(accepted).toContain('.r');
    expect(accepted).toContain('.ipynb');
  });
});

function makeExtractResponse(texts: string[]): Response {
  return Response.json({ attachmentTexts: texts });
}

function makeAttachmentText(index: number, charCount: number): string {
  return `File attachment: notes-${index}.txt\n----- BEGIN ATTACHMENT -----\n${'a'.repeat(charCount)}\n----- END ATTACHMENT -----`;
}

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

  it('blocks submit before upload when the extracted attachment text exceeds the aggregate limit', async () => {
    const texts = [
      makeAttachmentText(1, 50),
      makeAttachmentText(2, 100),
      makeAttachmentText(3, 199_000),
      makeAttachmentText(4, 1_000),
    ];
    const totalThroughSecond = texts
      .slice(0, 2)
      .reduce((sum, text) => sum + text.length, 0);
    const total = texts.reduce((sum, text) => sum + text.length, 0);
    expect(totalThroughSecond).toBeLessThanOrEqual(200_000);
    expect(total).toBeGreaterThan(200_000);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => makeExtractResponse(texts));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      preparePromptAttachments(
        {
          text: 'Analyze',
          attachments: [
            {
              url: 'data:text/plain;base64,aaa',
              filename: 'notes-1.txt',
              mediaType: 'text/plain',
            },
            {
              url: 'data:text/plain;base64,bbb',
              filename: 'notes-2.txt',
              mediaType: 'text/plain',
            },
            {
              url: 'data:text/plain;base64,ccc',
              filename: 'notes-3.txt',
              mediaType: 'text/plain',
            },
            {
              url: 'data:text/plain;base64,ddd',
              filename: 'notes-4.txt',
              mediaType: 'text/plain',
            },
          ],
        },
        { enforceAttachmentTextLimit: true },
      ),
    ).rejects.toThrow(
      `Extracted text from "notes-4.txt" would exceed the 200,000 character limit for attachments (total ${total.toLocaleString('en-US')} characters). Remove or shorten the attachment and try again.`,
    );
  });

  it('leaves over-limit attachment text untouched for flows without the limit enforcement', async () => {
    const texts = [makeAttachmentText(1, 200_001)];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => makeExtractResponse(texts));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      preparePromptAttachments({
        text: 'Analyze',
        attachments: [
          {
            url: 'data:text/plain;base64,aaa',
            filename: 'notes-1.txt',
            mediaType: 'text/plain',
          },
        ],
      }),
    ).resolves.toEqual({
      text: `Analyze\n\n${texts[0]}`,
      attachmentTexts: texts,
    });
  });

  it('blocks submit when a single attachment alone exceeds the aggregate limit', async () => {
    const text = makeAttachmentText(1, 200_001);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => makeExtractResponse([text]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      preparePromptAttachments(
        {
          text: 'Analyze',
          attachments: [
            {
              url: 'data:text/plain;base64,aaa',
              filename: 'notes-1.txt',
              mediaType: 'text/plain',
            },
          ],
        },
        { enforceAttachmentTextLimit: true },
      ),
    ).rejects.toThrow('Extracted text from "notes-1.txt" would exceed');
  });
});
