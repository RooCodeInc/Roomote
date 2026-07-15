import { describe, expect, it } from 'vitest';

import {
  buildGitLabOAuthRedirectUri,
  createGitLabOAuthAuthorizationUrl,
} from '../oauth';

describe('GitLab deployment OAuth', () => {
  it('preserves a self-managed GitLab base path in the authorization URL', () => {
    const result = createGitLabOAuthAuthorizationUrl({
      baseUrl: 'https://git.example/gitlab',
      clientId: 'client-id',
      redirectUri: 'https://roomote.example/callback',
      state: 'state',
    });

    expect(new URL(result.url).toString()).toContain(
      'https://git.example/gitlab/oauth/authorize?',
    );
  });

  it('builds the callback redirect URI from the app public URL', () => {
    expect(buildGitLabOAuthRedirectUri('https://customer.roomote.ai')).toBe(
      'https://customer.roomote.ai/api/source-control/gitlab/oauth/callback',
    );
    expect(buildGitLabOAuthRedirectUri('https://customer.roomote.ai/')).toBe(
      'https://customer.roomote.ai/api/source-control/gitlab/oauth/callback',
    );
  });
});
