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

  it('preserves messages from plain Blaxel API errors', async () => {
    vi.useFakeTimers();
    try {
      const onMutation = vi.fn();
      const resumeFromStandby = vi
        .fn()
        .mockRejectedValue({ code: 409, error: 'Resource already exists' });

      const result = createBlaxelMachine({
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
      });
      const rejection = expect(result).rejects.toThrow(
        'Resource already exists',
      );

      await vi.advanceTimersByTimeAsync(6_000);
      await rejection;
      expect(onMutation).toHaveBeenLastCalledWith(
        expect.objectContaining({
          eventType: 'failed',
          details: expect.objectContaining({
            error: 'Resource already exists',
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
