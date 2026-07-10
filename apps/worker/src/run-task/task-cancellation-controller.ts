import type { HarnessLogger } from '../logging';

interface TaskCancellationControllerOptions {
  runId: number;
  logger: Pick<HarnessLogger, 'warn'>;
  externalCancelSignal?: AbortSignal;
}

export class TaskCancellationController {
  private readonly controller = new AbortController();
  private cancelTask?: () => void;

  constructor({
    runId,
    logger,
    externalCancelSignal,
  }: TaskCancellationControllerOptions) {
    if (!externalCancelSignal) {
      return;
    }

    const handleExternalCancellation = () => {
      logger.warn(
        `[runTask] External cancellation requested for task run ${runId}`,
      );
      this.abort(externalCancelSignal.reason);
    };

    if (externalCancelSignal.aborted) {
      handleExternalCancellation();
    } else {
      externalCancelSignal.addEventListener(
        'abort',
        handleExternalCancellation,
        {
          once: true,
        },
      );
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get abortController(): AbortController {
    return this.controller;
  }

  bindCancelTask(cancelTask: () => void): void {
    this.cancelTask = cancelTask;

    if (this.controller.signal.aborted) {
      cancelTask();
    }
  }

  abort(reason?: unknown): void {
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason);
    }

    this.cancelTask?.();
  }
}
