// pnpm --filter @roomote/compute-providers test src/sandbox/__tests__/worker-release-cache.test.ts

import {
  getWorkerRelease,
  clearWorkerReleaseCache,
} from '../worker-release-cache';
import {
  clearWorkerReleaseGitHubAuthCache,
  getWorkerReleaseGitHubToken,
} from '../worker-release-github-auth';

vi.mock('../worker-release-github-auth', () => ({
  clearWorkerReleaseGitHubAuthCache: vi.fn(),
  getWorkerReleaseGitHubToken: vi.fn(),
}));

// Mock global fetch.
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const FAKE_TOKEN = 'ghs_test_token_123';
const mockGetWorkerReleaseGitHubToken = vi.mocked(getWorkerReleaseGitHubToken);

type ReleaseListEntry =
  | string
  | {
      tag: string;
    };

function normalizeReleaseListEntry(entry: ReleaseListEntry) {
  return typeof entry === 'string' ? { tag: entry } : entry;
}

function makeMatchingRefsResponse(entries: ReleaseListEntry[]) {
  return entries.map((entry) => ({
    ref: `refs/tags/${normalizeReleaseListEntry(entry).tag}`,
  }));
}

function makeReleaseResponse(tag: string, assets = true) {
  return {
    tag_name: tag,
    prerelease: tag.includes('-preview.'),
    draft: false,
    assets: assets
      ? [{ name: `${tag}.tar.gz`, url: `https://api.github.com/asset/${tag}` }]
      : [],
  };
}

const FAKE_ARCHIVE = Buffer.from('fake-worker-release-archive');

function mockLatestReleaseFetch(
  entry: ReleaseListEntry = 'worker-v1.2.3',
  releaseTag?: string,
) {
  const normalized = normalizeReleaseListEntry(entry);
  const resolvedTag = releaseTag ?? normalized.tag;

  // First call: list matching tag refs.
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => makeMatchingRefsResponse([normalized]),
  });
  // Second call: fetch specific release for asset details
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => makeReleaseResponse(resolvedTag),
  });
  // Third call: download the worker release archive.
  mockFetch.mockResolvedValueOnce({
    ok: true,
    arrayBuffer: async () =>
      FAKE_ARCHIVE.buffer.slice(
        FAKE_ARCHIVE.byteOffset,
        FAKE_ARCHIVE.byteOffset + FAKE_ARCHIVE.byteLength,
      ),
  });
}

