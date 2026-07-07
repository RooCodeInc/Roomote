import * as fs from 'node:fs';
import { inspect } from 'node:util';

import { STARTUP_DEBUG_PREFIX } from '@roomote/types';

import {
  getWorkerRuntimeContext,
  type WorkerRuntimeContext,
} from '../monitoring/runtime-context';
import { captureWorkerException } from '../monitoring/sentry';

import type { StartupLogger, WorkerLogSink } from './types';

/**
 * Creates a {@link StartupLogger} that separates user-facing output from
 * internal debug messages during the worker startup phase.
 *
 * Both channels write to stdout so all output is captured in the Vercel
 * Sandbox log pipeline. The Startup UI filters lines prefixed with
 * `[debug]` to show only curated, user-facing messages.
 *
 * Call {@link StartupLogger.setFilePath} once the workspace path is known
 * to also persist all output (buffered + future) to the harness log file.
 *
 * - `userLog` – curated messages shown in the Startup UI (plain stdout).
 * - `debug` – internal operational messages prefixed with `[debug]`
 *   (stdout, hidden from users by the UI filter).
 */
export function createStartupLogger(options?: {
  sink?: WorkerLogSink;
}): StartupLogger {
  const baseConsole = globalThis.console;

  const buffer: string[] = [];
  let filePath: string | undefined;
  let writePromise = Promise.resolve();

  const formatArgs = (args: unknown[]) =>
    args
      .map((arg) =>
        typeof arg === 'string'
          ? arg
          : inspect(arg, { depth: 5, breakLength: 120 }),
      )
      .join(' ');

  const captureStartupLoggerWriteError = (
    error: unknown,
    context: {
      filePath: string;
      runtimeContext?: WorkerRuntimeContext;
      stage: 'startupLogger.appendToFile' | 'startupLogger.flushBuffer';
    },
    message: string,
  ) => {
    captureWorkerException(error, {
      ...context.runtimeContext,
      filePath: context.filePath,
      stage: context.stage,
    });

    baseConsole.error(message);
  };

  const appendToFile = (line: string) => {
    const targetFilePath = filePath;

    if (!targetFilePath) {
      buffer.push(line);
      return;
    }

    const runtimeContext = getWorkerRuntimeContext();

    writePromise = writePromise
      .then(() => fs.promises.appendFile(targetFilePath, `${line}\n`))
      .catch((error) => {
        captureStartupLoggerWriteError(
          error,
          {
            filePath: targetFilePath,
            runtimeContext,
            stage: 'startupLogger.appendToFile',
          },
          `[StartupLogger] Failed to append to log file ${targetFilePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };

  const makeLogFn =
    (
      level: 'log' | 'info' | 'warn' | 'error',
      consoleFn: (...args: unknown[]) => void,
      prefix?: string,
    ) =>
    (...args: unknown[]) => {
      consoleFn(...(prefix ? [prefix, ...args] : args));
      const renderedArgs = formatArgs(args);
      const timestamp = new Date().toISOString();
      const label = prefix ? `${prefix} ` : '';
      const line = `[${timestamp}] [${level.toUpperCase()}] ${label}${renderedArgs}`;
      appendToFile(line);

      options?.sink?.write({
        timestamp,
        logger: 'startup',
        level,
        channel: prefix ? 'debug' : 'user',
        message: renderedArgs,
      });
    };

  return {
    userLog: {
      log: makeLogFn('log', baseConsole.log),
      info: makeLogFn('info', baseConsole.log),
      warn: makeLogFn('warn', baseConsole.warn),
      error: makeLogFn('error', baseConsole.error),
    },
    debug: {
      log: makeLogFn('log', baseConsole.log, STARTUP_DEBUG_PREFIX),
      info: makeLogFn('info', baseConsole.log, STARTUP_DEBUG_PREFIX),
      warn: makeLogFn('warn', baseConsole.log, STARTUP_DEBUG_PREFIX),
      error: makeLogFn('error', baseConsole.log, STARTUP_DEBUG_PREFIX),
    },
    setFilePath: (path: string) => {
      filePath = path;

      // Flush buffered lines.
      if (buffer.length > 0) {
        const content = buffer.map((line) => `${line}\n`).join('');
        const runtimeContext = getWorkerRuntimeContext();
        buffer.length = 0;

        writePromise = writePromise
          .then(() => fs.promises.appendFile(path, content))
          .catch((error) => {
            captureStartupLoggerWriteError(
              error,
              {
                filePath: path,
                runtimeContext,
                stage: 'startupLogger.flushBuffer',
              },
              `[StartupLogger] Failed to flush buffer to ${path}: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }
    },
  };
}
