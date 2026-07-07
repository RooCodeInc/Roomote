import { getIdentityDisplayName } from '../identity-display-name';

describe('getIdentityDisplayName', () => {
  it('prefers full name when first and last names exist', () => {
    expect(
      getIdentityDisplayName({
        firstName: 'Ada',
        lastName: 'Lovelace',
        emailAddress: 'ada@example.com',
      }),
    ).toBe('Ada Lovelace');
  });

  it('falls back to username', () => {
    expect(
      getIdentityDisplayName({
        username: 'ada',
        emailAddress: 'ada@example.com',
      }),
    ).toBe('ada');
  });

  it('falls back to email local part', () => {
    expect(
      getIdentityDisplayName({
        emailAddress: 'ada@example.com',
      }),
    ).toBe('ada');
  });

  it('uses Unknown when no identity fields are present', () => {
    expect(getIdentityDisplayName({})).toBe('Unknown');
  });
});
