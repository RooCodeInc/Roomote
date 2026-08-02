import { NextRequest } from 'next/server';

import { createServerCaller } from '@/trpc/server';

import { GET } from '../route';

// getCallbackHost rewrites internal request origins (localhost) to the
// configured public app URL, which it reads through the dotenvx-backed Env
// proxy. The proxy resolves values from the repo-root .env.local file, so a
// developer-local R_APP_URL/R_PUBLIC_URL (e.g. an ngrok host) would leak into
// redirect assertions even with process.env stubbed. Replace Env with a
// test-owned object so redirects always resolve against localhost.
const { envState } = vi.hoisted(() => ({
  envState: {} as { R_APP_URL: string; R_PUBLIC_URL?: string },
}));

vi.mock('@/lib/server/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/env')>()),
  Env: envState,
}));

vi.mock('@/trpc/server', () => ({
  createServerCaller: vi.fn(),
}));

const mockCreateServerCaller = vi.mocked(createServerCaller);
const mockInstallation = vi.fn();
const mockConnectApp = vi.fn();

describe('GET /api/slack/install-after-auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envState.R_APP_URL = 'http://localhost:13000';
    delete envState.R_PUBLIC_URL;
    mockCreateServerCaller.mockResolvedValue({
      slack: {
        installation: mockInstallation,
        connectApp: mockConnectApp,
      },
    } as never);
  });

  it('redirects to the requested path when Slack is already installed', async () => {
    mockInstallation.mockResolvedValue({ id: 'slack-installation-1' });

    const response = await GET(
      new NextRequest(
        'http://localhost:13000/api/slack/install-after-auth?redirect=%2Ftasks%3Fview%3Dmine',
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://localhost:13000/tasks?view=mine',
    );
    expect(mockConnectApp).not.toHaveBeenCalled();
  });

  it('starts Slack app installation when the org has no installation', async () => {
    mockInstallation.mockResolvedValue(null);
    mockConnectApp.mockResolvedValue({
      success: true,
      url: 'https://slack.com/oauth/v2/authorize?client_id=C123',
    });

    const response = await GET(
      new NextRequest(
        'http://localhost:13000/api/slack/install-after-auth?redirect=%2Fsettings%2Fintegrations',
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://slack.com/oauth/v2/authorize?client_id=C123',
    );
    expect(mockConnectApp).toHaveBeenCalledWith({
      redirectPath: '/settings/integrations',
    });
  });

  it('falls back to the app root for unsafe redirect paths', async () => {
    mockInstallation.mockResolvedValue({ id: 'slack-installation-1' });

    const response = await GET(
      new NextRequest(
        'http://localhost:13000/api/slack/install-after-auth?redirect=https%3A%2F%2Fexample.com',
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:13000/');
  });
});
