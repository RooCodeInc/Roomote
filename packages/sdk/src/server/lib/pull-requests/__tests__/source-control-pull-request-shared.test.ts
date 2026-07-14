import { describe, expect, it, vi } from 'vitest';

vi.mock('@roomote/gitlab', () => ({
  isGitLabOAuthAccessToken: (token: string) => token === 'oauth-token',
}));

import { buildGitLabTokenHeader } from '../source-control-pull-request-shared';

describe('buildGitLabTokenHeader', () => {
  it('uses the Bearer authorization header for OAuth tokens', () => {
    expect(buildGitLabTokenHeader('oauth-token')).toEqual({
      name: 'Authorization',
      value: 'Bearer oauth-token',
    });
  });

  it('uses the private-token header for non-OAuth tokens', () => {
    expect(buildGitLabTokenHeader('glpat-token')).toEqual({
      name: 'PRIVATE-TOKEN',
      value: 'glpat-token',
    });
  });
});
