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

  it('restores standby without retrying after a cut install stream', async () => {
    const resumeFromStandby = vi
      .fn()
      .mockResolvedValue({ instanceId: 'standby-1', domains: {} });
    const runCommand = vi.fn().mockRejectedValue(new Error('terminated'));
    const destroyInstance = vi.fn().mockResolvedValue(undefined);
    const enterStandby = vi
      .fn()
      .mockResolvedValue({ resumeHandle: 'standby-1' });

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
          enterStandby,
        },
      }),
    ).rejects.toThrow('terminated');

    expect(resumeFromStandby).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(enterStandby).toHaveBeenCalledWith({ instanceId: 'standby-1' });
    expect(destroyInstance).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'preserves a TLS-rejected retained sandbox even when suspension fails: %s',
    async (suspendFails) => {
      const resumeFromStandby = vi
        .fn()
        .mockResolvedValue({ instanceId: 'standby-1', domains: {} });
      const destroyInstance = vi.fn();
      const enterStandby = suspendFails
        ? vi.fn().mockRejectedValue(new Error('suspend unavailable'))
        : vi.fn().mockResolvedValue({ resumeHandle: 'standby-1' });
      const runCommand = vi.fn().mockResolvedValue({
        exitCode: 1,
        stderr: 'Error: Node v22.17.1 does not meet the TLS trust minimum',
      });
      const onMutation = vi.fn();

      await expect(
        createAzureMachine({
          ...AZURE_OPTIONS,
          launchMode: 'task_standby',
          resumeHandle: 'standby-1',
          onMutation,
          computeClient: {
            vendor: 'azure',
            createInstance: vi.fn(),
            resumeFromSnapshot: vi.fn(),
            resumeFromStandby,
            writeFiles: vi.fn().mockResolvedValue(undefined),
            runCommand,
            destroyInstance,
            enterStandby,
          },
        }),
      ).rejects.toThrow('Node v22.17.1 does not meet the TLS trust minimum');

      expect(resumeFromStandby).toHaveBeenCalledTimes(1);
      expect(runCommand).toHaveBeenCalledTimes(1);
      expect(enterStandby).toHaveBeenCalledExactlyOnceWith({
        instanceId: 'standby-1',
      });
      expect(destroyInstance).not.toHaveBeenCalled();
      expect(onMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'enter_standby',
          eventType: suspendFails ? 'failed' : 'completed',
          instanceId: 'standby-1',
        }),
      );
      expect(
        onMutation.mock.calls.some(
          ([event]) => event.operation === 'destroy_instance',
        ),
      ).toBe(false);
    },
  );

  it.each(['fresh', 'task_snapshot', 'environment_snapshot'] as const)(
    'still destroys a newly allocated %s instance when its TLS runtime is rejected',
    async (launchMode) => {
      const destroyInstance = vi.fn().mockResolvedValue(undefined);
      const enterStandby = vi.fn();
      await expect(
        createAzureMachine({
          ...AZURE_OPTIONS,
          ...(launchMode === 'fresh'
            ? { launchMode }
            : { launchMode, sourceSnapshotId: 'source-snapshot' }),
          computeClient: {
            vendor: 'azure',
            createInstance: vi
              .fn()
              .mockResolvedValue({ instanceId: 'fresh-1' }),
            resumeFromSnapshot: vi
              .fn()
              .mockResolvedValue({ instanceId: 'fresh-1' }),
            resumeFromStandby: vi.fn(),
            writeFiles: vi.fn().mockResolvedValue(undefined),
            runCommand: vi.fn().mockResolvedValue({
              exitCode: 1,
              stderr: 'Node v22.17.1 does not meet the TLS trust minimum',
            }),
            destroyInstance,
            enterStandby,
          },
        }),
      ).rejects.toThrow('TLS trust minimum');
      expect(destroyInstance).toHaveBeenCalledExactlyOnceWith({
        instanceId: 'fresh-1',
      });
      expect(enterStandby).not.toHaveBeenCalled();
    },
  );

  it('never falls back to deleting a retained sandbox when standby is unsupported', async () => {
    const destroyInstance = vi.fn();
    await expect(
      createAzureMachine({
        ...AZURE_OPTIONS,
        launchMode: 'task_standby',
        resumeHandle: 'standby-1',
        computeClient: {
          vendor: 'azure',
          createInstance: vi.fn(),
          resumeFromSnapshot: vi.fn(),
          resumeFromStandby: vi
            .fn()
            .mockResolvedValue({ instanceId: 'standby-1' }),
          writeFiles: vi.fn().mockResolvedValue(undefined),
          runCommand: vi.fn().mockResolvedValue({
            exitCode: 1,
            stderr: 'Node v22.17.1 does not meet the TLS trust minimum',
          }),
          destroyInstance,
        },
      }),
    ).rejects.toThrow('TLS trust minimum');
    expect(destroyInstance).not.toHaveBeenCalled();
  });
});
