import { describe, expect, it } from 'vitest';

import {
  buildGiteaOAuthRedirectUri,
  createGiteaOAuthAuthorizationUrl,
  getGiteaOAuthScopes,
} from '../oauth';

describe('Gitea deployment OAuth', () => {
  it('centralizes the granular deployment scopes', () => {
    expect(getGiteaOAuthScopes()).toEqual([
      'read:user',
      'read:repository',
      'write:repository',
      'write:issue',
      'read:organization',
    ]);
  });

  it('builds a self-managed callback and deployment-bound authorization state', () => {
    const redirectUri = buildGiteaOAuthRedirectUri('https://roomote.example/');
    const result = createGiteaOAuthAuthorizationUrl({
      baseUrl: 'https://git.example/gitea',
      clientId: 'client-id',
      redirectUri,
      state: 'deployment-state',
    });
    const url = new URL(result.url);

    expect(redirectUri).toBe(
      'https://roomote.example/api/source-control/gitea/oauth/callback',
    );
    expect(url.origin).toBe('https://git.example');
    expect(url.pathname).toBe('/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('state')).toBe('deployment-state');
    expect(url.searchParams.get('scope')).toBe(getGiteaOAuthScopes().join(' '));
  });
});
