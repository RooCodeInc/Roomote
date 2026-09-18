import type { UserAuthSuccess } from '@/types';

const mocks = vi.hoisted(() => ({
  getArtifactVersionsByPath: vi.fn(),
  getArtifactVersionsBySessionPath: vi.fn(),
  findReadableSession: vi.fn(),
}));

vi.mock('@/lib/server', () => ({
  getArtifactVersionsByPath: mocks.getArtifactVersionsByPath,
  getArtifactVersionsBySessionPath: mocks.getArtifactVersionsBySessionPath,
}));
vi.mock('@/lib/server/sessions', () => ({
  findReadableSession: mocks.findReadableSession,
}));

import { getArtifactVersionsCommand } from '../versions';

describe('getArtifactVersionsCommand', () => {
  const auth = {
    success: true,
    userType: 'user',
    userId: 'artifact-reader',
    isAdmin: false,
    name: 'Artifact Reader',
  } as UserAuthSuccess;
  const artifactAuth = { userId: auth.userId, isAdmin: false };
  const versions = [
    { id: 'artifact-1', version: 1, size: 10, createdAt: new Date() },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findReadableSession.mockResolvedValue({ id: 'session-1' });
    mocks.getArtifactVersionsBySessionPath.mockResolvedValue(versions);
    mocks.getArtifactVersionsByPath.mockResolvedValue(versions);
  });

  it('lists versions for a readable Session', async () => {
    await expect(
      getArtifactVersionsCommand(auth, {
        sessionId: 'session-1',
        path: 'output.txt',
      }),
    ).resolves.toEqual(versions);

    expect(mocks.findReadableSession).toHaveBeenCalledWith(
      artifactAuth,
      'session-1',
    );
    expect(mocks.getArtifactVersionsBySessionPath).toHaveBeenCalledWith({
      sessionId: 'session-1',
      path: 'output.txt',
      auth: artifactAuth,
    });
    expect(mocks.getArtifactVersionsByPath).not.toHaveBeenCalled();
  });

  it('rejects unreadable Sessions before querying versions', async () => {
    mocks.findReadableSession.mockResolvedValue(null);

    await expect(
      getArtifactVersionsCommand(auth, {
        sessionId: 'missing-session',
        path: 'output.txt',
      }),
    ).resolves.toEqual([]);

    expect(mocks.getArtifactVersionsBySessionPath).not.toHaveBeenCalled();
    expect(mocks.getArtifactVersionsByPath).not.toHaveBeenCalled();
  });

  it('preserves task-only lookup without a Session gate', async () => {
    await expect(
      getArtifactVersionsCommand(auth, {
        taskId: 'task-1',
        path: 'output.txt',
      }),
    ).resolves.toEqual(versions);

    expect(mocks.findReadableSession).not.toHaveBeenCalled();
    expect(mocks.getArtifactVersionsByPath).toHaveBeenCalledWith({
      taskId: 'task-1',
      path: 'output.txt',
      auth: artifactAuth,
    });
    expect(mocks.getArtifactVersionsBySessionPath).not.toHaveBeenCalled();
  });
});
