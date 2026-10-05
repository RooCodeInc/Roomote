import { prepareMessageAttachments } from '../messageAttachments';

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
});
