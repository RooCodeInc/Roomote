import * as path from 'node:path';
import * as fs from 'node:fs';
import { inspect } from 'node:util';

import {
  captureWorkerException,
  captureWorkerErrorLog,
} from '../monitoring/sentry';

import type { HarnessLogger, WorkerLogSink } from './types';

export const HARNESS_LOG_FILE_NAME = 'harness.log';

interface HarnessLoggerOptions {
  logToConsole: boolean;
  filePath?: string;
  sink?: WorkerLogSink;
}

export const createHarnessLogger = (
  cloudJobId: number,
  options: HarnessLoggerOptions,
): HarnessLogger => {
  const baseConsole = globalThis.console;

  const filePath =
    options.filePath ?? path.resolve('/tmp', HARNESS_LOG_FILE_NAME);

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // Reuse the same logfile across task/snapshot resumes unless the caller
    // provided a unique path for this run. Create it on first use either way.
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '', { flag: 'wx' });
    }
  } catch (error) {
    captureWorkerException(error, {
      cloudJobId,
      filePath,
      stage: 'harnessLogger.prepareLogFile',
    });

    baseConsole.error(
      `[HarnessLogger] Failed to prepare log file ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let writePromise = Promise.resolve();

  const formatArgs = (args: unknown[]) =>
    args
      .map((arg) =>
        typeof arg === 'string'
          ? arg
          : inspect(arg, { depth: 5, breakLength: 120 }),
      )
      .join(' ');

  const append = (level: string, renderedArgs: string) => {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${renderedArgs}`;

    writePromise = writePromise
      .then(() => fs.promises.appendFile(filePath, `${line}\n`))
      .catch((error) => {
        captureWorkerException(error, {
          cloudJobId,
          filePath,
          stage: 'harnessLogger.appendToFile',
        });

        baseConsole.error(
          `[HarnessLogger] Failed to append to log file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };

  const wrap =
    (level: 'log' | 'info' | 'warn' | 'error') =>
    (...args: unknown[]) => {
      const renderedArgs = formatArgs(args);
      const timestamp = new Date().toISOString();

      if (options.logToConsole) {
        baseConsole[level](...args);
      }

      append(level, renderedArgs);

      options.sink?.write({
        timestamp,
        logger: 'harness',
        level,
        message: renderedArgs,
        cloudJobId,
        filePath,
      });

      if (level === 'error') {
        captureWorkerErrorLog(args, {
          cloudJobId,
          component: 'harnessLogger',
          filePath,
        });
      }
    };

  return {
    cloudJobId,
    filePath,
    flush: () => writePromise,
    log: wrap('log'),
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
  };
};
