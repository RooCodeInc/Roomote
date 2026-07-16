import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createModalMachine } from './create-modal-machine';

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

describe('createModalMachine', () => {
  const MODAL_IMAGE_REF = 'ghcr.io/roomote/modal-worker:test';
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modal-files-'));
    fs.writeFileSync(
      path.join(tempDir, 'install-browser-agent.sh'),
      '#!/bin/bash\n',
    );
    fs.writeFileSync(path.join(tempDir, 'install-worker.sh'), '#!/bin/bash\n');
    process.env.LOCAL_SANDBOX_FILES_DIR = tempDir;
  });

  afterEach(() => {
    delete process.env.LOCAL_SANDBOX_FILES_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('passes the uploaded worker archive path to the shared install script', async () => {
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok' });
    const writeFiles = vi.fn().mockResolvedValue(undefined);

    mockGetWorkerRelease.mockResolvedValue({
      archive: Buffer.from('worker-release'),
      tag: 'worker-v1.2.3',
      version: '1.2.3',
    });

    await createModalMachine({
      modalTokenId: 'token-id',
      modalTokenSecret: 'token-secret',
      modalBaseImageRef: MODAL_IMAGE_REF,
      launchMode: 'fresh',
      computeClient: {
        vendor: 'modal',
        createInstance: vi.fn().mockResolvedValue({
          instanceId: 'modal-123',
          domains: {},
        }),
        resumeFromSnapshot: vi.fn(),
        writeFiles,
        runCommand,
        destroyInstance: vi.fn(),
      },
    });

    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          WORKER_RELEASE_ARCHIVE_PATH: '/sandbox/worker.tar.gz',
        },
      }),
    );
    expect(writeFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({
            path: '/sandbox/install-browser-agent.sh',
          }),
          expect.objectContaining({
            path: '/sandbox/install-worker.sh',
          }),
          expect.objectContaining({ path: '/sandbox/worker.tar.gz' }),
        ]),
      }),
    );
  });

  it('emits mutation events with the roomote vendor for managed-provider launches', async () => {
    mockGetWorkerRelease.mockResolvedValue({
      archive: Buffer.from('worker-release'),
      tag: 'worker-v1.2.3',
      version: '1.2.3',
    });

    const onMutation = vi.fn();
    const writeFiles = vi.fn().mockResolvedValue(undefined);
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0 });

    await createModalMachine({
      modalTokenId: 'token-id',
      modalTokenSecret: 'token-secret',
      modalBaseImageRef: MODAL_IMAGE_REF,
      launchMode: 'fresh',
      onMutation,
      computeClient: {
        vendor: 'roomote',
        createInstance: vi.fn().mockResolvedValue({
          instanceId: 'modal-123',
          domains: {},
        }),
        resumeFromSnapshot: vi.fn(),
        writeFiles,
        runCommand,
        destroyInstance: vi.fn(),
      },
    });

    expect(onMutation).toHaveBeenCalled();
    // Every emitted event carries the logical vendor, not the literal engine.
    for (const [event] of onMutation.mock.calls) {
      expect(event.provider).toBe('roomote');
    }
  });

  it('forwards sandbox tags during fresh Modal launches', async () => {
    mockGetWorkerRelease.mockResolvedValue({
      archive: Buffer.from('worker-release'),
      tag: 'worker-v1.2.3',
      version: '1.2.3',
    });

    const createInstance = vi.fn().mockResolvedValue({
      instanceId: 'modal-123',
      domains: {},
    });

    await createModalMachine({
      modalTokenId: 'token-id',
      modalTokenSecret: 'token-secret',
      modalBaseImageRef: MODAL_IMAGE_REF,
      launchMode: 'fresh',
      tags: {
        app_environment: 'preview',
        organization_name: 'Acme Corp',
      },
      computeClient: {
        vendor: 'modal',
        createInstance,
        resumeFromSnapshot: vi.fn(),
        writeFiles: vi.fn().mockResolvedValue(undefined),
        runCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok' }),
        destroyInstance: vi.fn(),
      },
    });

    expect(createInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: {
          app_environment: 'preview',
          organization_name: 'Acme Corp',
        },
      }),
    );
  });

  it('reinstalls the shipped runtime for environment snapshot resumes', async () => {
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok' });
    const writeFiles = vi.fn().mockResolvedValue(undefined);

    mockGetWorkerRelease.mockResolvedValue({
      archive: Buffer.from('worker-release'),
      tag: 'worker-v1.2.3',
      version: '1.2.3',
    });

    await createModalMachine({
      modalTokenId: 'token-id',
      modalTokenSecret: 'token-secret',
      modalBaseImageRef: MODAL_IMAGE_REF,
      launchMode: 'environment_snapshot',
      sourceSnapshotId: 'snap-123',
      computeClient: {
        vendor: 'modal',
        createInstance: vi.fn(),
        resumeFromSnapshot: vi.fn().mockResolvedValue({
          instanceId: 'modal-123',
          domains: {},
          sourceSnapshotId: 'snap-123',
        }),
        writeFiles,
        runCommand,
        destroyInstance: vi.fn(),
      },
    });

    expect(mockGetWorkerRelease).toHaveBeenCalledTimes(1);
    expect(writeFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({ path: '/sandbox/worker.tar.gz' }),
        ]),
      }),
    );
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          WORKER_RELEASE_ARCHIVE_PATH: '/sandbox/worker.tar.gz',
        },
      }),
    );
  });

  it('preserves task snapshot runtime state without reinstalling the shipped worker', async () => {
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok' });
    const writeFiles = vi.fn().mockResolvedValue(undefined);

    await createModalMachine({
      modalTokenId: 'token-id',
      modalTokenSecret: 'token-secret',
      modalBaseImageRef: MODAL_IMAGE_REF,
      launchMode: 'task_snapshot',
      sourceSnapshotId: 'snap-task-123',
      computeClient: {
        vendor: 'modal',
        createInstance: vi.fn(),
        resumeFromSnapshot: vi.fn().mockResolvedValue({
          instanceId: 'modal-123',
          domains: {},
          sourceSnapshotId: 'snap-task-123',
        }),
        writeFiles,
        runCommand,
        destroyInstance: vi.fn(),
      },
    });

    expect(mockGetWorkerRelease).not.toHaveBeenCalled();
    expect(writeFiles).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('ignores non-bootstrap files in the local Modal files directory', async () => {
    fs.writeFileSync(path.join(tempDir, 'ignore-me.txt'), 'ignore');
    const writeFiles = vi.fn().mockResolvedValue(undefined);

    mockGetWorkerRelease.mockResolvedValue({
      archive: Buffer.from('worker-release'),
      tag: 'worker-v1.2.3',
      version: '1.2.3',
    });

    await createModalMachine({
      modalTokenId: 'token-id',
      modalTokenSecret: 'token-secret',
      modalBaseImageRef: MODAL_IMAGE_REF,
      launchMode: 'fresh',
      computeClient: {
        vendor: 'modal',
        createInstance: vi.fn().mockResolvedValue({
          instanceId: 'modal-123',
          domains: {},
        }),
        resumeFromSnapshot: vi.fn(),
        writeFiles,
        runCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok' }),
        destroyInstance: vi.fn(),
      },
    });

    const writtenFiles = writeFiles.mock.calls[0]?.[0]?.files ?? [];
    expect(writtenFiles).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/sandbox/ignore-me.txt' }),
      ]),
    );
  });

  it('destroys the machine when file upload fails after creation', async () => {
    mockGetWorkerRelease.mockResolvedValue({
      archive: Buffer.from('worker-release'),
      tag: 'worker-v1.2.3',
      version: '1.2.3',
    });

    const destroyInstance = vi.fn().mockResolvedValue(undefined);

    await expect(
      createModalMachine({
        modalTokenId: 'token-id',
        modalTokenSecret: 'token-secret',
        modalBaseImageRef: MODAL_IMAGE_REF,
        launchMode: 'fresh',
        computeClient: {
          vendor: 'modal',
          createInstance: vi.fn().mockResolvedValue({
            instanceId: 'modal-123',
            domains: {},
          }),
          resumeFromSnapshot: vi.fn(),
          writeFiles: vi.fn().mockRejectedValue(new Error('write failed')),
          runCommand: vi.fn(),
          destroyInstance,
        },
      }),
    ).rejects.toThrow('write failed');

    expect(destroyInstance).toHaveBeenCalledWith({ instanceId: 'modal-123' });
  });

  it('destroys the machine when the install script fails', async () => {
    mockGetWorkerRelease.mockResolvedValue({
      archive: Buffer.from('worker-release'),
      tag: 'worker-v1.2.3',
      version: '1.2.3',
    });

    const destroyInstance = vi.fn().mockResolvedValue(undefined);

    await expect(
      createModalMachine({
        modalTokenId: 'token-id',
        modalTokenSecret: 'token-secret',
        modalBaseImageRef: MODAL_IMAGE_REF,
        launchMode: 'fresh',
        computeClient: {
          vendor: 'modal',
          createInstance: vi.fn().mockResolvedValue({
            instanceId: 'modal-123',
            domains: {},
          }),
          resumeFromSnapshot: vi.fn(),
          writeFiles: vi.fn().mockResolvedValue(undefined),
          runCommand: vi.fn().mockResolvedValue({
            exitCode: 7,
            stderr: 'install failed',
          }),
          destroyInstance,
        },
      }),
    ).rejects.toThrow('Modal worker install failed with exit code 7');

    expect(destroyInstance).toHaveBeenCalledWith({ instanceId: 'modal-123' });
  });

  it('stops retrying when the signal aborts during backoff', async () => {
    const controller = new AbortController();
    const createInstance = vi.fn().mockImplementation(async () => {
      controller.abort(new DOMException('timed out', 'AbortError'));
      throw new Error('transient modal failure');
    });

    await expect(
      createModalMachine({
        modalTokenId: 'token-id',
        modalTokenSecret: 'token-secret',
        modalBaseImageRef: MODAL_IMAGE_REF,
        launchMode: 'fresh',
        signal: controller.signal,
        computeClient: {
          vendor: 'modal',
          createInstance,
          resumeFromSnapshot: vi.fn(),
          writeFiles: vi.fn(),
          runCommand: vi.fn(),
          destroyInstance: vi.fn(),
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(createInstance).toHaveBeenCalledTimes(1);
  });
});
