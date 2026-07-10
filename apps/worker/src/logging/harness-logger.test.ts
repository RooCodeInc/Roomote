import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const { captureWorkerErrorLogMock } = vi.hoisted(() => ({
  captureWorkerErrorLogMock: vi.fn(),
}));

vi.mock('../monitoring/sentry', () => ({
  captureWorkerErrorLog: captureWorkerErrorLogMock,
  captureWorkerException: vi.fn(),
}));

import type { WorkerLogSink } from './types';

import { createHarnessLogger, HARNESS_LOG_FILE_NAME } from './harness-logger';

let harnessLogPath = path.resolve('/tmp', HARNESS_LOG_FILE_NAME);

describe('createHarnessLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harnessLogPath = path.resolve(
      '/tmp',
      `${crypto.randomUUID()}-${HARNESS_LOG_FILE_NAME}`,
    );
    fs.rmSync(harnessLogPath, { force: true });
  });

  afterEach(() => {
    fs.rmSync(harnessLogPath, { force: true });
  });

  it('writes formatted log lines to the harness logfile', async () => {
    const logger = createHarnessLogger(123, {
      logToConsole: false,
      filePath: harnessLogPath,
    });

    logger.info('hello from modal worker', { branch: 'main' });

    await vi.waitFor(async () => {
      const content = await fs.promises.readFile(harnessLogPath, 'utf8');
      expect(content).toContain('[INFO] hello from modal worker');
      expect(content).toContain("{ branch: 'main' }");
    });
  });

  it('reuses an existing logfile across logger instances', async () => {
    const firstLogger = createHarnessLogger(123, {
      logToConsole: false,
      filePath: harnessLogPath,
    });
    const secondLogger = createHarnessLogger(123, {
      logToConsole: false,
      filePath: harnessLogPath,
    });

    firstLogger.log('first-line');
    secondLogger.error('second-line');

    await vi.waitFor(async () => {
      const content = await fs.promises.readFile(harnessLogPath, 'utf8');
      expect(content).toContain('[LOG] first-line');
      expect(content).toContain('[ERROR] second-line');
    });
  });

  it('forwards error logs to the generic worker Sentry hook', () => {
    const logger = createHarnessLogger(321, {
      logToConsole: false,
      filePath: harnessLogPath,
    });

    logger.error('background process failed');

    expect(captureWorkerErrorLogMock).toHaveBeenCalledWith(
      ['background process failed'],
      {
        runId: 321,
        component: 'harnessLogger',
        filePath: harnessLogPath,
      },
    );
  });

  it('forwards harness log entries to the optional sink', () => {
    const sink: WorkerLogSink = {
      write: vi.fn(),
    };

    const logger = createHarnessLogger(321, {
      logToConsole: false,
      filePath: harnessLogPath,
      sink,
    });

    logger.warn('background process warning');

    expect(sink.write).toHaveBeenCalledWith(
      expect.objectContaining({
        logger: 'harness',
        level: 'warn',
        message: 'background process warning',
        runId: 321,
        filePath: harnessLogPath,
      }),
    );
  });
});
