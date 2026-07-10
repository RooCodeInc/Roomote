vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: {
      TRPC_URL: 'https://api.example.com/',
      R_APP_URL: 'https://app.example.com/',
    },
  };
});

import { normalizeApiBaseUrl, resolveApiBaseUrl } from '../shared-utils';

describe('shared server utils', () => {
  it('normalizes API base URLs', () => {
    expect(normalizeApiBaseUrl(undefined)).toBeNull();
    expect(normalizeApiBaseUrl('   ')).toBeNull();
    expect(normalizeApiBaseUrl('https://api.example.com///')).toBe(
      'https://api.example.com',
    );
  });

  it('resolves API base URLs from explicit input before env fallbacks', () => {
    expect(resolveApiBaseUrl(' https://custom.example.com/ ')).toBe(
      'https://custom.example.com',
    );
    expect(resolveApiBaseUrl()).toBe('https://api.example.com');
  });
});
