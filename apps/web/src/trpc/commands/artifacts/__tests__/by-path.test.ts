import type { UserAuthSuccess } from '@/types';

const {
  mockGetArtifactByPath,
  mockGetArtifactBySessionPath,
  mockGenerateDownloadUrl,
  mockGenerateOwnedDownloadUrl,
  mockSignArtifactId,
  mockCurrentEpochSeconds,
  mockFindReadableSession,
} = vi.hoisted(() => ({
  mockGetArtifactByPath: vi.fn(),
  mockGetArtifactBySessionPath: vi.fn(),
  mockGenerateDownloadUrl: vi.fn(),
  mockGenerateOwnedDownloadUrl: vi.fn(),
  mockSignArtifactId: vi.fn(),
  mockCurrentEpochSeconds: vi.fn(),
  mockFindReadableSession: vi.fn(),
}));

vi.mock('@/lib/server', () => ({
  getArtifactByPath: mockGetArtifactByPath,
  getArtifactBySessionPath: mockGetArtifactBySessionPath,
  generateDownloadUrl: mockGenerateDownloadUrl,
  generateOwnedDownloadUrl: mockGenerateOwnedDownloadUrl,
  signArtifactId: mockSignArtifactId,
  currentEpochSeconds: mockCurrentEpochSeconds,
}));

vi.mock('@/lib/server/sessions', () => ({
  findReadableSession: mockFindReadableSession,
}));

import { getArtifactByPathCommand } from '../by-path';

function createArtifact(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'artifact-1',
    taskId: 'task-1',
    path: 'logs/output.txt',
    version: 1,
    artifactType: 'general',
    contentType: 'text/plain',
    size: 1024,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    uploaded: true,
    ...overrides,
  };
}

