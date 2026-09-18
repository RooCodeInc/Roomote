import { describe, expect, it, vi } from 'vitest';
import { createBitbucketRepositoryClient } from '../api';

const json = (body: unknown) => new Response(JSON.stringify(body));
const identity = { uuid: '{repo}', full_name: 'acme/repo' };
const pr = { id: 3, title: 'Title' };
const setup = (response: () => Response = () => json(pr)) => {
  const fetchImpl = vi.fn<typeof fetch>(async () => response());
  return {
    fetchImpl,
    client: createBitbucketRepositoryClient({
      repositoryFullName: 'acme/repo',
      token: 'oauth-token',
      fetchImpl,
    }),
  };
};

describe('bounded Bitbucket repository client', () => {
  it.each([
    '',
    'main',
    'feature/branch',
    'v1.0.0',
    'HEAD~1',
    'abcdefg',
    'a'.repeat(41),
    'abcdef1\n',
  ])('rejects non-SHA1 commit input %j before HTTP', (hash) => {
    const { client, fetchImpl } = setup();
    expect(() => client.getCommit(hash)).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['a', 'abcdef1', '6a2c16e4a152', 'ABCDEF01'.repeat(5)])(
    'reads full or abbreviated SHA1 %s',
    async (hash) => {
      const { client, fetchImpl } = setup(() =>
        json({ hash, repository: identity }),
      );
      await client.getCommit(hash);
      expect(fetchImpl).toHaveBeenCalledWith(
        `https://api.bitbucket.org/2.0/repositories/acme/repo/commit/${hash}`,
        expect.anything(),
      );
    },
  );

  it('follows exactly one validated same-repository PR diff redirect', async () => {
    const target =
      'https://api.bitbucket.org/2.0/repositories/acme/repo/diff/abcdef1..abcdef2?from_pullrequest_id=3&topic=true';
    const { client, fetchImpl } = setup(
      () => new Response(null, { status: 302, headers: { location: target } }),
    );
    fetchImpl.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: target } }),
    );
    fetchImpl.mockResolvedValueOnce(new Response('diff --git'));
    expect(await client.getPullRequestDiff(3)).toBe('diff --git');
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe('manual');
    expect(fetchImpl.mock.calls[1]).toEqual([
      target,
      expect.objectContaining({ redirect: 'error' }),
    ]);
    await expect(client.getPullRequestDiff(3)).rejects.toThrow('302');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each([
    'https://evil/2.0/repositories/acme/repo/diff/abcdef1..abcdef2',
    'https://api.bitbucket.org/2.0/repositories/acme/other/diff/abcdef1..abcdef2',
    'https://api.bitbucket.org/2.0/repositories/acme/repo/commits',
    'https://api.bitbucket.org/2.0/repositories/acme/repo/diff/../diff/abcdef1..abcdef2',
    'https://api.bitbucket.org/2.0/repositories/acme/repo/diff/%2e%2e',
    'https://user@api.bitbucket.org/2.0/repositories/acme/repo/diff/abcdef1..abcdef2',
    'https://api.bitbucket.org/2.0/repositories/acme/repo/diff/abcdef1..abcdef2?from_pullrequest_id=4',
    'https://api.bitbucket.org/2.0/repositories/acme/repo/diff/abcdef1..abcdef2?path=secret',
  ])(
    'rejects unsafe diff redirect %s without a second HTTP request',
    async (location) => {
      const { client, fetchImpl } = setup(
        () => new Response(null, { status: 302, headers: { location } }),
      );
      await expect(client.getPullRequestDiff(3)).rejects.toThrow(
        'Unsafe Bitbucket diff redirect',
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('uses existing bearer credentials and prevents redirects with a request deadline', async () => {
    const { client, fetchImpl } = setup();
    await client.getPullRequest(3);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.bitbucket.org/2.0/repositories/acme/repo/pullrequests/3',
      expect.objectContaining({
        redirect: 'error',
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({
          Authorization: 'Bearer oauth-token',
        }),
      }),
    );
  });

  it('merges without deleting the source branch or following provider links', async () => {
    const { client, fetchImpl } = setup();
    await client.mergePullRequest(3, { mergeStrategy: 'squash' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.bitbucket.org/2.0/repositories/acme/repo/pullrequests/3/merge',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        body: JSON.stringify({
          close_source_branch: false,
          merge_strategy: 'squash',
        }),
      }),
    );
  });

  it.each([
    '../repo',
    'acme/..',
    'acme/%2e%2e',
    'acme/repo?x',
    'https://evil/repo',
    'acme/repo\\x',
  ])('rejects unsafe repository %s before HTTP', (name) => {
    expect(() =>
      createBitbucketRepositoryClient({
        repositoryFullName: name,
        token: 'token',
      }),
    ).toThrow();
  });

  it.each([
    '../secret',
    '/etc/passwd',
    'a/../b',
    'a//b',
    'https://evil/a',
    '%252e%252e/x',
    'a\\b',
  ])('rejects unsafe file path %s before HTTP', (path) => {
    const { client, fetchImpl } = setup();
    expect(() => client.getFile('main', path)).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['..', '../main', 'https://evil', '%2e%2e', 'a\\b'])(
    'rejects unsafe revision %s',
    (ref) => {
      const { client, fetchImpl } = setup();
      expect(() => client.getFile(ref, 'file.ts')).toThrow();
      expect(() => client.getCommit(ref)).toThrow();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('reads encoded revision/path text and bounded directory entries', async () => {
    const { client, fetchImpl } = setup(() => new Response('hello'));
    expect(await client.getFile('feature/branch', 'src/a b.ts')).toBe('hello');
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      '/src/feature%2Fbranch/src/a%20b.ts',
    );
    fetchImpl.mockResolvedValueOnce(
      json({
        values: [{ path: 'src', type: 'commit_directory' }],
        next: 'https://evil/steal',
      }),
    );
    expect(await client.listDirectory('main')).toEqual({
      values: [{ path: 'src', type: 'commit_directory' }],
      hasMore: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('encodes punctuation and accepts long paths and revisions without changing URL scope', async () => {
    const { client, fetchImpl } = setup(() => new Response('contents'));
    const ref = `feature/${'a'.repeat(256)}?x#y:z`;
    const path = `${'dir/'.repeat(512)}file?x#y:z.txt`;
    await client.getFile(ref, path);
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.origin).toBe('https://api.bitbucket.org');
    expect(url.pathname).toBe(
      `/2.0/repositories/acme/repo/src/${encodeURIComponent(ref)}/${path.split('/').map(encodeURIComponent).join('/')}`,
    );
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
  });

  it.each([
    'foo OR repo:other',
    'repo:other',
    'foo AND bar',
    'foo"',
    '(foo)',
    'foo\nbar',
    '',
  ])('rejects search query syntax %s', (terms) => {
    const { client, fetchImpl } = setup();
    expect(() => client.searchCode(terms)).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fixes search scope and preserves required ownership data for the handler', async () => {
    const match = {
      file: { path: 'src/a.ts', commit: { repository: identity } },
      content_matches: [],
    };
    const { client, fetchImpl } = setup(() =>
      json({ values: [match], next: 'https://evil/steal' }),
    );
    expect(await client.searchCode('some_function', 2)).toEqual({
      values: [match],
      hasMore: true,
    });
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/2.0/workspaces/acme/search/code');
    expect(url.searchParams.get('search_query')).toBe(
      'repo:repo some_function',
    );
    expect(url.searchParams.get('page')).toBe('2');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockResolvedValueOnce(
      json({ values: [{ file: { path: 'x', commit: {} } }] }),
    );
    await expect(client.searchCode('term')).rejects.toThrow();
  });

  it('bounds pagination and rejects oversized pages', async () => {
    const { client, fetchImpl } = setup(() =>
      json({ values: Array.from({ length: 51 }, () => ({ id: 1 })) }),
    );
    await expect(client.listCommits('main', 0)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(client.listPullRequestComments(3)).rejects.toThrow();
    fetchImpl.mockResolvedValueOnce(json({ values: [] }));
    await client.listPullRequestComments(3, 101);
    expect(
      new URL(String(fetchImpl.mock.lastCall?.[0])).searchParams.get('page'),
    ).toBe('101');
  });

  it.each([301, 302, 307, 308, 401, 403, 404, 429, 500])(
    'fails closed on HTTP %s without following Location or reading error body',
    async (status) => {
      const { client, fetchImpl } = setup(
        () =>
          new Response('secret upstream text', {
            status,
            headers: { Location: 'https://evil/steal' },
          }),
      );
      await expect(client.getPullRequest(3)).rejects.toThrow(
        `Bitbucket API request failed: ${status}`,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each([true, false])(
    'rejects oversized declared or streamed responses (declared=%s)',
    async (declared) => {
      const cancel = vi.fn();
      const { client } = setup(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(1_048_577));
              },
              cancel,
            }),
            { headers: declared ? { 'content-length': '1048577' } : {} },
          ),
      );
      await expect(client.getFile('main', 'file')).rejects.toThrow(
        'exceeds 1 MiB',
      );
      expect(cancel).toHaveBeenCalled();
    },
  );

  it('rejects malformed JSON and invalid PR ids', async () => {
    const { client, fetchImpl } = setup(() => new Response('{'));
    await expect(client.getPullRequest(3)).rejects.toThrow();
    expect(() => client.getPullRequest(-1)).toThrow();
    expect(() => client.getPullRequest(1.2)).toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reads repository, commit history/details, diff and comment ownership', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(json({ ...identity, name: 'repo' }));
    expect(await client.getRepository()).toMatchObject(identity);
    fetchImpl.mockResolvedValueOnce(
      json({ values: [{ hash: 'abcdef1', repository: identity }] }),
    );
    expect((await client.listCommits('main')).values).toHaveLength(1);
    fetchImpl.mockResolvedValueOnce(
      json({ hash: 'abcdef1', repository: identity }),
    );
    expect(await client.getCommit('abcdef1')).toMatchObject({
      hash: 'abcdef1',
    });
    fetchImpl.mockResolvedValueOnce(new Response('diff --git'));
    expect(await client.getPullRequestDiff(3)).toBe('diff --git');
    fetchImpl.mockResolvedValueOnce(
      json({ id: 9, user: { uuid: '{author}' }, content: { raw: 'body' } }),
    );
    expect(await client.getPullRequestComment(3, 9)).toMatchObject({
      user: { uuid: '{author}' },
    });
  });

  it('allows only title/description updates and native decline', async () => {
    const { client, fetchImpl } = setup();
    await client.updatePullRequest(3, {
      title: 'New',
      description: '',
      state: 'MERGED',
    } as { title: string });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: 'PUT',
      body: JSON.stringify({ title: 'New', description: '' }),
    });
    await client.declinePullRequest(3);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toMatch(
      /pullrequests\/3\/decline$/,
    );
    expect(fetchImpl.mock.calls[1]?.[1]?.method).toBe('POST');
  });

  it('passes provider-owned text constraints through unchanged', async () => {
    const { client, fetchImpl } = setup();
    const description = 'x'.repeat(65_537);
    await client.updatePullRequest(3, { title: '', description });
    expect(JSON.parse(String(fetchImpl.mock.lastCall?.[1]?.body))).toEqual({
      title: '',
      description,
    });
    fetchImpl.mockResolvedValueOnce(json({ id: 10 }));
    await client.createPullRequestComment(3, description);
    expect(JSON.parse(String(fetchImpl.mock.lastCall?.[1]?.body))).toEqual({
      content: { raw: description },
    });
    fetchImpl.mockResolvedValueOnce(json({ values: [] }));
    await client.listCommits('feature/branch');
    expect(String(fetchImpl.mock.lastCall?.[0])).toBe(
      'https://api.bitbucket.org/2.0/repositories/acme/repo/commits/feature%2Fbranch?page=1&pagelen=50',
    );
  });

  it('creates comments and native parent-id replies without inline capabilities', async () => {
    const { client, fetchImpl } = setup(() => json({ id: 10 }));
    await client.createPullRequestComment(3, 'Comment');
    await client.createPullRequestComment(3, 'Reply', 9);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      content: { raw: 'Comment' },
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      content: { raw: 'Reply' },
      parent: { id: 9 },
    });
    expect(() => client.createPullRequestComment(3, 'Reply', -1)).toThrow();
    await client.createPullRequestComment(3, '');
    expect(JSON.parse(String(fetchImpl.mock.lastCall?.[1]?.body))).toEqual({
      content: { raw: '' },
    });
  });
});
