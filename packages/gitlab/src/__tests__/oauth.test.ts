import { describe, expect, it } from 'vitest';

import { createGitLabOAuthAuthorizationUrl } from '../oauth';

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
});
