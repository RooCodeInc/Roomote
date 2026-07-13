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
      entrypoint: vi.fn(),
    };
    image.runCommands.mockReturnValue(image);
    image.entrypoint.mockReturnValue(image);
    mockFromRegistry.mockReturnValue(image);
    mockDelete.mockResolvedValue(undefined);
  });

  it('derives a deterministic resource name from the Blaxel image hash', () => {
    expect(deriveBlaxelWorkerImageName('ghcr.io/roomote/worker:v1')).toBe(
      'roomote-worker-abc123-r4',
    );
    const image = mockFromRegistry.mock.results[0]?.value;
    expect(image.runCommands).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.stringContaining('base64 -d'),
    );
    const entrypointCommand = image.runCommands.mock.calls[0]?.[3] as string;
    const encodedEntrypoint = entrypointCommand.match(
      /printf '%s' '([^']+)'/,
    )?.[1];
    expect(encodedEntrypoint).toBeDefined();
    const entrypoint = Buffer.from(encodedEntrypoint!, 'base64').toString();
    expect(entrypoint).toContain('DOCKER_INSECURE_NO_IPTABLES_RAW=1');
    expect(entrypoint).toContain('"storage-driver":"vfs"');
    expect(entrypoint).toContain('/usr/local/bin/sandbox-api &');
    expect(entrypoint).toContain('exec dockerd');
    expect(image.entrypoint).toHaveBeenCalledWith('/entrypoint.sh');
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
      imageName: 'roomote-worker-abc123-r4',
      imageRef: 'sandbox/roomote-worker:version',
    });

    expect(mockSetConfig).toHaveBeenCalledWith({
      apiKey: 'key',
      workspace: 'workspace',
    });
    expect(mockBuild).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'roomote-worker-abc123-r4' }),
    );
    expect(mockDelete).toHaveBeenCalledWith('roomote-worker-abc123-r4');
  });
});
