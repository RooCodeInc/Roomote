import { NextRequest } from 'next/server';

import { createServerCaller } from '@/trpc/server';
import {
  createSignedSlackInstallState,
  createSignedSlackLinkAccountState,
} from '@/lib/server/slack-oauth-state';
import { encodeRecord } from '@/lib/url-coder';

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

function redirectPathAndSearch(response: Response): string {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const url = new URL(location!);
  return `${url.pathname}${url.search}`;
}

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
    expect(redirectPathAndSearch(response)).toBe(
      '/settings/integrations?slack=connected',
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
    const location = new URL(response.headers.get('location')!);
    expect(location.hostname).not.toBe('0.0.0.0');
    expect(`${location.pathname}${location.search}`).toBe(
      '/setup?step=slack&slack=connected',
    );
  });

  it('keeps link-account redirects on the safe signed path', async () => {
    const state = await createSignedSlackLinkAccountState({
      userId: 'user-1',
      redirectPath: '/settings/profile',
    });

    const response = await GET(
      new NextRequest(
        `http://localhost:13000/api/slack/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
      ),
    );

    expect(response.status).toBe(307);
    expect(redirectPathAndSearch(response)).toBe(
      '/settings/profile?slack=connected',
    );
    expect(mockFinishAuthenticateAccount).toHaveBeenCalledWith({
      code: 'oauth-code',
      state,
    });
    expect(mockExchangeOAuthCode).not.toHaveBeenCalled();
  });

  it('rejects unsigned link-account state', async () => {
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
    expect(redirectPathAndSearch(response)).toBe(
      '/settings?error=invalid_callback',
    );
    expect(mockCreateServerCaller).not.toHaveBeenCalled();
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
    expect(redirectPathAndSearch(response)).toBe(
      '/settings?error=invalid_callback',
    );
    expect(mockCreateServerCaller).not.toHaveBeenCalled();
  });
});
