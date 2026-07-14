import { NextRequest } from 'next/server';

const mockEnvState = vi.hoisted(() => ({
  R_APP_URL: 'https://roomote.203-0-113-7.sslip.io',
  R_PUBLIC_URL: undefined as string | undefined,
}));

vi.mock('../env', () => ({
  Env: new Proxy(
    {},
    {
      get: (_target, prop) => mockEnvState[prop as keyof typeof mockEnvState],
    },
  ),
}));

import { getCallbackHost } from '../get-callback-host';

describe('getCallbackHost', () => {
  it.each([
    'http://localhost:13000',
    'http://127.0.0.1:3000',
    'http://0.0.0.0:3000',
    'http://[::]:3000',
    'http://[::1]:3000',
  ])('rewrites internal origin %s to the public app URL', (origin) => {
    const request = new NextRequest(
      `${origin}/api/slack/callback?code=abc&state=xyz`,
    );

    expect(getCallbackHost(request)).toBe(
      'https://roomote.203-0-113-7.sslip.io/api/slack/callback?code=abc&state=xyz',
    );
  });

  it('keeps externally reachable request URLs untouched', () => {
    const request = new NextRequest(
      'https://roomote.example.com/api/slack/callback?code=abc',
    );

    expect(getCallbackHost(request)).toBe(
      'https://roomote.example.com/api/slack/callback?code=abc',
    );
  });

  it('prefers the configured public URL for internal requests', () => {
    mockEnvState.R_PUBLIC_URL = 'https://roomote.example.com';
    const request = new NextRequest(
      'http://localhost:13000/api/gitea/callback',
    );

    expect(getCallbackHost(request)).toBe(
      'https://roomote.example.com/api/gitea/callback',
    );
  });
});
