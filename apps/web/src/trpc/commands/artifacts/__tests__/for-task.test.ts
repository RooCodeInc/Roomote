import type { UserAuthSuccess } from '@/types';

const mocks = vi.hoisted(() => ({
  getArtifactsForTask: vi.fn(),
  generateDownloadUrl: vi.fn(),
  signArtifactId: vi.fn(() => 'signature'),
  currentEpochSeconds: vi.fn(() => 1234),
}));

vi.mock('@/lib/server', () => mocks);

import { getArtifactsForTaskCommand } from '../for-task';

const auth = {
  userId: 'owner',
  isAdmin: false,
} as UserAuthSuccess;

function videoArtifact(privacy: 'shared' | 'private') {
  return {
    id: 'artifact-1',
    path: 'clips/demo.webm',
    version: 1,
    artifactType: 'general' as const,
    contentType: 'video/webm',
    size: 100,
    createdAt: new Date(),
    privacy,
  };
}

describe('getArtifactsForTaskCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateDownloadUrl.mockResolvedValue('https://s3.example/bearer');
  });

  it('keeps private video previews on the owner-authenticated raw route', async () => {
    mocks.getArtifactsForTask.mockResolvedValue([videoArtifact('private')]);

    await expect(
      getArtifactsForTaskCommand(auth, { taskId: 'private-task' }),
    ).resolves.toMatchObject([
      {
        id: 'artifact-1',
        previewUrl: '/api/artifacts/artifact-1/raw?sig=signature&ts=1234',
      },
    ]);
    expect(mocks.generateDownloadUrl).not.toHaveBeenCalled();
  });

  it('retains presigned video previews for shared tasks', async () => {
    mocks.getArtifactsForTask.mockResolvedValue([videoArtifact('shared')]);

    await expect(
      getArtifactsForTaskCommand(auth, { taskId: 'shared-task' }),
    ).resolves.toMatchObject([
      { id: 'artifact-1', previewUrl: 'https://s3.example/bearer' },
    ]);
    expect(mocks.generateDownloadUrl).toHaveBeenCalledOnce();
  });
});
