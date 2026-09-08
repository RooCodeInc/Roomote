import { describe, expect, it, vi } from 'vitest';
import {
  db,
  environmentFactory,
  environmentRepositoryMappings,
  githubInstallationFactory,
  repositoryFactory,
  runFactory,
  userFactory,
} from '@roomote/db/server';

vi.mock('@roomote/gitlab', () => ({
  isGitLabOAuthAccessToken: (token: string) => token === 'oauth-token',
}));

import {
  assertRepositoryInTaskRunScope,
  buildGitLabTokenHeader,
  resolveSourceControlHostForRepositoryFromPayload,
  resolveSourceControlProviderForRepositoryFromPayload,
} from '../source-control-pull-request-shared';

describe('environment GitHub repository scope', () => {
  it.each([
    'same installation',
    'different installation',
    'inactive target',
    'non-GitHub target',
    'inactive anchor',
    'non-GitHub mapped anchor',
    'unmapped anchor',
    'explicit other provider',
    'scalar other provider',
    'non-environment task',
  ])('%s', async (scenario) => {
    const user = await userFactory.create();
    const installation = await githubInstallationFactory.create({
      installedByUserId: user.id,
    });
    const anchor = await repositoryFactory.create({
      linkedByUserId: user.id,
      installationId: installation.id,
      isActive: scenario !== 'inactive anchor',
    });
    const target = await repositoryFactory.create({
      linkedByUserId: user.id,
      installationId:
        scenario === 'different installation'
          ? (
              await githubInstallationFactory.create({
                installedByUserId: user.id,
              })
            ).id
          : installation.id,
      sourceControlProvider:
        scenario === 'non-GitHub target' ? 'gitlab' : 'github',
      isActive: scenario !== 'inactive target',
    });
    const environment = await environmentFactory.create({
      createdByUserId: user.id,
      config: {
        name: 'Scope regression',
        repositories: [{ repository: anchor.fullName }],
      },
    });
    if (scenario !== 'unmapped anchor') {
      const mappedAnchor =
        scenario === 'non-GitHub mapped anchor'
          ? await repositoryFactory.create({
              linkedByUserId: user.id,
              fullName: anchor.fullName,
              sourceControlProvider: 'gitlab',
            })
          : anchor;
      await db.insert(environmentRepositoryMappings).values({
        environmentId: environment.id,
        repositoryId: mappedAnchor.id,
      });
    }
    const run = await runFactory.create({
      payload: {
        repo: anchor.fullName,
        ...(scenario === 'non-environment task'
          ? {}
          : { environmentId: environment.id }),
        sourceControlProvider:
          scenario === 'scalar other provider' ? 'gitlab' : 'github',
        ...(scenario === 'scalar other provider'
          ? {}
          : {
              repositoryProviders: {
                [anchor.fullName]: 'github',
                ...(scenario === 'explicit other provider'
                  ? { [target.fullName]: 'gitlab' }
                  : {}),
              },
            }),
      },
    });
    const originalPayload = structuredClone(run.payload);
    if (scenario === 'non-environment task') {
      expect(() =>
        resolveSourceControlProviderForRepositoryFromPayload(
          run.payload,
          target.fullName,
        ),
      ).toThrow('not mapped');
    } else {
      expect(
        resolveSourceControlProviderForRepositoryFromPayload(
          run.payload,
          target.fullName,
        ),
      ).toBe(
        scenario === 'explicit other provider' ||
          scenario === 'scalar other provider'
          ? 'gitlab'
          : 'github',
      );
    }
    const assertion = assertRepositoryInTaskRunScope(run, target.fullName);
    if (scenario === 'same installation') {
      await expect(assertion).resolves.toBeUndefined();
      expect(
        resolveSourceControlProviderForRepositoryFromPayload(
          run.payload,
          target.fullName,
        ),
      ).toBe('github');
      expect(
        resolveSourceControlHostForRepositoryFromPayload(
          run.payload,
          target.fullName,
        ),
      ).toBeUndefined();
    } else {
      await expect(assertion).rejects.toThrow(
        [
          'inactive anchor',
          'non-GitHub mapped anchor',
          'unmapped anchor',
        ].includes(scenario)
          ? 'GitHub installations'
          : 'outside this task',
      );
    }
    expect(run.payload).toEqual(originalPayload);
    await expect(
      assertRepositoryInTaskRunScope(run, anchor.fullName),
    ).resolves.toBeUndefined();
  });
});

describe('resolveSourceControlProviderForRepositoryFromPayload', () => {
  it.each([
    { environmentId: ' ', sourceControlProvider: 'github' },
    { environmentId: 'environment', sourceControlProvider: 'gitlab' },
    { environmentId: 'environment' },
  ])(
    'does not provisionally select GitHub without a GitHub environment payload: %j',
    (payload) => {
      expect(() =>
        resolveSourceControlProviderForRepositoryFromPayload(
          {
            ...payload,
            repositoryProviders: { 'acme/backend': 'github' },
          },
          'acme/frontend',
        ),
      ).toThrow('not mapped');
    },
  );
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

  it('rejects repositories omitted from a provider map', () => {
    expect(() =>
      resolveSourceControlProviderForRepositoryFromPayload(
        {
          sourceControlProvider: 'github',
          repositoryProviders: { 'acme/backend': 'gitlab' },
        },
        'acme/frontend',
      ),
    ).toThrow(
      'Repository acme/frontend is not mapped to a source control provider.',
    );
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

  it('keeps the scalar host for legacy payloads without a provider map', () => {
    expect(
      resolveSourceControlHostForRepositoryFromPayload(
        {
          sourceControlProvider: 'github',
          sourceControlHost: 'github.com',
        },
        'acme/frontend',
      ),
    ).toBe('github.com');
  });

  it('does not apply a scalar host to a mapped primary repository', () => {
    expect(
      resolveSourceControlHostForRepositoryFromPayload(
        {
          sourceControlProvider: 'github',
          sourceControlHost: 'github.enterprise.example',
          repositoryProviders: {
            'acme/frontend': 'github',
            'acme/backend': 'gitlab',
          },
        },
        'acme/frontend',
      ),
    ).toBeUndefined();
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
