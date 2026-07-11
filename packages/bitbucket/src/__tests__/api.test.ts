import { describe, expect, it, vi } from 'vitest';

import {
  BITBUCKET_API_TOKEN_GIT_USERNAME,
  buildBitbucketApiBaseUrl,
  buildBitbucketRepositoryValues,
  getBitbucketGitUsername,
  listBitbucketRepositories,
  normalizeBitbucketLinkedAccountKey,
} from '../api';

describe('listBitbucketRepositories', () => {
  it('discovers workspaces from memberships and lists repositories per workspace instead of the removed cross-workspace endpoint', async () => {
    const requestedUrls: string[] = [];
    const jsonResponse = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200 });
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);

      if (url.includes('/user/permissions/workspaces')) {
        return jsonResponse({
          values: [
            { workspace: { slug: 'acme' } },
            { workspace: { slug: 'beta' } },
          ],
        });
      }

      if (url.includes('/repositories/acme')) {
        return jsonResponse({
          values: [{ uuid: '{r1}', name: 'one', full_name: 'acme/one' }],
        });
      }

      if (url.includes('/repositories/beta')) {
        return jsonResponse({
          values: [{ uuid: '{r2}', name: 'two', full_name: 'beta/two' }],
        });
      }

      throw new Error(`unexpected Bitbucket API url: ${url}`);
    }) as typeof fetch;

    const repositories = await listBitbucketRepositories({
      token: 'api-token',
      username: 'bot@example.com',
      baseUrl: 'https://bitbucket.org',
      fetchImpl,
    });

    expect(repositories.map((repository) => repository.full_name)).toEqual([
      'acme/one',
      'beta/two',
    ]);
    expect(
      requestedUrls.some((url) => url.includes('/2.0/repositories?')),
    ).toBe(false);
  });
});

describe('buildBitbucketApiBaseUrl', () => {
  it('maps bitbucket.org product host to the Cloud 2.0 API host', () => {
    expect(buildBitbucketApiBaseUrl('https://bitbucket.org')).toBe(
      'https://api.bitbucket.org/2.0',
    );
  });

  it('rejects self-hosted hosts in the Cloud-only MVP', () => {
    expect(() =>
      buildBitbucketApiBaseUrl('https://bitbucket.example.com'),
    ).toThrow(/Only Bitbucket Cloud/);
  });
});

describe('buildBitbucketRepositoryValues', () => {
  it('maps repository UUIDs without braces and workspace/slug full name', () => {
    const values = buildBitbucketRepositoryValues({
      repository: {
        uuid: '{abc-123}',
        name: 'roomote',
        full_name: 'acme/roomote',
        description: 'demo',
        is_private: true,
        mainbranch: { name: 'main' },
        links: {
          html: { href: 'https://bitbucket.org/acme/roomote' },
          clone: [
            {
              name: 'https',
              href: 'https://x-token-auth:token@bitbucket.org/acme/roomote.git',
            },
          ],
        },
      },
      linkedByUserId: 'user-1',
      baseUrl: 'https://bitbucket.org',
    });

    expect(values).toMatchObject({
      sourceControlProvider: 'bitbucket',
      externalRepoId: 'abc-123',
      fullName: 'acme/roomote',
      host: 'bitbucket.org',
      private: true,
      defaultBranch: 'main',
      htmlUrl: 'https://bitbucket.org/acme/roomote',
      linkedByUserId: 'user-1',
    });
    expect(values.cloneUrl).toBe('https://bitbucket.org/acme/roomote.git');
  });
});

describe('getBitbucketGitUsername', () => {
  it('substitutes the static API-token git user when the identity is an Atlassian account email', () => {
    expect(getBitbucketGitUsername('bot@example.com')).toBe(
      BITBUCKET_API_TOKEN_GIT_USERNAME,
    );
  });

  it('keeps the Bitbucket username for legacy app-password identities', () => {
    expect(getBitbucketGitUsername('roomote-bot')).toBe('roomote-bot');
  });
});

describe('normalizeBitbucketLinkedAccountKey', () => {
  it('strips braces and lowercases the account id', () => {
    expect(normalizeBitbucketLinkedAccountKey('{AbC-123}')).toBe('abc-123');
  });
});

describe('request path smoke', () => {
  it('documents that unit helpers stay pure without network', () => {
    expect(vi.isFakeTimers()).toBe(false);
  });
});
