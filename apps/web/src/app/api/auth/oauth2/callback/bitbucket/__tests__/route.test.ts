import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handleDeploymentOAuthCallbackMock, handleAuthRequestMock } = vi.hoisted(
  () => ({
    handleDeploymentOAuthCallbackMock: vi.fn(),
    handleAuthRequestMock: vi.fn(),
  }),
);

vi.mock('@/app/api/source-control/bitbucket/oauth/callback/route', () => ({
  GET: handleDeploymentOAuthCallbackMock,
}));
vi.mock('@/lib/server/auth', () => ({
  handleAuthRequest: handleAuthRequestMock,
}));

import { GET } from '../route';

function request(url: string, deploymentState?: string) {
  return new NextRequest(url, {
    headers: deploymentState
      ? { cookie: `roomote-bitbucket-oauth-state=${deploymentState}` }
      : undefined,
  });
}

describe('Bitbucket OAuth callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleDeploymentOAuthCallbackMock.mockResolvedValue(
      new Response('deployment'),
    );
    handleAuthRequestMock.mockResolvedValue(new Response('auth'));
  });

  it('dispatches deployment OAuth when its state cookie matches', async () => {
    const result = await GET(
      request(
        'https://roomote.test/api/auth/oauth2/callback/bitbucket?state=deployment-state&code=code',
        'deployment-state',
      ),
    );

    expect(result).toBeInstanceOf(Response);
    expect(handleDeploymentOAuthCallbackMock).toHaveBeenCalledOnce();
    expect(handleAuthRequestMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a different state', 'other-state', 'deployment-state'],
    ['no deployment state cookie', 'deployment-state', undefined],
  ])('delegates %s to Better Auth', async (_label, state, cookie) => {
    await GET(
      request(
        `https://roomote.test/api/auth/oauth2/callback/bitbucket?state=${state}`,
        cookie,
      ),
    );

    expect(handleAuthRequestMock).toHaveBeenCalledOnce();
    expect(handleDeploymentOAuthCallbackMock).not.toHaveBeenCalled();
  });
});
