// pnpm --filter @roomote/types test src/__tests__/environment-repository-connection.test.ts

import {
  MULTI_HOST_ENVIRONMENT_REPOSITORIES_ERROR,
  MULTI_INSTALLATION_ENVIRONMENT_REPOSITORIES_ERROR,
  MULTI_PROVIDER_ENVIRONMENT_REPOSITORIES_ERROR,
  getEnvironmentRepositoryConnectionError,
} from '../environment-config';

describe('getEnvironmentRepositoryConnectionError', () => {
  it('accepts an empty repository list', () => {
    expect(getEnvironmentRepositoryConnectionError([])).toBeNull();
  });

  it('accepts repositories from a single connection', () => {
    expect(
      getEnvironmentRepositoryConnectionError([
        {
          fullName: 'acme/api',
          sourceControlProvider: 'github',
          host: 'github.com',
          installationId: 'installation-1',
        },
        {
          fullName: 'acme/web',
          sourceControlProvider: 'github',
          host: 'github.com',
          installationId: 'installation-1',
        },
      ]),
    ).toBeNull();
  });

  it('rejects repositories that span multiple providers', () => {
    expect(
      getEnvironmentRepositoryConnectionError([
        {
          fullName: 'acme/api',
          sourceControlProvider: 'github',
          host: 'github.com',
          installationId: 'installation-1',
        },
        {
          fullName: 'acme/web',
          sourceControlProvider: 'gitea',
          host: 'gitea.example.com',
          installationId: null,
        },
      ]),
    ).toBe(MULTI_PROVIDER_ENVIRONMENT_REPOSITORIES_ERROR);
  });

  it('rejects repositories that span multiple GitHub App installations', () => {
    expect(
      getEnvironmentRepositoryConnectionError([
        {
          fullName: 'acme/api',
          sourceControlProvider: 'github',
          host: 'github.com',
          installationId: 'installation-1',
        },
        {
          fullName: 'other/web',
          sourceControlProvider: 'github',
          host: 'github.com',
          installationId: 'installation-2',
        },
      ]),
    ).toBe(MULTI_INSTALLATION_ENVIRONMENT_REPOSITORIES_ERROR);
  });

  it('rejects repositories that span multiple instances of the same provider', () => {
    expect(
      getEnvironmentRepositoryConnectionError([
        {
          fullName: 'acme/api',
          sourceControlProvider: 'gitea',
          host: 'gitea-one.example.com',
          installationId: null,
        },
        {
          fullName: 'acme/web',
          sourceControlProvider: 'gitea',
          host: 'gitea-two.example.com',
          installationId: null,
        },
      ]),
    ).toBe(MULTI_HOST_ENVIRONMENT_REPOSITORIES_ERROR);
  });

  it('ignores null hosts on rows that predate host backfill', () => {
    expect(
      getEnvironmentRepositoryConnectionError([
        {
          fullName: 'acme/api',
          sourceControlProvider: 'gitea',
          host: null,
          installationId: null,
        },
        {
          fullName: 'acme/web',
          sourceControlProvider: 'gitea',
          host: 'gitea.example.com',
          installationId: null,
        },
      ]),
    ).toBeNull();
  });

  it('ignores missing provider metadata', () => {
    expect(
      getEnvironmentRepositoryConnectionError([
        {
          fullName: 'acme/api',
          sourceControlProvider: undefined,
          host: undefined,
          installationId: 'installation-1',
        },
        {
          fullName: 'acme/web',
          sourceControlProvider: 'github',
          host: 'github.com',
          installationId: 'installation-1',
        },
      ]),
    ).toBeNull();
  });

  it('reports the provider mismatch before installation or host mismatches', () => {
    expect(
      getEnvironmentRepositoryConnectionError([
        {
          fullName: 'acme/api',
          sourceControlProvider: 'github',
          host: 'github.com',
          installationId: 'installation-1',
        },
        {
          fullName: 'acme/web',
          sourceControlProvider: 'gitea',
          host: 'gitea.example.com',
          installationId: 'installation-2',
        },
      ]),
    ).toBe(MULTI_PROVIDER_ENVIRONMENT_REPOSITORIES_ERROR);
  });
});
