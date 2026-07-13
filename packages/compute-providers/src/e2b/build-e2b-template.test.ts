const { mockBuild, mockFromImage, mockRunCmd, mockSetUser, mockSetWorkdir } =
  vi.hoisted(() => ({
    mockBuild: vi.fn(),
    mockFromImage: vi.fn(),
    mockRunCmd: vi.fn(),
    mockSetUser: vi.fn(),
    mockSetWorkdir: vi.fn(),
  }));

vi.mock('e2b', () => {
  const builder = {
    fromImage: mockFromImage,
    setUser: mockSetUser,
    setWorkdir: mockSetWorkdir,
    runCmd: mockRunCmd,
  };

  for (const method of Object.values(builder)) {
    method.mockReturnValue(builder);
  }

  return {
    Template: Object.assign(
      vi.fn(() => builder),
      { build: mockBuild },
    ),
  };
});

import { buildE2bWorkerTemplate } from './build-e2b-template';

describe('buildE2bWorkerTemplate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuild.mockResolvedValue({
      templateId: 'template-id',
      buildId: 'build-id',
      tags: ['default'],
    });
  });

  it('validates as root and restores the Roomote runtime user', async () => {
    await buildE2bWorkerTemplate({
      apiKey: 'e2b-key',
      imageRef: 'ghcr.io/roomote/worker:develop',
      registryUsername: 'registry-user',
      registryPassword: 'registry-password',
    });

    expect(mockFromImage).toHaveBeenCalledWith(
      'ghcr.io/roomote/worker:develop',
      { username: 'registry-user', password: 'registry-password' },
    );
    expect(mockSetUser).toHaveBeenNthCalledWith(1, 'root');
    expect(mockSetUser).toHaveBeenNthCalledWith(2, 'roomote');
    expect(mockSetWorkdir).toHaveBeenCalledWith('/home/roomote');
    expect(mockRunCmd).toHaveBeenCalledWith('/usr/bin/docker compose version');
    expect(mockRunCmd).toHaveBeenCalledWith(
      'service docker start && /usr/bin/docker info',
    );
    const runCommandOrder = mockRunCmd.mock.invocationCallOrder[0];
    const rootUserOrder = mockSetUser.mock.invocationCallOrder[0];
    const roomoteUserOrder = mockSetUser.mock.invocationCallOrder[1];
    const setWorkdirOrder = mockSetWorkdir.mock.invocationCallOrder[0];

    expect(runCommandOrder).toBeDefined();
    expect(rootUserOrder).toBeDefined();
    expect(roomoteUserOrder).toBeDefined();
    expect(setWorkdirOrder).toBeDefined();
    expect(rootUserOrder!).toBeLessThan(runCommandOrder!);
    expect(runCommandOrder!).toBeLessThan(roomoteUserOrder!);
    expect(roomoteUserOrder!).toBeLessThan(setWorkdirOrder!);
  });
});
