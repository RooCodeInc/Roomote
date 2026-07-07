import { describe, expect, it } from 'vitest';

import {
  ROOMOTE_FILE_ATTACHMENT_ACCEPT,
  isRoomoteImageAttachment,
  isRoomoteTextExtractableAttachment,
} from '../file-attachments';

describe('ROOMOTE_FILE_ATTACHMENT_ACCEPT', () => {
  it('includes the browser filters needed for Roomote file uploads', () => {
    const acceptValues = new Set(ROOMOTE_FILE_ATTACHMENT_ACCEPT.split(','));

    expect(acceptValues).toContain('image/png');
    expect(acceptValues).toContain('image/svg+xml');
    expect(acceptValues).toContain('text/*');
    expect(acceptValues).toContain('.pdf');
    expect(acceptValues).toContain('.tsx');
    expect(acceptValues).toContain(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
  });
});

describe('file attachment classification', () => {
  it('keeps raster images as prompt images', () => {
    expect(
      isRoomoteImageAttachment({
        filename: 'screenshot.png',
        mimeType: 'image/png',
      }),
    ).toBe(true);
    expect(
      isRoomoteTextExtractableAttachment({
        filename: 'screenshot.png',
        mimeType: 'image/png',
      }),
    ).toBe(false);
  });

  it('treats svg files as text-extractable attachments instead of prompt images', () => {
    expect(
      isRoomoteImageAttachment({
        filename: 'diagram.svg',
        mimeType: 'image/svg+xml',
      }),
    ).toBe(false);
    expect(
      isRoomoteTextExtractableAttachment({
        filename: 'diagram.svg',
        mimeType: 'image/svg+xml',
      }),
    ).toBe(true);
  });
});
