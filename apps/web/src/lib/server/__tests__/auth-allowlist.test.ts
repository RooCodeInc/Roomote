import {
  isRoomoteEmailAllowed,
  parseRoomoteAllowedEmails,
} from '../auth-allowlist';

describe('Roomote auth allowlist', () => {
  it('parses comma and whitespace separated emails case-insensitively', () => {
    expect(
      parseRoomoteAllowedEmails(
        ' Alice@example.com,BOB@example.com\ncarol@example.com ',
      ),
    ).toEqual(
      new Set(['alice@example.com', 'bob@example.com', 'carol@example.com']),
    );
  });

  it('allows every email when no allowlist is configured', () => {
    expect(isRoomoteEmailAllowed('anyone@example.com', undefined)).toBe(true);
    expect(isRoomoteEmailAllowed(null, '')).toBe(true);
  });

  it('allows exact normalized matches when an allowlist is configured', () => {
    expect(
      isRoomoteEmailAllowed(
        ' Alice@example.com ',
        'alice@example.com,bob@example.com',
      ),
    ).toBe(true);
  });

  it('rejects missing or unlisted emails when an allowlist is configured', () => {
    expect(isRoomoteEmailAllowed(null, 'alice@example.com')).toBe(false);
    expect(
      isRoomoteEmailAllowed('carol@example.com', 'alice@example.com'),
    ).toBe(false);
  });
});
