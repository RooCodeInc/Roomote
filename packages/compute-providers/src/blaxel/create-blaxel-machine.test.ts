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
});
