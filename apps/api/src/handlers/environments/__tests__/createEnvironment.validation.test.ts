import { MULTI_INSTALLATION_ENVIRONMENT_REPOSITORIES_ERROR } from '@roomote/types';

import { getEnvironmentRepositoryConfigError } from '../createEnvironment';

describe('getEnvironmentRepositoryConfigError', () => {
  it('allows GitHub and GitLab repositories in the same environment', () => {
    expect(
      getEnvironmentRepositoryConfigError([
        { fullName: 'acme/frontend', installationId: 'github-installation' },
        { fullName: 'acme/backend', installationId: null },
      ]),
    ).toBeNull();
  });

  it('rejects repositories from two GitHub App installations', () => {
    expect(
      getEnvironmentRepositoryConfigError([
        { fullName: 'acme/frontend', installationId: 'github-installation-1' },
        { fullName: 'other/backend', installationId: 'github-installation-2' },
      ]),
    ).toBe(MULTI_INSTALLATION_ENVIRONMENT_REPOSITORIES_ERROR);
  });

  it('rejects ambiguous repository names across source-control connections', () => {
    expect(
      getEnvironmentRepositoryConfigError([
        { fullName: 'acme/app', installationId: 'github-installation' },
        { fullName: 'acme/app', installationId: null },
      ]),
    ).toBe(
      'Multiple active repositories are named "acme/app". Environment repository names must be unique across source-control connections.',
    );
  });
});
