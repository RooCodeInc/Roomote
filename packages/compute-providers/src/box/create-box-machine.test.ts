import { getWorkerRelease } from '../sandbox/worker-release-cache';

import { createBoxMachine } from './create-box-machine';

vi.mock('../sandbox/worker-release-cache', () => ({
  getWorkerRelease: vi.fn(),
}));

vi.mock('../sandbox/bootstrap-files', () => ({
  loadSandboxBootstrapFiles: vi.fn(() => ({
    files: [
      {
        path: '/tmp/roomote-bootstrap/install-worker.sh',
        content: Buffer.from('install'),
      },
    ],
    ignoredFiles: [],
    localDir: '/local/bootstrap',
  })),
}));

const mockGetWorkerRelease = vi.mocked(getWorkerRelease);

describe('createBoxMachine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uploads fresh bootstrap assets through /tmp and resolves private port URLs', async () => {
    mockGetWorkerRelease.mockResolvedValue({
      archive: Buffer.from('worker'),
      tag: 'worker-vtest',
      version: 'test',
    });
    const createInstance = vi.fn().mockResolvedValue({ instanceId: 'box-1' });
    const writeFiles = vi.fn().mockResolvedValue(undefined);
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0 });
    const getInstanceDomains = vi.fn().mockResolvedValue({
      domains: { '3000': 'https://private.box.test' },
    });

    const machine = await createBoxMachine({
      boxApiKey: 'key',
      boxApiBaseUrl: 'https://api.box.test',
      timeoutMs: 3_600_000,
      machineType: 'large',
      idempotencyKey: 'task:123',
      launchMode: 'fresh',
      namedPorts: [{ name: 'web', port: 3000, proxied: false }],
      computeClient: {
        vendor: 'box',
        createInstance,
        resumeFromStandby: vi.fn(),
        resumeFromSnapshot: vi.fn(),
        writeFiles,
        runCommand,
        getInstanceDomains,
        destroyInstance: vi.fn(),
        enterStandby: vi.fn(),
      },
    });

    expect(createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'task:123' }),
    );
    expect(writeFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'box-1',
        files: expect.arrayContaining([
          expect.objectContaining({
            path: '/tmp/roomote-bootstrap/worker.tar.gz',
          }),
        ]),
      }),
    );
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: 'bash',
        args: ['/tmp/roomote-bootstrap/install-worker.sh'],
        env: expect.objectContaining({
          WORKER_RELEASE_ARCHIVE_PATH: '/tmp/roomote-bootstrap/worker.tar.gz',
        }),
      }),
    );
    expect(machine.domain(3000)).toBe('https://private.box.test');
  });

  it('forks a template for environment_snapshot launches and refreshes the worker', async () => {
    mockGetWorkerRelease.mockResolvedValue({
      archive: Buffer.from('worker'),
      tag: 'worker-vtest',
      version: 'test',
    });
    const createInstance = vi.fn();
    const resumeFromSnapshot = vi.fn().mockResolvedValue({
      instanceId: 'box-fork',
      sourceSnapshotId: 'roomote-snap-abc',
    });
    const writeFiles = vi.fn().mockResolvedValue(undefined);
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0 });
    const getInstanceDomains = vi.fn().mockResolvedValue({
      domains: { '3000': 'https://fork.box.test' },
    });

    const machine = await createBoxMachine({
      boxApiKey: 'key',
      launchMode: 'environment_snapshot',
      sourceSnapshotId: 'roomote-snap-abc',
      idempotencyKey: 'task:456',
      namedPorts: [{ name: 'web', port: 3000, proxied: false }],
      computeClient: {
        vendor: 'box',
        createInstance,
        resumeFromStandby: vi.fn(),
        resumeFromSnapshot,
        writeFiles,
        runCommand,
        getInstanceDomains,
        destroyInstance: vi.fn(),
        enterStandby: vi.fn(),
      },
    });

    expect(createInstance).not.toHaveBeenCalled();
    expect(resumeFromSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSnapshotId: 'roomote-snap-abc',
        idempotencyKey: 'task:456',
      }),
    );
    // Forks still refresh the shipped worker runtime.
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: 'bash',
        args: ['/tmp/roomote-bootstrap/install-worker.sh'],
      }),
    );
    expect(machine.sourceSnapshotId).toBe('roomote-snap-abc');
    expect(machine.domain(3000)).toBe('https://fork.box.test');
  });

  it('resumes task standby without reinstalling the worker release', async () => {
    const resumeFromStandby = vi.fn().mockResolvedValue({
      instanceId: 'box-standby',
      sourceSnapshotId: 'box-standby',
    });
    const writeFiles = vi.fn();
    const runCommand = vi.fn();

    const machine = await createBoxMachine({
      boxApiKey: 'key',
      boxApiBaseUrl: 'https://api.box.test',
      launchMode: 'task_standby',
      resumeHandle: 'box-standby',
      computeClient: {
        vendor: 'box',
        createInstance: vi.fn(),
        resumeFromStandby,
        resumeFromSnapshot: vi.fn(),
        writeFiles,
        runCommand,
        getInstanceDomains: vi.fn(),
        destroyInstance: vi.fn(),
        enterStandby: vi.fn(),
      },
    });

    expect(resumeFromStandby).toHaveBeenCalledWith(
      expect.objectContaining({ resumeHandle: 'box-standby' }),
    );
    expect(mockGetWorkerRelease).not.toHaveBeenCalled();
    expect(writeFiles).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
    expect(machine).toMatchObject({
      machineId: 'box-standby',
      sourceSnapshotId: 'box-standby',
    });
  });

  it('archives a fresh box when bootstrap fails', async () => {
    mockGetWorkerRelease.mockResolvedValue({
      archive: Buffer.from('worker'),
      tag: 'worker-vtest',
      version: 'test',
    });
    const destroyInstance = vi.fn().mockResolvedValue({});

    await expect(
      createBoxMachine({
        boxApiKey: 'key',
        boxApiBaseUrl: 'https://api.box.test',
        launchMode: 'fresh',
        computeClient: {
          vendor: 'box',
          createInstance: vi.fn().mockResolvedValue({ instanceId: 'box-1' }),
          resumeFromStandby: vi.fn(),
          resumeFromSnapshot: vi.fn(),
          writeFiles: vi.fn().mockRejectedValue(new Error('upload failed')),
          runCommand: vi.fn(),
          getInstanceDomains: vi.fn(),
          destroyInstance,
          enterStandby: vi.fn(),
        },
      }),
    ).rejects.toThrow('upload failed');
    expect(destroyInstance).toHaveBeenCalledWith({ instanceId: 'box-1' });
  });

  it('combines caller cancellation with the bootstrap timeout and cleans up without the aborted signal', async () => {
    mockGetWorkerRelease.mockResolvedValue({
      archive: Buffer.from('worker'),
      tag: 'worker-vtest',
      version: 'test',
    });
    const controller = new AbortController();
    const destroyInstance = vi.fn().mockResolvedValue({});
    const writeFiles = vi.fn().mockImplementation(({ signal }) => {
      controller.abort();
      signal?.throwIfAborted();
    });

    await expect(
      createBoxMachine({
        boxApiKey: 'key',
        launchMode: 'fresh',
        signal: controller.signal,
        bootstrapTimeoutMs: 60_000,
        computeClient: {
          vendor: 'box',
          createInstance: vi.fn().mockResolvedValue({ instanceId: 'box-1' }),
          resumeFromStandby: vi.fn(),
          resumeFromSnapshot: vi.fn(),
          writeFiles,
          runCommand: vi.fn(),
          getInstanceDomains: vi.fn(),
          destroyInstance,
          enterStandby: vi.fn(),
        },
      }),
    ).rejects.toThrow();
    expect(writeFiles.mock.calls[0]?.[0].signal).not.toBe(controller.signal);
    expect(destroyInstance).toHaveBeenCalledWith({ instanceId: 'box-1' });
  });

  it('destroys a fresh Box when private-domain resolution fails', async () => {
    mockGetWorkerRelease.mockResolvedValue({
      archive: Buffer.from('worker'),
      tag: 'worker-vtest',
      version: 'test',
    });
    const destroyInstance = vi.fn().mockResolvedValue({});

    await expect(
      createBoxMachine({
        boxApiKey: 'key',
        launchMode: 'fresh',
        namedPorts: [{ name: 'web', port: 3000, proxied: false }],
        computeClient: {
          vendor: 'box',
          createInstance: vi.fn().mockResolvedValue({ instanceId: 'box-1' }),
          resumeFromStandby: vi.fn(),
          resumeFromSnapshot: vi.fn(),
          writeFiles: vi.fn(),
          runCommand: vi.fn().mockResolvedValue({ exitCode: 0 }),
          getInstanceDomains: vi
            .fn()
            .mockRejectedValue(new Error('domain failed')),
          destroyInstance,
          enterStandby: vi.fn(),
        },
      }),
    ).rejects.toThrow('domain failed');
    expect(destroyInstance).toHaveBeenCalledWith({ instanceId: 'box-1' });
  });

  it('restores standby when private-domain resolution fails after resume', async () => {
    const enterStandby = vi
      .fn()
      .mockResolvedValue({ resumeHandle: 'box-standby' });
    const destroyInstance = vi.fn();

    await expect(
      createBoxMachine({
        boxApiKey: 'key',
        launchMode: 'task_standby',
        resumeHandle: 'box-standby',
        namedPorts: [{ name: 'web', port: 3000, proxied: false }],
        computeClient: {
          vendor: 'box',
          createInstance: vi.fn(),
          resumeFromStandby: vi
            .fn()
            .mockResolvedValue({ instanceId: 'box-standby' }),
          resumeFromSnapshot: vi.fn(),
          writeFiles: vi.fn(),
          runCommand: vi.fn(),
          getInstanceDomains: vi
            .fn()
            .mockRejectedValue(new Error('domain failed')),
          destroyInstance,
          enterStandby,
        },
      }),
    ).rejects.toThrow('domain failed');
    expect(enterStandby).toHaveBeenCalledWith({
      instanceId: 'box-standby',
    });
    expect(destroyInstance).not.toHaveBeenCalled();
  });
});
