import {
  ROOMOTE_FILE_ATTACHMENT_MAX_BYTES,
  ROOMOTE_IMAGE_ATTACHMENT_MAX_BYTES,
} from '@roomote/cloud-agents';

import { tasksRouter } from '../index';
import {
  prepareMessageAttachments,
  ROOMOTE_MESSAGE_REQUEST_MAX_BYTES,
} from '../messageAttachments';

describe('prepareMessageAttachments', () => {
  it('preserves message-only calls unchanged', async () => {
    await expect(
      prepareMessageAttachments({ message: 'Continue investigating' }),
    ).resolves.toEqual({ message: 'Continue investigating' });
  });

  it('routes screenshots to images and extracts logs and diffs into prompt text', async () => {
    const result = await prepareMessageAttachments({
      message: 'Review the attachments',
      attachments: [
        {
          filename: 'screenshot.png',
          mimeType: 'image/png',
          base64: Buffer.from('png-bytes').toString('base64'),
        },
        {
          filename: 'failure.log',
          mimeType: 'text/plain',
          base64: Buffer.from('request failed').toString('base64'),
        },
        {
          filename: 'change.diff',
          mimeType: 'text/plain',
          base64: Buffer.from('- old\n+ new').toString('base64'),
        },
      ],
    });

    expect(result.images).toEqual([
      `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`,
    ]);
    expect(result.message).toContain('File attachment: failure.log');
    expect(result.message).toContain('request failed');
    expect(result.message).toContain('File attachment: change.diff');
    expect(result.message).toContain('- old\n+ new');
    expect(result.attachmentTexts).toHaveLength(2);
  });

  it.each([4, 8])(
    'accepts a valid %i MiB text attachment without overflowing validation',
    async (sizeInMebibytes) => {
      const result = await prepareMessageAttachments({
        message: 'Inspect the log',
        attachments: [
          {
            filename: 'failure.log',
            mimeType: 'text/plain',
            base64: Buffer.alloc(sizeInMebibytes * 1024 * 1024, 97).toString(
              'base64',
            ),
          },
        ],
      });

      expect(result.message).toContain('File attachment: failure.log');
      expect(result.message).toContain('[truncated]');
    },
  );

  it('rejects text attachments over 8 MiB before decoding', async () => {
    const overLimitByteLength = ROOMOTE_FILE_ATTACHMENT_MAX_BYTES + 1;
    const base64Length = Math.ceil(overLimitByteLength / 3) * 4;
    const paddingLength = (3 - (overLimitByteLength % 3)) % 3;
    const base64 = `${'A'.repeat(base64Length - paddingLength)}${'='.repeat(paddingLength)}`;

    await expect(
      prepareMessageAttachments({
        message: 'Inspect the log',
        attachments: [
          { filename: 'failure.log', mimeType: 'text/plain', base64 },
        ],
      }),
    ).rejects.toThrow('file exceeds the 8 MiB attachment limit');
  });

  it('rejects more than 20 attachments', async () => {
    await expect(
      prepareMessageAttachments({
        message: 'Inspect the logs',
        attachments: Array.from({ length: 21 }, (_, index) => ({
          filename: `failure-${index}.log`,
          mimeType: 'text/plain',
          base64: Buffer.from('failure').toString('base64'),
        })),
      }),
    ).rejects.toThrow('maximum 20 attachments');
  });

  it('rejects oversized message request bodies before route handling', async () => {
    const response = await tasksRouter.request('/task-id/send_message', {
      method: 'POST',
      headers: {
        'content-length': String(ROOMOTE_MESSAGE_REQUEST_MAX_BYTES + 1),
        'content-type': 'application/json',
      },
      body: '{}',
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: 'Message payload is too large',
    });
  });

  it('rejects attachments over a 16 MiB aggregate decoded-byte budget', async () => {
    const sixMebibytes = Buffer.alloc(6 * 1024 * 1024, 97).toString('base64');

    await expect(
      prepareMessageAttachments({
        message: 'Inspect the logs',
        attachments: Array.from({ length: 3 }, (_, index) => ({
          filename: `failure-${index}.log`,
          mimeType: 'text/plain',
          base64: sixMebibytes,
        })),
      }),
    ).rejects.toThrow('attachments exceed the 16 MiB total limit');
  });

  it('rejects invalid base64', async () => {
    await expect(
      prepareMessageAttachments({
        message: 'Inspect the log',
        attachments: [
          {
            filename: 'failure.log',
            mimeType: 'text/plain',
            base64: 'not base64!',
          },
        ],
      }),
    ).rejects.toThrow('base64 is invalid');
  });

  it('accepts images at 2 MiB and rejects larger images', async () => {
    const boundaryImage = Buffer.alloc(
      ROOMOTE_IMAGE_ATTACHMENT_MAX_BYTES,
      1,
    ).toString('base64');
    const result = await prepareMessageAttachments({
      message: 'Inspect the screenshot',
      attachments: [
        {
          filename: 'screenshot.png',
          mimeType: 'image/png',
          base64: boundaryImage,
        },
      ],
    });
    expect(result.images).toEqual([`data:image/png;base64,${boundaryImage}`]);

    const overLimitImage = Buffer.alloc(
      ROOMOTE_IMAGE_ATTACHMENT_MAX_BYTES + 1,
      1,
    ).toString('base64');
    await expect(
      prepareMessageAttachments({
        message: 'Inspect the screenshot',
        attachments: [
          {
            filename: 'screenshot.png',
            mimeType: 'image/png',
            base64: overLimitImage,
          },
        ],
      }),
    ).rejects.toThrow('file exceeds the 2 MiB attachment limit');
  });

  it('normalizes padded image MIME types before downstream delivery', async () => {
    const base64 = Buffer.from('png-bytes').toString('base64');
    const result = await prepareMessageAttachments({
      message: 'Inspect the screenshot',
      attachments: [
        {
          filename: 'screenshot.png',
          mimeType: ' IMAGE/PNG ',
          base64,
        },
      ],
    });

    expect(result.images).toEqual([`data:image/png;base64,${base64}`]);
  });

  it('rejects image filenames without a supported image MIME type', async () => {
    await expect(
      prepareMessageAttachments({
        message: 'Inspect the screenshot',
        attachments: [
          {
            filename: 'screenshot.png',
            mimeType: 'application/octet-stream',
            base64: Buffer.from('not-an-image').toString('base64'),
          },
        ],
      }),
    ).rejects.toThrow('unsupported attachment type');
  });

  it('keeps bounded extracted text when later attachments exceed the shared budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await prepareMessageAttachments({
      message: 'Inspect the logs',
      attachments: [
        {
          filename: 'first.log',
          mimeType: 'text/plain',
          base64: Buffer.from('a'.repeat(200_001)).toString('base64'),
        },
        {
          filename: 'second.log',
          mimeType: 'text/plain',
          base64: Buffer.from('second log').toString('base64'),
        },
      ],
    });

    expect(result.message).toContain('File attachment: first.log');
    expect(result.message).toContain('File attachment: second.log');
    expect(result.message).toContain('[omitted: attachment budget exhausted]');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('shared attachment text budget was exhausted'),
    );
  });

  it('rejects corrupt supported documents instead of silently dropping them', async () => {
    await expect(
      prepareMessageAttachments({
        message: 'Inspect the document',
        attachments: [
          {
            filename: 'corrupt.docx',
            mimeType:
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            base64: Buffer.from('not a valid DOCX archive').toString('base64'),
          },
        ],
      }),
    ).rejects.toThrow(/^corrupt\.docx: /u);
  });
});
