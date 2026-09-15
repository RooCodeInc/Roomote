import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createAzureMachine } from './create-azure-machine';

vi.mock('../factory', () => ({
  createComputeProviderClient: vi.fn(),
}));

import { getWorkerRelease } from '../sandbox/worker-release-cache';

vi.mock('../sandbox/worker-release-cache', () => ({
  getWorkerRelease: vi.fn(),
}));

vi.mock('../sandbox/utils', () => ({
  loadLocalWorkerReleaseWithVersion: vi.fn(() => ({
    archive: Buffer.from('local-worker'),
    version: 'local',
  })),
}));

const mockGetWorkerRelease = vi.mocked(getWorkerRelease);

const AZURE_OPTIONS = {
  azureSubscriptionId: 'sub',
  azureResourceGroup: 'rg',
  azureSandboxGroup: 'sandboxes',
  azureRegion: 'eastus',
  azureDiskImage: 'image',
};

describe('createAzureMachine bootstrap retry', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-files-'));
    fs.writeFileSync(
      path.join(tempDir, 'install-browser-agent.sh'),
      '#!/bin/bash\n',
    );
    fs.writeFileSync(path.join(tempDir, 'install-worker.sh'), '#!/bin/bash\n');
    process.env.LOCAL_SANDBOX_FILES_DIR = tempDir;
    mockGetWorkerRelease.mockResolvedValue({
      archive: Buffer.from('worker-release'),
      tag: 'worker-v1.2.3',
      version: '1.2.3',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.LOCAL_SANDBOX_FILES_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('retries a fresh launch with a new instance after a cut install stream', async () => {
    vi.useFakeTimers();
    const createInstance = vi
      .fn()
      .mockResolvedValueOnce({ instanceId: 'azure-1', domains: {} })
      .mockResolvedValueOnce({ instanceId: 'azure-2', domains: {} });
    const runCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error('terminated'))
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'ok' });
    const destroyInstance = vi.fn().mockResolvedValue(undefined);

    const pending = createAzureMachine({
      ...AZURE_OPTIONS,
      launchMode: 'fresh',
      computeClient: {
        vendor: 'azure',
        createInstance,
        resumeFromSnapshot: vi.fn(),
        resumeFromStandby: vi.fn(),
        writeFiles: vi.fn().mockResolvedValue(undefined),
        runCommand,
        destroyInstance,
      },
    });

    await vi.advanceTimersByTimeAsync(2_000);
    const machine = await pending;

    expect(machine.machineId).toBe('azure-2');
    expect(createInstance).toHaveBeenCalledTimes(2);
    expect(destroyInstance).toHaveBeenCalledTimes(1);
  });

  it('does not retry a standby resume, whose retained sandbox the cleanup deleted', async () => {
    const resumeFromStandby = vi
      .fn()
      .mockResolvedValue({ instanceId: 'standby-1', domains: {} });
    const runCommand = vi.fn().mockRejectedValue(new Error('terminated'));
    const destroyInstance = vi.fn().mockResolvedValue(undefined);

    await expect(
      createAzureMachine({
        ...AZURE_OPTIONS,
        launchMode: 'task_standby',
        resumeHandle: 'standby-1',
        computeClient: {
          vendor: 'azure',
          createInstance: vi.fn(),
          resumeFromSnapshot: vi.fn(),
          resumeFromStandby,
          writeFiles: vi.fn().mockResolvedValue(undefined),
          runCommand,
          destroyInstance,
        },
      }),
    ).rejects.toThrow('terminated');

    expect(resumeFromStandby).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(destroyInstance).toHaveBeenCalledTimes(1);
  });
});
