import { getWorkerRelease } from '../sandbox/worker-release-cache';

import { createBlaxelMachine } from './create-blaxel-machine';

vi.mock('../sandbox/worker-release-cache', () => ({
  getWorkerRelease: vi.fn(),
}));

const mockGetWorkerRelease = vi.mocked(getWorkerRelease);

describe('createBlaxelMachine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reconnects task standby without reinstalling the shipped runtime', async () => {
    const resumeFromStandby = vi.fn().mockResolvedValue({
      instanceId: 'roomote-blaxel-standby',
      sourceSnapshotId: 'roomote-blaxel-standby',
      domains: {},
    });
    const writeFiles = vi.fn();
    const runCommand = vi.fn();

    const machine = await createBlaxelMachine({
      blaxelApiKey: 'key',
      blaxelWorkspace: 'workspace',
      blaxelImage: 'sandbox/roomote-worker:test',
      launchMode: 'task_standby',
      resumeHandle: 'roomote-blaxel-standby',
      computeClient: {
        vendor: 'blaxel',
        createInstance: vi.fn(),
        resumeFromStandby,
        writeFiles,
        runCommand,
        destroyInstance: vi.fn(),
      },
    });

    expect(resumeFromStandby).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeHandle: 'roomote-blaxel-standby',
      }),
    );
    expect(mockGetWorkerRelease).not.toHaveBeenCalled();
    expect(writeFiles).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
    expect(machine).toMatchObject({
      machineId: 'roomote-blaxel-standby',
      sourceSnapshotId: 'roomote-blaxel-standby',
    });
  });

  it('forwards the stable provisioning key to fresh sandbox creation', async () => {
    mockGetWorkerRelease.mockResolvedValue({
      archive: Buffer.from('worker'),
      tag: 'worker-vtest',
      version: 'test',
    });
    const createInstance = vi.fn().mockResolvedValue({
      instanceId: 'roomote-stable',
      domains: {},
    });
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0 });

    await createBlaxelMachine({
      blaxelApiKey: 'key',
      blaxelWorkspace: 'workspace',
      blaxelImage: 'sandbox/roomote-worker:test',
      idempotencyKey: 'roomote-task-run:42',
      launchMode: 'fresh',
      computeClient: {
        vendor: 'blaxel',
        createInstance,
        resumeFromStandby: vi.fn(),
        writeFiles: vi.fn(),
        runCommand,
        destroyInstance: vi.fn(),
      },
    });

    expect(createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'roomote-task-run:42' }),
    );
  });

  it('preserves messages from plain Blaxel API errors', async () => {
    const onMutation = vi.fn();
    const resumeFromStandby = vi
      .fn()
      .mockRejectedValue({ code: 409, error: 'Resource already exists' });

    await expect(
      createBlaxelMachine({
        blaxelApiKey: 'key',
        blaxelWorkspace: 'workspace',
        blaxelImage: 'sandbox/roomote-worker:test',
        launchMode: 'task_standby',
        resumeHandle: 'roomote-blaxel-standby',
        onMutation,
        computeClient: {
          vendor: 'blaxel',
          createInstance: vi.fn(),
          resumeFromStandby,
          writeFiles: vi.fn(),
          runCommand: vi.fn(),
          destroyInstance: vi.fn(),
        },
      }),
    ).rejects.toThrow('Resource already exists');
    expect(resumeFromStandby).toHaveBeenCalledTimes(1);
    expect(onMutation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        eventType: 'failed',
        details: expect.objectContaining({
          error: 'Resource already exists',
        }),
      }),
    );
  });

  it('does not multiply an exhausted workload-unavailable retry budget', async () => {
    const resumeFromStandby = vi
      .fn()
      .mockRejectedValue(
        new Error(
          '404 {"error":{"code":"WORKLOAD_UNAVAILABLE","origin":"platform","retryable":true}}',
        ),
      );

    await expect(
      createBlaxelMachine({
        blaxelApiKey: 'key',
        blaxelWorkspace: 'workspace',
        blaxelImage: 'sandbox/roomote-worker:test',
        launchMode: 'task_standby',
        resumeHandle: 'roomote-blaxel-standby',
        computeClient: {
          vendor: 'blaxel',
          createInstance: vi.fn(),
          resumeFromStandby,
          writeFiles: vi.fn(),
          runCommand: vi.fn(),
          destroyInstance: vi.fn(),
        },
      }),
    ).rejects.toThrow('WORKLOAD_UNAVAILABLE');
    expect(resumeFromStandby).toHaveBeenCalledTimes(1);
  });
});
