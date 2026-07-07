import type { UserAuthSuccess } from '@/types';

const {
  mockGetArtifactByPath,
  mockGenerateDownloadUrl,
  mockSignArtifactId,
  mockCurrentEpochSeconds,
} = vi.hoisted(() => ({
  mockGetArtifactByPath: vi.fn(),
  mockGenerateDownloadUrl: vi.fn(),
  mockSignArtifactId: vi.fn(),
  mockCurrentEpochSeconds: vi.fn(),
}));

vi.mock('@/lib/server', () => ({
  getArtifactByPath: mockGetArtifactByPath,
  generateDownloadUrl: mockGenerateDownloadUrl,
  signArtifactId: mockSignArtifactId,
  currentEpochSeconds: mockCurrentEpochSeconds,
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
    mockSignArtifactId.mockReturnValue('sig');
    mockCurrentEpochSeconds.mockReturnValue(1_700_000_000);
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
});
