import { type TaskRun } from '@roomote/sdk/client';

import { createWorkerRuntimeEventRecorder } from '../../run-task/task-run-events';
import type { EnvironmentSetupWarning } from '../setup/workspace/types';

interface BackgroundEnvironmentSetupOutcome {
  warnings: EnvironmentSetupWarning[];
}

type SettledBackgroundEnvironmentSetup =
  | {
      status: 'pending';
    }
  | {
      status: 'fulfilled';
      warnings: EnvironmentSetupWarning[];
    }
  | {
      status: 'rejected';
      error: unknown;
    };

interface BackgroundEnvironmentSetupControllerOptions {
  taskRun?: TaskRun;
  backgroundSetupPromise?: Promise<EnvironmentSetupWarning[]>;
  recordWorkerRuntimeEvent: ReturnType<typeof createWorkerRuntimeEventRecorder>;
}

export class BackgroundEnvironmentSetupController {
  private readonly taskAbortController = new AbortController();
  private readonly backgroundSetupPromise?: Promise<EnvironmentSetupWarning[]>;
  private readonly taskRun?: TaskRun;
  private readonly recordWorkerRuntimeEvent: ReturnType<
    typeof createWorkerRuntimeEventRecorder
  >;
  private settledBackgroundSetup: SettledBackgroundEnvironmentSetup = {
    status: 'pending',
  };
  private observedOutcome?:
    | Promise<BackgroundEnvironmentSetupOutcome | undefined>
    | undefined;

  constructor({
    taskRun,
    backgroundSetupPromise,
    recordWorkerRuntimeEvent,
  }: BackgroundEnvironmentSetupControllerOptions) {
    this.taskRun = taskRun;
    this.recordWorkerRuntimeEvent = recordWorkerRuntimeEvent;
    this.backgroundSetupPromise = backgroundSetupPromise?.then(
      (warnings) => {
        this.settledBackgroundSetup = {
          status: 'fulfilled',
          warnings,
        };
        return warnings;
      },
      (error) => {
        this.settledBackgroundSetup = {
          status: 'rejected',
          error,
        };
        throw error;
      },
    );
  }

  get cancelSignal(): AbortSignal {
    return this.taskAbortController.signal;
  }

  async preflightTaskStart(): Promise<void> {
    if (!this.backgroundSetupPromise) {
      return;
    }

    await Promise.resolve();

    if (this.settledBackgroundSetup.status === 'pending') {
      return;
    }

    await this.observeOutcome();
  }

  async runTask<T>(taskPromise: Promise<T>): Promise<T> {
    return await taskPromise;
  }

  async flush(): Promise<void> {
    await this.observeOutcome();
  }

  private async observeOutcome(): Promise<
    BackgroundEnvironmentSetupOutcome | undefined
  > {
    if (this.observedOutcome) {
      return await this.observedOutcome;
    }

    const backgroundSetupPromise = this.backgroundSetupPromise;

    if (!backgroundSetupPromise) {
      return undefined;
    }

    this.observedOutcome = (async () => {
      const warnings = await backgroundSetupPromise;
      const warningMessages = warnings.map((warning) => warning.message);

      if (!this.taskRun || warningMessages.length === 0) {
        return { warnings };
      }

      await this.recordWorkerRuntimeEvent({
        eventType: 'decision',
        message: `Background environment setup finished for task run #${this.taskRun.id} with readiness warnings.`,
        details: {
          reason: 'background_environment_setup_warning',
          warnings: warningMessages,
        },
      });

      return { warnings };
    })();

    return await this.observedOutcome;
  }
}
