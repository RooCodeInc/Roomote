import { type TaskRun, sdk } from '@roomote/sdk/client';

import { createWorkerRuntimeEventRecorder } from '../../run-task/task-run-events';
import type {
  BackgroundEnvironmentSetupNotifier,
  EnvironmentSetupSettledOutcome,
} from '../../run-task/types';
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

export class BackgroundEnvironmentSetupController implements BackgroundEnvironmentSetupNotifier {
  private readonly taskAbortController = new AbortController();
  private readonly backgroundSetupPromise?: Promise<EnvironmentSetupWarning[]>;
  private readonly taskRun?: TaskRun;
  private readonly recordWorkerRuntimeEvent: ReturnType<
    typeof createWorkerRuntimeEventRecorder
  >;
  private settledBackgroundSetup: SettledBackgroundEnvironmentSetup = {
    status: 'pending',
  };
  private readonly settledListeners: Array<
    (outcome: EnvironmentSetupSettledOutcome) => void
  > = [];
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
        this.handleSettled();
        return warnings;
      },
      (error) => {
        this.settledBackgroundSetup = {
          status: 'rejected',
          error,
        };
        this.handleSettled();
        throw error;
      },
    );
  }

  get cancelSignal(): AbortSignal {
    return this.taskAbortController.signal;
  }

  get hasPendingBackgroundSetup(): boolean {
    return (
      Boolean(this.backgroundSetupPromise) &&
      this.settledBackgroundSetup.status === 'pending'
    );
  }

  onSettled(listener: (outcome: EnvironmentSetupSettledOutcome) => void): void {
    if (!this.backgroundSetupPromise) {
      return;
    }

    const outcome = this.buildSettledOutcome();

    if (outcome) {
      this.invokeSettledListener(listener, outcome);
      return;
    }

    this.settledListeners.push(listener);
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

  /**
   * Runs as soon as the background setup promise settles (not at flush time):
   * persists the terminal environment-setup state, records the runtime event,
   * and notifies in-session listeners so a running agent hears about it while
   * the information is still useful.
   */
  private handleSettled(): void {
    const observed = this.observeOutcome();
    // flush()/preflightTaskStart() re-await this same promise and propagate
    // any rejection there; without this handler a rejection would surface as
    // an unhandled rejection in the window before flush runs.
    void observed.catch(() => {});

    const outcome = this.buildSettledOutcome();

    if (!outcome) {
      return;
    }

    for (const listener of this.settledListeners) {
      this.invokeSettledListener(listener, outcome);
    }

    this.settledListeners.length = 0;
  }

  private buildSettledOutcome(): EnvironmentSetupSettledOutcome | undefined {
    if (this.settledBackgroundSetup.status === 'fulfilled') {
      return {
        status: 'fulfilled',
        warningMessages: this.settledBackgroundSetup.warnings.map(
          (warning) => warning.message,
        ),
      };
    }

    if (this.settledBackgroundSetup.status === 'rejected') {
      const error = this.settledBackgroundSetup.error;

      return {
        status: 'rejected',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }

    return undefined;
  }

  private invokeSettledListener(
    listener: (outcome: EnvironmentSetupSettledOutcome) => void,
    outcome: EnvironmentSetupSettledOutcome,
  ): void {
    try {
      listener(outcome);
    } catch (error) {
      console.warn(
        `[BackgroundEnvironmentSetupController] onSettled listener failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async persistEnvironmentSetupState(
    warningMessages: string[] | undefined,
  ): Promise<void> {
    if (!this.taskRun) {
      return;
    }

    try {
      await sdk.taskRuns.updateEnvironmentSetup({
        runId: this.taskRun.id,
        state:
          warningMessages === undefined
            ? 'failed'
            : warningMessages.length > 0
              ? 'completed_with_warnings'
              : 'completed',
        completedAt: new Date(),
      });
    } catch (error) {
      console.warn(
        `[BackgroundEnvironmentSetupController] Failed to persist environment setup state for task run ${this.taskRun.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
      let warnings: EnvironmentSetupWarning[];

      try {
        warnings = await backgroundSetupPromise;
      } catch (error) {
        await this.persistEnvironmentSetupState(undefined);
        throw error;
      }

      const warningMessages = warnings.map((warning) => warning.message);

      await this.persistEnvironmentSetupState(warningMessages);

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
