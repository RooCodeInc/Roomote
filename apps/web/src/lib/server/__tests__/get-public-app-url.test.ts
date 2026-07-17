import { describe, expect, it } from 'vitest';

import { getPublicAppUrl } from '../get-public-app-url';

describe('getPublicAppUrl', () => {
  it('prefers R_PUBLIC_URL when set', () => {
    expect(
      getPublicAppUrl({
        R_APP_URL: 'http://localhost:13000',
        R_PUBLIC_URL: 'https://customer.roomote.ai',
      }),
    ).toBe('https://customer.roomote.ai');
  });

  it('falls back to R_APP_URL when R_PUBLIC_URL is unset', () => {
    expect(
      getPublicAppUrl({
        R_APP_URL: 'http://localhost:3000',
        R_PUBLIC_URL: undefined,
      }),
    ).toBe('http://localhost:3000');
  });
});
