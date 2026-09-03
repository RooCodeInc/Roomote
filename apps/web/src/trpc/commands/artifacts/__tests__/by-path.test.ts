import type { UserAuthSuccess } from '@/types';

const {
  mockGetArtifactByPath,
  mockGetArtifactBySessionPath,
  mockGenerateDownloadUrl,
  mockGenerateOwnedDownloadUrl,
  mockSignArtifactId,
  mockCurrentEpochSeconds,
  mockFindAccessibleSession,
} = vi.hoisted(() => ({
  mockGetArtifactByPath: vi.fn(),
  mockGetArtifactBySessionPath: vi.fn(),
  mockGenerateDownloadUrl: vi.fn(),
  mockGenerateOwnedDownloadUrl: vi.fn(),
  mockSignArtifactId: vi.fn(),
  mockCurrentEpochSeconds: vi.fn(),
  mockFindAccessibleSession: vi.fn(),
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
  findAccessibleSession: mockFindAccessibleSession,
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
    mockFindAccessibleSession.mockResolvedValue({ id: 'session-1' });
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

  it('loads Session-owned artifacts from the Session storage namespace', async () => {
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
});