beforeEach(() => {
  clearWorkerReleaseCache();
  clearWorkerReleaseGitHubAuthCache();
  mockFetch.mockReset();
  mockGetWorkerReleaseGitHubToken.mockResolvedValue(FAKE_TOKEN);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('getWorkerRelease', () => {
  it('should fetch the latest stable release from matching tag refs', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        makeMatchingRefsResponse(['worker-v1.2.9', 'worker-v1.2.10']),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeReleaseResponse('worker-v1.2.10'),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () =>
        FAKE_ARCHIVE.buffer.slice(
          FAKE_ARCHIVE.byteOffset,
          FAKE_ARCHIVE.byteOffset + FAKE_ARCHIVE.byteLength,
        ),
    });

    const result = await getWorkerRelease();

    expect(result.tag).toBe('worker-v1.2.10');
    expect(result.version).toBe('1.2.10');
    expect(result.archive).toBeInstanceOf(Buffer);
    expect(result.archive.length).toBeGreaterThan(0);
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/Roomote/Roomote/git/matching-refs/tags/worker-v',
      expect.any(Object),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/Roomote/Roomote/releases/tags/worker-v1.2.10',
      expect.any(Object),
    );
  });

  it('should fetch the latest preview release when requested', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        makeMatchingRefsResponse([
          'worker-v1.2.3',
          'worker-preview-v1.2.4-preview.1',
        ]),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeReleaseResponse('worker-preview-v1.2.4-preview.1'),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () =>
        FAKE_ARCHIVE.buffer.slice(
          FAKE_ARCHIVE.byteOffset,
          FAKE_ARCHIVE.byteOffset + FAKE_ARCHIVE.byteLength,
        ),
    });

    const result = await getWorkerRelease({ channel: 'preview' });

    expect(result.tag).toBe('worker-preview-v1.2.4-preview.1');
    expect(result.version).toBe('1.2.4-preview.1');
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/Roomote/Roomote/git/matching-refs/tags/worker-preview-v',
      expect.any(Object),
    );
  });

  it('should choose the numerically latest preview release from matching tag refs', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        makeMatchingRefsResponse([
          ...Array.from({ length: 98 }, (_, index) => ({
            tag: `worker-preview-v0.0.${9800 - index}-preview.1`,
          })),
          'worker-preview-v0.0.9991-preview.1',
          'worker-preview-v0.0.10002-preview.1',
        ]),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        makeReleaseResponse('worker-preview-v0.0.10002-preview.1'),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () =>
        FAKE_ARCHIVE.buffer.slice(
          FAKE_ARCHIVE.byteOffset,
          FAKE_ARCHIVE.byteOffset + FAKE_ARCHIVE.byteLength,
        ),
    });

    const result = await getWorkerRelease({ channel: 'preview' });

    expect(result.tag).toBe('worker-preview-v0.0.10002-preview.1');
    expect(result.version).toBe('0.0.10002-preview.1');
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/Roomote/Roomote/git/matching-refs/tags/worker-preview-v',
      expect.any(Object),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/Roomote/Roomote/releases/tags/worker-preview-v0.0.10002-preview.1',
      expect.any(Object),
    );
  });

  it('should fetch an explicitly pinned release version', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeReleaseResponse('worker-preview-v1.2.4-preview.1'),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () =>
        FAKE_ARCHIVE.buffer.slice(
          FAKE_ARCHIVE.byteOffset,
          FAKE_ARCHIVE.byteOffset + FAKE_ARCHIVE.byteLength,
        ),
    });

    const result = await getWorkerRelease({
      channel: 'preview',
      version: '1.2.4-preview.1',
    });

    expect(result.tag).toBe('worker-preview-v1.2.4-preview.1');
    expect(result.version).toBe('1.2.4-preview.1');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/Roomote/Roomote/releases/tags/worker-preview-v1.2.4-preview.1',
      expect.any(Object),
    );
  });

  it('should return cached result on second call', async () => {
    mockLatestReleaseFetch('worker-v1.0.0');

    const first = await getWorkerRelease();

    // Second call still fetches metadata (refs + release) to resolve version,
    // but skips the archive download because the version is cached.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeMatchingRefsResponse(['worker-v1.0.0']),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeReleaseResponse('worker-v1.0.0'),
    });

    const second = await getWorkerRelease();

    expect(first).toBe(second);
    // 3 calls for first request (refs + release + download) + 2 for second (refs + release, no download).
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it('should keep stable and preview caches isolated', async () => {
    mockLatestReleaseFetch('worker-v1.2.3');

    const stable = await getWorkerRelease();

    mockLatestReleaseFetch('worker-preview-v1.2.4-preview.1');

    const preview = await getWorkerRelease({ channel: 'preview' });

    expect(stable.tag).toBe('worker-v1.2.3');
    expect(preview.tag).toBe('worker-preview-v1.2.4-preview.1');
    expect(stable.archive.equals(preview.archive)).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  it('should deduplicate concurrent in-flight requests', async () => {
    mockLatestReleaseFetch('worker-v1.2.3');

    // Fire two concurrent requests for "latest".
    const [a, b] = await Promise.all([getWorkerRelease(), getWorkerRelease()]);

    expect(a).toBe(b);
    expect(a.version).toBe('1.2.3');
    // Only one set of fetch calls (refs + release + download).
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('should throw when worker release GitHub auth cannot be resolved', async () => {
    mockGetWorkerReleaseGitHubToken.mockRejectedValueOnce(
      new Error('installation lookup failed'),
    );

    await expect(getWorkerRelease()).rejects.toThrow(
      'installation lookup failed',
    );
  });

  it('should throw when GitHub API returns an error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => [],
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    await expect(getWorkerRelease()).rejects.toThrow('403 Forbidden');
  });

  it('should throw when no matching worker release tags exist', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeMatchingRefsResponse(['some-other-release-v1.0.0']),
    });

    await expect(getWorkerRelease()).rejects.toThrow(
      'No worker release tags found on GitHub',
    );
  });

  it('should ignore non-comparable worker tags when selecting the stable channel', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        makeMatchingRefsResponse(['worker-vlocal-dev', 'worker-v1.2.3']),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeReleaseResponse('worker-v1.2.3'),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () =>
        FAKE_ARCHIVE.buffer.slice(
          FAKE_ARCHIVE.byteOffset,
          FAKE_ARCHIVE.byteOffset + FAKE_ARCHIVE.byteLength,
        ),
    });

    const result = await getWorkerRelease();

    expect(result.tag).toBe('worker-v1.2.3');
    expect(result.version).toBe('1.2.3');
  });

  it('should throw when no preview worker release tags exist', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeMatchingRefsResponse(['worker-v1.2.3']),
    });

    await expect(getWorkerRelease({ channel: 'preview' })).rejects.toThrow(
      'No preview worker release tags found on GitHub',
    );
  });

  it('should throw when the worker release archive is missing from the release', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeMatchingRefsResponse(['worker-v1.0.0']),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeReleaseResponse('worker-v1.0.0', false),
    });

    await expect(getWorkerRelease()).rejects.toThrow(
      'Worker release worker-v1.0.0 is missing expected archive asset worker-v1.0.0.tar.gz',
    );
  });

  it('should throw when the selected tag has no matching GitHub release', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeMatchingRefsResponse(['worker-v1.0.0']),
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    await expect(getWorkerRelease()).rejects.toThrow(
      'Selected worker release tag worker-v1.0.0 has no matching GitHub release: 404 Not Found',
    );
  });

  it('falls back to the releases list when matching refs returns 403', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeReleaseResponse('worker-v1.2.10')],
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () =>
        FAKE_ARCHIVE.buffer.slice(
          FAKE_ARCHIVE.byteOffset,
          FAKE_ARCHIVE.byteOffset + FAKE_ARCHIVE.byteLength,
        ),
    });

    const result = await getWorkerRelease();

    expect(result.tag).toBe('worker-v1.2.10');
    expect(result.version).toBe('1.2.10');
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/Roomote/Roomote/releases?per_page=100&page=1',
      expect.any(Object),
    );
  });

  it('continues scanning fallback release pages to keep the numerically latest version', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        makeReleaseResponse('worker-v1.2.9'),
        ...Array.from({ length: 99 }, (_, index) =>
          makeReleaseResponse(`worker-preview-v0.0.${index + 1}-preview.1`),
        ),
      ],
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeReleaseResponse('worker-v1.2.10')],
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () =>
        FAKE_ARCHIVE.buffer.slice(
          FAKE_ARCHIVE.byteOffset,
          FAKE_ARCHIVE.byteOffset + FAKE_ARCHIVE.byteLength,
        ),
    });

    const result = await getWorkerRelease();

    expect(result.tag).toBe('worker-v1.2.10');
    expect(result.version).toBe('1.2.10');
    expect(mockFetch).toHaveBeenNthCalledWith(
      3,
      'https://api.github.com/repos/Roomote/Roomote/releases?per_page=100&page=2',
      expect.any(Object),
    );
  });

  it('falls back to the releases list when release-by-tag returns 403', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () =>
        makeMatchingRefsResponse(['worker-preview-v1.2.4-preview.1']),
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        makeReleaseResponse('worker-preview-v1.2.4-preview.1'),
      ],
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () =>
        FAKE_ARCHIVE.buffer.slice(
          FAKE_ARCHIVE.byteOffset,
          FAKE_ARCHIVE.byteOffset + FAKE_ARCHIVE.byteLength,
        ),
    });

    const result = await getWorkerRelease({ channel: 'preview' });

    expect(result.tag).toBe('worker-preview-v1.2.4-preview.1');
    expect(result.version).toBe('1.2.4-preview.1');
    expect(mockFetch).toHaveBeenNthCalledWith(
      3,
      'https://api.github.com/repos/Roomote/Roomote/releases?per_page=100&page=1',
      expect.any(Object),
    );
  });

  it('keeps exact-tag validation strict when release-by-tag fallback cannot find that tag', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeMatchingRefsResponse(['worker-v1.2.10']),
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeReleaseResponse('worker-v1.2.9')],
    });

    await expect(getWorkerRelease()).rejects.toThrow('403 Forbidden');
  });

  it('should clear cache when clearWorkerReleaseCache is called', async () => {
    mockLatestReleaseFetch('worker-v1.0.0');

    await getWorkerRelease();
    expect(mockFetch).toHaveBeenCalledTimes(3);

    clearWorkerReleaseCache();

    mockLatestReleaseFetch('worker-v1.0.0');

    await getWorkerRelease();
    // Should have made 3 more fetch calls (total 6).
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  it('should send correct Authorization and API version headers', async () => {
    mockLatestReleaseFetch('worker-v1.0.0');

    await getWorkerRelease();

    // Verify the Authorization header was sent on all fetch calls.
    for (const call of mockFetch.mock.calls) {
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
      expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    }
  });
});
