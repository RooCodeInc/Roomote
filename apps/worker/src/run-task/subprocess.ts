import { ExecaError, type ResultPromise } from 'execa';

import type { HarnessLogger } from '../logging';

import { SUBPROCESS_TIMEOUT_MS } from './constants';

class SubprocessTimeoutError extends Error {
  constructor(timeout: number) {
    super(`Subprocess timeout after ${timeout}ms`);
    this.name = 'SubprocessTimeoutError';
  }
}

interface AwaitSubprocessOptions {
  subprocess: ResultPromise;
  controller: AbortController;
  logger: HarnessLogger;
}

export async function awaitSubprocess({
  subprocess,
  controller,
  logger,
}: AwaitSubprocessOptions): Promise<void> {
  logger.info('[awaitSubprocess] waiting for subprocess to finish');
  controller.abort();

  try {
    await Promise.race([
      subprocess,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new SubprocessTimeoutError(SUBPROCESS_TIMEOUT_MS)),
          SUBPROCESS_TIMEOUT_MS,
        ),
      ),
    ]);

    logger.info('[awaitSubprocess] subprocess finished gracefully');
  } catch (error) {
    if (error instanceof SubprocessTimeoutError) {
      logger.error(
        '[awaitSubprocess] subprocess did not finish within timeout, force killing',
      );

      try {
        if (subprocess.kill('SIGKILL')) {
          logger.info('[awaitSubprocess] SIGKILL sent to subprocess');
        } else {
          logger.error(
            '[awaitSubprocess] failed to send SIGKILL to subprocess',
          );
        }
      } catch (killError) {
        logger.error(
          `[awaitSubprocess] subprocess.kill(SIGKILL) failed: ${killError instanceof Error ? killError.message : String(killError)}`,
        );
      }
    } else if (error instanceof ExecaError) {
      logger.log(
        `[awaitSubprocess] subprocess exited: ${error.exitCode} - ${error.shortMessage} | durationMs: ${error.durationMs}, failed: ${error.failed}, timedOut: ${error.timedOut}, isCanceled: ${error.isCanceled}, isTerminated: ${error.isTerminated}, isMaxBuffer: ${error.isMaxBuffer}`,
      );
    } else {
      logger.error(
        `[awaitSubprocess] subprocess failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
