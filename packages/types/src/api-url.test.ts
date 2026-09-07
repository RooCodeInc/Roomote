import { resolveApiUrl } from './api-url';

describe('resolveApiUrl', () => {
  it('appends the path to a bare origin', () => {
    expect(resolveApiUrl('http://api:3001', '/api/webhooks/github')).toBe(
      'http://api:3001/api/webhooks/github',
    );
  });

  it('preserves a path prefix that carries no trailing slash', () => {
    expect(
      resolveApiUrl('https://roomote.example.com/_roomote-api', '/api/status'),
    ).toBe('https://roomote.example.com/_roomote-api/api/status');
  });

  it('collapses trailing slashes on the base URL', () => {
    expect(
      resolveApiUrl(
        'https://roomote.example.com/_roomote-api///',
        '/api/status',
      ),
    ).toBe('https://roomote.example.com/_roomote-api/api/status');
  });

  it('accepts a path without a leading slash', () => {
    expect(
      resolveApiUrl('https://roomote.example.com/_roomote-api', 'api/status'),
    ).toBe('https://roomote.example.com/_roomote-api/api/status');
  });

  it('keeps an explicit port', () => {
    expect(resolveApiUrl('https://roomote.fly.dev:8443', '/api/status')).toBe(
      'https://roomote.fly.dev:8443/api/status',
    );
  });
});