describe('getArtifactByPathCommand', () => {
  const auth = {
    success: true,
    userType: 'user',
    userId: 'user-artifact-preview-test',
    isAdmin: false,
    name: 'Artifact Preview Tester',
  } as UserAuthSuccess;

  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    mockGetArtifactByPath.mockResolvedValue(createArtifact());
    mockGenerateDownloadUrl.mockResolvedValue('https://example.test/download');
    mockGenerateOwnedDownloadUrl.mockResolvedValue(
      'https://example.test/session-download',
    );
    mockSignArtifactId.mockReturnValue('sig');
    mockCurrentEpochSeconds.mockReturnValue(1_700_000_000);
    mockFindReadableSession.mockResolvedValue({ id: 'session-1' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not fetch text previews for oversized text artifacts', async () => {
    mockGetArtifactByPath.mockResolvedValue(
      createArtifact({ size: 2 * 1024 * 1024 }),
    );

    const result = await getArtifactByPathCommand(auth, {
      taskId: 'task-1',
      path: 'logs/output.txt',
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockFindReadableSession).not.toHaveBeenCalled();
    expect(result?.content).toBeUndefined();
  });

  it('does not return content when response body exceeds preview limit', async () => {
    mockFetch.mockResolvedValue(new Response('a'.repeat(2 * 1024 * 1024)));

    const result = await getArtifactByPathCommand(auth, {
      taskId: 'task-1',
      path: 'logs/output.txt',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result?.content).toBeUndefined();
  });

  it('returns content for text artifacts under the preview limit', async () => {
    mockFetch.mockResolvedValue(new Response('small text'));

    const result = await getArtifactByPathCommand(auth, {
      taskId: 'task-1',
      path: 'logs/output.txt',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result?.content).toBe('small text');
  });

  it('loads only a bounded prefix for gallery previews', async () => {
    mockGetArtifactByPath.mockResolvedValue(
      createArtifact({
        path: 'plans/large.md',
        contentType: 'text/markdown',
        size: 2 * 1024 * 1024,
      }),
    );
    mockFetch.mockResolvedValue(new Response('a'.repeat(32 * 1024)));

    const result = await getArtifactByPathCommand(auth, {
      taskId: 'task-1',
      path: 'plans/large.md',
      preview: true,
    });

    expect(mockFetch).toHaveBeenCalledWith('https://example.test/download', {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(result?.content).toHaveLength(1024);
  });

  it('does not wait for stream cancellation after reading a bounded preview', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const read = vi.fn().mockResolvedValueOnce({
      done: false,
      value: new Uint8Array(1024).fill(97),
    });
    mockGetArtifactByPath.mockResolvedValue(
      createArtifact({
        path: 'plans/large.md',
        contentType: 'text/markdown',
        size: 2 * 1024 * 1024,
      }),
    );
    mockFetch.mockResolvedValue({
      body: { getReader: () => ({ cancel, read }) },
      headers: new Headers(),
      ok: true,
    });

    const result = await Promise.race([
      getArtifactByPathCommand(auth, {
        taskId: 'task-1',
        path: 'plans/large.md',
        preview: true,
      }),
      new Promise<'timed-out'>((resolve) =>
        setTimeout(() => resolve('timed-out'), 100),
      ),
    ]);

    expect(result).not.toBe('timed-out');
    expect(result).toMatchObject({ content: 'a'.repeat(1024) });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('loads Markdown gallery previews detected from the path extension', async () => {
    mockGetArtifactByPath.mockResolvedValue(
      createArtifact({
        path: 'reports/audit.md',
        contentType: 'application/octet-stream',
      }),
    );
    mockFetch.mockResolvedValue(new Response('# Audit report'));

    const result = await getArtifactByPathCommand(auth, {
      taskId: 'task-1',
      path: 'reports/audit.md',
      preview: true,
    });

    expect(mockFetch).toHaveBeenCalledWith('https://example.test/download', {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(result?.content).toBe('# Audit report');
  });

  it('rejects failed gallery preview fetches so the client can retry', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mockGetArtifactByPath.mockResolvedValue(
      createArtifact({
        path: 'reports/audit.md',
        contentType: 'text/markdown',
      }),
    );
    mockFetch.mockResolvedValue(new Response(null, { status: 503 }));

    await expect(
      getArtifactByPathCommand(auth, {
        taskId: 'task-1',
        path: 'reports/audit.md',
        preview: true,
      }),
    ).rejects.toThrow('Failed to fetch artifact preview');
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it('loads readable Session-owned artifacts from the Session storage namespace', async () => {
    mockGetArtifactBySessionPath.mockResolvedValue(
      createArtifact({
        taskId: null,
        sessionId: '11111111-1111-4111-8111-111111111111',
      }),
    );
    mockFetch.mockResolvedValue(new Response('session text'));

    const result = await getArtifactByPathCommand(auth, {
      sessionId: '11111111-1111-4111-8111-111111111111',
      path: 'logs/output.txt',
    });

    expect(mockFindReadableSession).toHaveBeenCalledWith(
      { userId: auth.userId, isAdmin: false },
      '11111111-1111-4111-8111-111111111111',
    );
    expect(mockGetArtifactBySessionPath).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: '11111111-1111-4111-8111-111111111111',
      }),
    );
    expect(mockGenerateOwnedDownloadUrl).toHaveBeenCalledWith(
      { sessionId: '11111111-1111-4111-8111-111111111111' },
      'artifact-1',
      'logs/output.txt',
      1,
    );
    expect(result).toMatchObject({
      taskId: null,
      sessionId: '11111111-1111-4111-8111-111111111111',
      content: 'session text',
    });
  });

  it('rejects unreadable Sessions before loading or signing artifacts', async () => {
    mockFindReadableSession.mockResolvedValue(null);

    await expect(
      getArtifactByPathCommand(auth, {
        sessionId: 'missing-session',
        path: 'logs/output.txt',
      }),
    ).resolves.toBeNull();

    expect(mockGetArtifactBySessionPath).not.toHaveBeenCalled();
    expect(mockGetArtifactByPath).not.toHaveBeenCalled();
    expect(mockGenerateOwnedDownloadUrl).not.toHaveBeenCalled();
    expect(mockGenerateDownloadUrl).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'normalized content type',
      path: 'reports/preview.bin',
      contentType: 'TEXT/HTML; charset=UTF-8',
    },
    {
      label: 'path extension',
      path: 'reports/preview.HTML',
      contentType: 'application/octet-stream',
    },
  ])(
    'returns HTML content detected from $label',
    async ({ path, contentType }) => {
      mockGetArtifactByPath.mockResolvedValue(
        createArtifact({ path, contentType }),
      );
      mockFetch.mockResolvedValue(new Response('<h1>HTML preview</h1>'));

      const result = await getArtifactByPathCommand(auth, {
        taskId: 'task-1',
        path,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result?.content).toBe('<h1>HTML preview</h1>');
    },
  );

  it.each([
    {
      label: 'normalized CSV content type',
      path: 'reports/data.bin',
      contentType: 'TEXT/CSV; charset=UTF-8',
    },
    {
      label: 'CSV extension with binary metadata',
      path: 'reports/data.CSV',
      contentType: 'application/octet-stream',
    },
    {
      label: 'normalized TSV content type',
      path: 'reports/data.bin',
      contentType: 'TEXT/TAB-SEPARATED-VALUES; charset=UTF-8',
    },
    {
      label: 'TSV extension with plain-text metadata',
      path: 'reports/data.TSV',
      contentType: 'text/plain',
    },
  ])(
    'returns tabular content detected from $label',
    async ({ path, contentType }) => {
      mockGetArtifactByPath.mockResolvedValue(
        createArtifact({ path, contentType }),
      );
      mockFetch.mockResolvedValue(new Response('first,second\n1,2'));

      const result = await getArtifactByPathCommand(auth, {
        taskId: 'task-1',
        path,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result?.content).toBe('first,second\n1,2');
    },
  );
});
