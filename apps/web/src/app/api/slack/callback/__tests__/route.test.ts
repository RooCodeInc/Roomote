import { NextRequest } from 'next/server';

import { createServerCaller } from '@/trpc/server';
import { encodeRecord } from '@/lib/url-coder';
import { createSignedSlackInstallState } from '@/lib/server/slack-oauth-state';

import { GET } from '../route';

vi.mock('@/trpc/server', () => ({
  createServerCaller: vi.fn(),
}));

vi.mock('@roomote/db/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/db/server')>();

  return {
    ...actual,
    resolveSlackSigningSecret: vi.fn(async () => 'test-signing-secret'),
  };
});

const mockCreateServerCaller = vi.mocked(createServerCaller);
const mockExchangeOAuthCode = vi.fn();
const mockFinishAuthenticateAccount = vi.fn();

describe('GET /api/slack/callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateServerCaller.mockResolvedValue({
      slack: {
        exchangeOAuthCode: mockExchangeOAuthCode,
        finishAuthenticateAccount: mockFinishAuthenticateAccount,
      },
    } as never);
    mockExchangeOAuthCode.mockResolvedValue({ success: true });
    mockFinishAuthenticateAccount.mockResolvedValue({ success: true });
  });

  it('redirects org installs back to the signed redirect path', async () => {
    const state = await createSignedSlackInstallState({
      redirectPath: '/settings/integrations',
    });

    const response = await GET(
      new NextRequest(
        `http://localhost:13000/api/slack/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://localhost:13000/settings/integrations?slack=connected',
    );
    expect(mockExchangeOAuthCode).toHaveBeenCalledWith({
      code: 'oauth-code',
      state,
    });
    expect(mockFinishAuthenticateAccount).not.toHaveBeenCalled();
  });

  it('rewrites internal container listen hosts to the public app URL', async () => {
    const state = await createSignedSlackInstallState({
      redirectPath: '/setup?step=slack',
    });

    // In containerized deployments the Next.js standalone server binds to
    // 0.0.0.0 and echoes it back in request.url; the redirect must land on
    // the configured public URL instead.
    const response = await GET(
      new NextRequest(
        `http://0.0.0.0:3000/api/slack/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://localhost:13000/setup?step=slack&slack=connected',
    );
  });

  it('keeps link-account redirects on the safe encoded path', async () => {
    const state = encodeRecord({
      mode: 'link_account',
      redirect: '/settings/profile',
    });

    const response = await GET(
      new NextRequest(
        `http://localhost:13000/api/slack/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://localhost:13000/settings/profile?slack=connected',
    );
    expect(mockFinishAuthenticateAccount).toHaveBeenCalledWith({
      code: 'oauth-code',
    });
    expect(mockExchangeOAuthCode).not.toHaveBeenCalled();
  });

  it('rejects legacy JSON state instead of trusting its redirect path', async () => {
    const legacyState = JSON.stringify({
      redirectPath: '/admin',
    });

    const response = await GET(
      new NextRequest(
        `http://localhost:13000/api/slack/callback?code=oauth-code&state=${encodeURIComponent(legacyState)}`,
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://localhost:13000/settings?error=invalid_callback',
    );
    expect(mockCreateServerCaller).not.toHaveBeenCalled();
  });
});
