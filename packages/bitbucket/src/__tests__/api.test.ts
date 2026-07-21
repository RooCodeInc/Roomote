import { describe, expect, it } from 'vitest';

import {
  buildBitbucketApiBaseUrl,
  buildBitbucketRepositoryValues,
  encodeBitbucketUuid,
  getBitbucketPipelineFailureEvidence,
  getBitbucketPipelineResultName,
  getBitbucketPipelineWebUrl,
  getLatestBitbucketPipeline,
  listBitbucketRepositories,
  normalizeBitbucketLinkedAccountKey,
  stripUuidBraces,
} from '../api';

describe('listBitbucketRepositories', () => {
  it('discovers workspaces from memberships and lists repositories per workspace', async () => {
    const jsonResponse = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200 });
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/user/workspaces')) {
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

describe('normalizeBitbucketLinkedAccountKey', () => {
  it('strips braces and lowercases the account id', () => {
    expect(normalizeBitbucketLinkedAccountKey('{AbC-123}')).toBe('abc-123');
  });
});

describe('pipeline helpers', () => {
  it('strips and encodes Bitbucket UUID path segments', () => {
    expect(stripUuidBraces('{abc-123}')).toBe('abc-123');
    expect(encodeBitbucketUuid('abc-123')).toBe('%7Babc-123%7D');
    expect(encodeBitbucketUuid('{abc-123}')).toBe('%7Babc-123%7D');
  });

  it('reads pipeline result names and builds web URLs', () => {
    expect(
      getBitbucketPipelineResultName({
        uuid: '{p1}',
        state: { result: { name: 'FAILED' } },
      }),
    ).toBe('FAILED');

    expect(
      getBitbucketPipelineWebUrl({
        repositoryFullName: 'acme/roomote',
        pipeline: { uuid: '{p1}', build_number: 9 },
      }),
    ).toBe(
      'https://bitbucket.org/acme/roomote/addon/pipelines/home#!/results/9',
    );
  });

  it('throws on rejected credentials instead of reading them as no pipeline', async () => {
    const fetchImpl = (async () =>
      new Response('{"type": "error"}', { status: 403 })) as typeof fetch;

    await expect(
      getLatestBitbucketPipeline({
        repositoryFullName: 'acme/roomote',
        branch: 'main',
        token: 'token',
        username: 'bot',
        baseUrl: 'https://bitbucket.org',
        fetchImpl,
      }),
    ).rejects.toThrow('pipeline scope');
  });

  it('returns null for unknown repositories or pipelines', async () => {
    const fetchImpl = (async () =>
      new Response('{}', { status: 404 })) as typeof fetch;

    await expect(
      getLatestBitbucketPipeline({
        repositoryFullName: 'acme/roomote',
        branch: 'main',
        token: 'token',
        username: 'bot',
        baseUrl: 'https://bitbucket.org',
        fetchImpl,
      }),
    ).resolves.toBeNull();
  });

  it('tolerates null nested objects on real pipeline payloads', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          values: [
            {
              uuid: '{pipe-null}',
              build_number: 4,
              target: null,
              state: { name: 'COMPLETED', result: null },
              links: null,
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;

    const latest = await getLatestBitbucketPipeline({
      repositoryFullName: 'acme/roomote',
      branch: 'main',
      token: 'token',
      username: 'bot',
      baseUrl: 'https://bitbucket.org',
      fetchImpl,
    });

    expect(latest?.build_number).toBe(4);
    expect(getBitbucketPipelineResultName(latest!)).toBe('COMPLETED');
  });

  it('loads the latest branch pipeline and failure evidence', async () => {
    const jsonResponse = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200 });
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/pipelines/') && url.includes('pagelen=1')) {
        return jsonResponse({
          values: [
            {
              uuid: '{pipe-1}',
              build_number: 3,
              target: {
                ref_name: 'main',
                commit: { hash: 'deadbeef' },
                selector: { type: 'branches', pattern: 'main' },
              },
              state: { result: { name: 'FAILED' } },
            },
          ],
        });
      }

      if (url.includes('/pipelines/%7Bpipe-1%7D/steps/%7Bstep-1%7D/log')) {
        return new Response('Assertion failed at line 12', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      if (url.includes('/pipelines/%7Bpipe-1%7D/steps/')) {
        return jsonResponse({
          values: [
            {
              uuid: '{step-1}',
              name: 'test',
              state: { result: { name: 'FAILED' } },
            },
          ],
        });
      }

      throw new Error(`unexpected Bitbucket API url: ${url}`);
    }) as typeof fetch;

    const latest = await getLatestBitbucketPipeline({
      repositoryFullName: 'acme/roomote',
      branch: 'main',
      token: 'token',
      username: 'bot',
      baseUrl: 'https://bitbucket.org',
      fetchImpl,
    });
    expect(latest?.build_number).toBe(3);
    expect(getBitbucketPipelineResultName(latest!)).toBe('FAILED');

    const evidence = await getBitbucketPipelineFailureEvidence({
      repositoryFullName: 'acme/roomote',
      pipelineUuid: 'pipe-1',
      token: 'token',
      username: 'bot',
      baseUrl: 'https://bitbucket.org',
      fetchImpl,
    });
    expect(evidence).toContain('step="test"');
    expect(evidence).toContain('Assertion failed at line 12');
  });
});
