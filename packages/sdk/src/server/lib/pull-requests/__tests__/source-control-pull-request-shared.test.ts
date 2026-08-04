import { describe, expect, it, vi } from 'vitest';

vi.mock('@roomote/gitlab', () => ({
  isGitLabOAuthAccessToken: (token: string) => token === 'oauth-token',
}));

import {
  buildGitLabTokenHeader,
  resolveSourceControlHostForRepositoryFromPayload,
  resolveSourceControlProviderForRepositoryFromPayload,
} from '../source-control-pull-request-shared';

describe('resolveSourceControlProviderForRepositoryFromPayload', () => {
  it('prefers the target repository provider over the task primary provider', () => {
    expect(
      resolveSourceControlProviderForRepositoryFromPayload(
        {
          sourceControlProvider: 'github',
          repositoryProviders: { 'acme/backend': 'gitlab' },
        },
        'acme/backend',
      ),
    ).toBe('gitlab');
  });

  it('falls back to the task primary provider when the repository is unmapped', () => {
    expect(
      resolveSourceControlProviderForRepositoryFromPayload(
        {
          sourceControlProvider: 'github',
          repositoryProviders: { 'acme/backend': 'gitlab' },
        },
        'acme/frontend',
      ),
    ).toBe('github');
  });
});

describe('resolveSourceControlHostForRepositoryFromPayload', () => {
  it('does not apply the primary provider host to a mapped secondary repository', () => {
    expect(
      resolveSourceControlHostForRepositoryFromPayload(
        {
          sourceControlProvider: 'github',
          sourceControlHost: 'github.com',
          repositoryProviders: { 'acme/backend': 'gitlab' },
        },
        'acme/backend',
      ),
    ).toBeUndefined();
  });

  it('keeps the scalar host for repositories on the primary provider', () => {
    expect(
      resolveSourceControlHostForRepositoryFromPayload(
        {
          sourceControlProvider: 'github',
          sourceControlHost: 'github.com',
          repositoryProviders: { 'acme/backend': 'gitlab' },
        },
        'acme/frontend',
      ),
    ).toBe('github.com');
  });
});

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
