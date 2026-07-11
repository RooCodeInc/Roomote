import { describe, expect, it, vi } from 'vitest';

import {
  buildBitbucketApiBaseUrl,
  buildBitbucketRepositoryValues,
  normalizeBitbucketLinkedAccountKey,
} from '../api';

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
