import { type CloudJob } from '@roomote/sdk/client';

import { createWorkerRuntimeEventRecorder } from '../../run-task/cloud-job-events';
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
  cloudJob?: CloudJob;
  backgroundSetupPromise?: Promise<EnvironmentSetupWarning[]>;
  recordWorkerRuntimeEvent: ReturnType<typeof createWorkerRuntimeEventRecorder>;
}

export class BackgroundEnvironmentSetupController {
  private readonly taskAbortController = new AbortController();
  private readonly backgroundSetupPromise?: Promise<EnvironmentSetupWarning[]>;
  private readonly cloudJob?: CloudJob;
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
    cloudJob,
    backgroundSetupPromise,
    recordWorkerRuntimeEvent,
  }: BackgroundEnvironmentSetupControllerOptions) {
    this.cloudJob = cloudJob;
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

      if (!this.cloudJob || warningMessages.length === 0) {
        return { warnings };
      }

      await this.recordWorkerRuntimeEvent({
        eventType: 'decision',
        message: `Background environment setup finished for cloud job #${this.cloudJob.id} with readiness warnings.`,
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
