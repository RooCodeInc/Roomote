const { mockBuild, mockDelete, mockFromRegistry, mockSetConfig } = vi.hoisted(
  () => ({
    mockBuild: vi.fn(),
    mockDelete: vi.fn(),
    mockFromRegistry: vi.fn(),
    mockSetConfig: vi.fn(),
  }),
);

vi.mock('@blaxel/core', () => ({
  ImageInstance: { fromRegistry: mockFromRegistry },
  SandboxInstance: { delete: mockDelete },
  settings: { setConfig: mockSetConfig },
}));

import {
  buildBlaxelWorkerImage,
  deriveBlaxelWorkerImageName,
} from './build-blaxel-image';

describe('Blaxel worker image provisioning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const image = {
      hash: 'abc123',
      build: mockBuild,
      runCommands: vi.fn(),
    };
    image.runCommands.mockReturnValue(image);
    mockFromRegistry.mockReturnValue(image);
    mockDelete.mockResolvedValue(undefined);
  });

  it('derives a deterministic resource name from the Blaxel image hash', () => {
    expect(deriveBlaxelWorkerImageName('ghcr.io/roomote/worker:v1')).toBe(
      'roomote-worker-abc123-r1',
    );
  });

  it('builds, returns the immutable image ref, and cleans up the build sandbox', async () => {
    mockBuild.mockResolvedValue({
      spec: { runtime: { image: 'sandbox/roomote-worker:version' } },
    });

    await expect(
      buildBlaxelWorkerImage({
        apiKey: 'key',
        workspace: 'workspace',
        imageRef: 'ghcr.io/roomote/worker:v1',
      }),
    ).resolves.toEqual({
      imageName: 'roomote-worker-abc123-r1',
      imageRef: 'sandbox/roomote-worker:version',
    });

    expect(mockSetConfig).toHaveBeenCalledWith({
      apiKey: 'key',
      workspace: 'workspace',
    });
    expect(mockBuild).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'roomote-worker-abc123-r1' }),
    );
    expect(mockDelete).toHaveBeenCalledWith('roomote-worker-abc123-r1');
  });
});
