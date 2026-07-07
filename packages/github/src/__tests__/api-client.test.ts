const { OctokitMock } = vi.hoisted(() => ({
  OctokitMock: vi.fn().mockImplementation(function (options: unknown) {
    return { options };
  }),
}));

vi.mock('@octokit/rest', () => ({
  Octokit: OctokitMock,
}));

import { getOctokit } from '../api';

describe('getOctokit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes Octokit requests through the runtime fetch with the API version header', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;

    try {
      getOctokit('ghs_test');

      expect(OctokitMock).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: 'ghs_test',
          userAgent: 'Roomote',
          request: expect.objectContaining({
            headers: expect.objectContaining({
              'X-GitHub-Api-Version': '2022-11-28',
            }),
            fetch: expect.any(Function),
          }),
        }),
      );

      const requestFetch = OctokitMock.mock.calls[0]?.[0]?.request?.fetch;

      await requestFetch?.('https://api.github.com/repos/Roomote/example-app', {
        method: 'GET',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/Roomote/example-app',
        { method: 'GET' },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
