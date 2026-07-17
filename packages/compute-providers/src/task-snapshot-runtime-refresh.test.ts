import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createDaytonaMachine } from './daytona/create-daytona-machine';
import { createE2bMachine } from './e2b/create-e2b-machine';
import { getWorkerRelease } from './sandbox/worker-release-cache';

vi.mock('./sandbox/worker-release-cache', () => ({
  getWorkerRelease: vi.fn(),
}));

const mockGetWorkerRelease = vi.mocked(getWorkerRelease);

describe('task snapshot worker runtime refresh', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-runtime-'));
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
    delete process.env.LOCAL_SANDBOX_FILES_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('refreshes the E2B worker after restoring a task snapshot', async () => {
    const resumeFromSnapshot = vi.fn().mockResolvedValue({
      instanceId: 'e2b-123',
      domains: {},
      sourceSnapshotId: 'snap-task-123',
    });
    const writeFiles = vi.fn().mockResolvedValue(undefined);
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0 });

    await createE2bMachine({
      e2bApiKey: 'e2b-key',
      e2bTemplateId: 'template-123',
      launchMode: 'task_snapshot',
      sourceSnapshotId: 'snap-task-123',
      computeClient: {
        vendor: 'e2b',
        createInstance: vi.fn(),
        resumeFromSnapshot,
        writeFiles,
        runCommand,
        destroyInstance: vi.fn(),
      },
    });

    expectTaskSnapshotRuntimeRefresh({
      resumeFromSnapshot,
      writeFiles,
      runCommand,
    });
  });

  it('refreshes the Daytona worker after restoring a task snapshot', async () => {
    const resumeFromSnapshot = vi.fn().mockResolvedValue({
      instanceId: 'daytona-123',
      domains: {},
      sourceSnapshotId: 'snap-task-123',
    });
    const writeFiles = vi.fn().mockResolvedValue(undefined);
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0 });

    await createDaytonaMachine({
      daytonaApiKey: 'daytona-key',
      daytonaSnapshotName: 'snapshot-123',
      launchMode: 'task_snapshot',
      sourceSnapshotId: 'snap-task-123',
      computeClient: {
        vendor: 'daytona',
        createInstance: vi.fn(),
        resumeFromSnapshot,
        writeFiles,
        runCommand,
        destroyInstance: vi.fn(),
      },
    });

    expectTaskSnapshotRuntimeRefresh({
      resumeFromSnapshot,
      writeFiles,
      runCommand,
    });
  });
});

function expectTaskSnapshotRuntimeRefresh({
  resumeFromSnapshot,
  writeFiles,
  runCommand,
}: {
  resumeFromSnapshot: ReturnType<typeof vi.fn>;
  writeFiles: ReturnType<typeof vi.fn>;
  runCommand: ReturnType<typeof vi.fn>;
}): void {
  expect(mockGetWorkerRelease).toHaveBeenCalledTimes(1);
  expect(resumeFromSnapshot).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceSnapshotId: 'snap-task-123',
      metadata: expect.objectContaining({
        workerReleaseTag: 'worker-v1.2.3',
      }),
    }),
  );
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
}
