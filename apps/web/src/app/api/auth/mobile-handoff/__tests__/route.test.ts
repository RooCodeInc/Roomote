import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  store: vi.fn(async () => 'code-123456789012345678901234'),
}));
vi.mock('@/lib/server', () => ({ authorize: mocks.authorize }));
vi.mock('@/lib/server/env', () => ({
  Env: { R_APP_URL: 'https://app.roomote.test' },
}));
vi.mock('@/lib/server/mobile-handoff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/mobile-handoff')>()),
  storeMobileHandoffToken: mocks.store,
}));

import { GET } from '../route';

function request(url: string, cookie?: string) {
  return new NextRequest(url, {
    headers: cookie ? { cookie } : {},
  });
}

describe('GET /api/auth/mobile-handoff', () => {
  it('rejects redirects outside the app scheme', async () => {
    const response = await GET(
      request(
        'https://roomote.test/api/auth/mobile-handoff?redirect=https://x',
      ),
    );
    expect(response.status).toBe(400);
  });

  it('bounces signed-out browsers through sign-in and back', async () => {
    mocks.authorize.mockResolvedValueOnce({ success: false, error: 'nope' });
    const response = await GET(
      request(
        'https://roomote.test/api/auth/mobile-handoff?redirect=roomote%3A%2F%2Fauth',
      ),
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin).toBe('https://app.roomote.test');
    expect(location.pathname).toBe('/sign-in');
    expect(location.searchParams.get('redirect_url')).toBe(
      '/api/auth/mobile-handoff?redirect=roomote%3A%2F%2Fauth',
    );
  });

  it('hands the signed session cookie to the app as a one-time code', async () => {
    mocks.authorize.mockResolvedValueOnce({ success: true, userId: 'u1' });
    const response = await GET(
      request(
        'https://roomote.test/api/auth/mobile-handoff?redirect=roomote%3A%2F%2Fauth',
        'better-auth.session_token=tok.sig; other=1',
      ),
    );
    expect(response.status).toBe(302);
    expect(mocks.store).toHaveBeenCalledWith('tok.sig');
    expect(response.headers.get('location')).toBe(
      'roomote://auth?code=code-123456789012345678901234',
    );
  });

  it('refuses when signed in without a session cookie', async () => {
    mocks.authorize.mockResolvedValueOnce({ success: true, userId: 'u1' });
    const response = await GET(
      request(
        'https://roomote.test/api/auth/mobile-handoff?redirect=roomote%3A%2F%2Fauth',
      ),
    );
    expect(response.status).toBe(401);
  });
});
