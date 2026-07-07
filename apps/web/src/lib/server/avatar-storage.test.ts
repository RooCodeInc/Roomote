import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/server/s3-client', () => ({
  getS3Client: () => ({ send: vi.fn() }),
}));

vi.mock('@/lib/server/env', () => ({
  Env: { S3_BUCKET_ARTIFACTS: 'roomote-artifacts' },
}));

import {
  isAllowedAvatarContentType,
  isAllowedAvatarSize,
  isValidAvatarFilename,
  isValidAvatarUserId,
  buildAvatarFilename,
  buildAvatarUrl,
  parseAvatarFilenameFromUrl,
} from '@/lib/server/avatar-storage';

describe('avatar-storage', () => {
  describe('isAllowedAvatarContentType', () => {
    it('accepts supported image content types', () => {
      expect(isAllowedAvatarContentType('image/png')).toBe(true);
      expect(isAllowedAvatarContentType('image/jpeg')).toBe(true);
      expect(isAllowedAvatarContentType('image/webp')).toBe(true);
      expect(isAllowedAvatarContentType('image/gif')).toBe(true);
    });

    it('rejects non-image and unsupported image types', () => {
      expect(isAllowedAvatarContentType('image/svg+xml')).toBe(false);
      expect(isAllowedAvatarContentType('application/octet-stream')).toBe(
        false,
      );
      expect(isAllowedAvatarContentType('')).toBe(false);
    });
  });

  describe('isAllowedAvatarSize', () => {
    it('accepts sizes up to 2 MB', () => {
      expect(isAllowedAvatarSize(1)).toBe(true);
      expect(isAllowedAvatarSize(2 * 1024 * 1024)).toBe(true);
    });

    it('rejects empty and over-limit sizes', () => {
      expect(isAllowedAvatarSize(0)).toBe(false);
      expect(isAllowedAvatarSize(2 * 1024 * 1024 + 1)).toBe(false);
    });
  });

  describe('isValidAvatarFilename', () => {
    it('accepts canonical avatar filenames', () => {
      expect(isValidAvatarFilename('avatar-1783449999999.png')).toBe(true);
      expect(isValidAvatarFilename('avatar-1.webp')).toBe(true);
      expect(isValidAvatarFilename('avatar-999999.jpg')).toBe(true);
      expect(isValidAvatarFilename('avatar-7.gif')).toBe(true);
    });

    it('rejects traversal attempts and non-image extensions', () => {
      expect(isValidAvatarFilename('../avatar-1.png')).toBe(false);
      expect(isValidAvatarFilename('avatar-1.svg')).toBe(false);
      expect(isValidAvatarFilename('avatar-1.png.exe')).toBe(false);
      expect(isValidAvatarFilename('avatar.png')).toBe(false);
      expect(isValidAvatarFilename('')).toBe(false);
    });
  });

  describe('isValidAvatarUserId', () => {
    it('accepts normal user ids', () => {
      expect(isValidAvatarUserId('user-1')).toBe(true);
      expect(isValidAvatarUserId('abc123def456')).toBe(true);
    });

    it('rejects path separators and traversal sequences', () => {
      expect(isValidAvatarUserId('user/1')).toBe(false);
      expect(isValidAvatarUserId('user\\1')).toBe(false);
      expect(isValidAvatarUserId('..')).toBe(false);
      expect(isValidAvatarUserId('../other-user')).toBe(false);
      expect(isValidAvatarUserId('user/../other')).toBe(false);
    });

    it('rejects empty and oversized values', () => {
      expect(isValidAvatarUserId('')).toBe(false);
      expect(isValidAvatarUserId('a'.repeat(129))).toBe(false);
    });
  });

  describe('buildAvatarFilename', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-07T18:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('builds a versioned filename with the content-type extension', () => {
      const png = buildAvatarFilename('image/png');
      const jpg = buildAvatarFilename('image/jpeg');
      const webp = buildAvatarFilename('image/webp');

      expect(png).toMatch(/^avatar-\d+\.png$/);
      expect(jpg).toMatch(/^avatar-\d+\.jpg$/);
      expect(webp).toMatch(/^avatar-\d+\.webp$/);
      expect(png).toBe(jpg.replace(/\.jpg$/, '.png'));
      expect(webp).toBe(jpg.replace(/\.jpg$/, '.webp'));
    });

    it('throws for unsupported content types', () => {
      expect(() => buildAvatarFilename('image/svg+xml')).toThrow();
      expect(() => buildAvatarFilename('application/pdf')).toThrow();
    });
  });

  describe('buildAvatarUrl', () => {
    it('builds a relative URL keyed by userId and filename', () => {
      expect(buildAvatarUrl('user-1', 'avatar-1.png')).toBe(
        '/api/avatars/user-1/avatar-1.png',
      );
    });

    it('encodes a userId that contains reserved characters', () => {
      expect(buildAvatarUrl('user/1', 'avatar-1.png')).toBe(
        '/api/avatars/user%2F1/avatar-1.png',
      );
    });
  });

  describe('parseAvatarFilenameFromUrl', () => {
    const userId = 'user-1';

    it('extracts the filename from a stored avatar URL', () => {
      expect(
        parseAvatarFilenameFromUrl('/api/avatars/user-1/avatar-1.png', userId),
      ).toBe('avatar-1.png');
    });

    it('strips a cache-busting query string', () => {
      expect(
        parseAvatarFilenameFromUrl(
          '/api/avatars/user-1/avatar-1.png?v=2',
          userId,
        ),
      ).toBe('avatar-1.png');
    });

    it('returns null for URLs that do not belong to the user', () => {
      expect(
        parseAvatarFilenameFromUrl(
          '/api/avatars/other-user/avatar-1.png',
          userId,
        ),
      ).toBe(null);
    });

    it('returns null for malformed filenames', () => {
      expect(
        parseAvatarFilenameFromUrl(
          '/api/avatars/user-1/not-an-avatar.png',
          userId,
        ),
      ).toBe(null);
      expect(parseAvatarFilenameFromUrl('', userId)).toBe(null);
    });
  });
});
