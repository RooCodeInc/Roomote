import { describe, expect, it } from 'vitest';

import {
  BITBUCKET_OAUTH_CALLBACK_PATH,
  buildBitbucketOAuthRedirectUri,
  createBitbucketOAuthAuthorizationUrl,
  getBitbucketOAuthScopes,
} from '../oauth';

describe('Bitbucket deployment OAuth', () => {
  it('uses the shared Better Auth callback path', () => {
    expect(buildBitbucketOAuthRedirectUri('https://roomote.test/')).toBe(
      `https://roomote.test${BITBUCKET_OAUTH_CALLBACK_PATH}`,
    );
  });

  it('builds the Bitbucket authorization URL with Roomote scopes', () => {
    const result = createBitbucketOAuthAuthorizationUrl({
      clientId: 'consumer-id',
      redirectUri: buildBitbucketOAuthRedirectUri('https://roomote.test'),
      state: 'csrf-state',
    });
    const url = new URL(result.url);

    expect(url.origin).toBe('https://bitbucket.org');
    expect(url.pathname).toBe('/site/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('consumer-id');
    expect(url.searchParams.get('state')).toBe('csrf-state');
    expect(url.searchParams.get('scope')).toBe(
      getBitbucketOAuthScopes().join(' '),
    );
  });
});
