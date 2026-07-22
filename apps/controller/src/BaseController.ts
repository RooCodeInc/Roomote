import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type ComputeProvider,
  RunStatus,
  TaskPayloadKind,
  TaskRunErrorCode,
  type TaskRunErrorCode as TaskRunErrorCodeValue,
  resolveComputeProviderTarget,
  SANDBOX_ORPHAN_SCAN_INTERVAL_MS,
  SANDBOX_TIMEOUT_MS,
  WORKER_BOOTSTRAP_CLAIM_TIMEOUT_MS,
} from '@roomote/types';
import { createRunToken } from '@roomote/auth';
import { Env } from '@roomote/env';
import { getRedis, REDIS_KEYS } from '@roomote/redis';
import {
  type TaskRun,
  db,
  taskRuns,
  buildPendingEnvironmentSnapshotMatchForTaskRun,
  readManagedDeploymentAccess,
  recordTaskRunLifecycleEvent,
  resolveDefaultComputeProvider,
  syncTaskStateFromRuns,
  updatePendingEnvironmentSnapshot,
  eq,
  and,
  asc,
  isNull,
  isNotNull,
  lt,
  sql,
} from '@roomote/db/server';
import { dequeueTaskRun } from '@roomote/cloud-agents/server';
import { finishRun } from '@roomote/sdk/server';

import { getOrphanedTaskRun } from './orphaned-task-runs';
import {
  captureControllerException,
  captureControllerMessage,
} from './monitoring/sentry';
import {
  classifyDockerSpawnError,
  formatSpawnWorkerError,
  getTaskRunErrorCode,
} from './compute-providers/docker-sandbox-security';
import { resolveFromWorkspaceRoot } from './repo-paths';
import { findPersistedWorkerBootstrapRestarts } from './worker-bootstrap-restarts';

type WorkerBootstrapExitDisposition = 'ignore' | 'restart' | 'failed';

export abstract class BaseController {
  private static readonly SOURCE_DIR = path.dirname(
    fileURLToPath(import.meta.url),
  );

  private static readonly DEFAULT_LOCAL_RELEASES_DIR_NAME = 'releases';

  private static readonly DEFAULT_LOCAL_WORKER_RELEASE_ARCHIVE =
    'worker-vlocal-dev.tar.gz';

  protected readonly LOG_INTERVAL_MS = 60_000;

  protected readonly HEARTBEAT_TTL_SECONDS = 600;

  protected readonly SHUTDOWN_TIMEOUT_MS = 60_000;

  /** Maximum concurrent spawns. Override in subclass if needed. */
  protected readonly MAX_CONCURRENT_SPAWNS: number = 10;

  protected readonly localWorkerReleasePath?: string;

  public isRunning = false;
  private isProcessingIteration = false;
  private iterationCompleteResolver: (() => void) | null = null;

  /** Track in-flight spawn operations by run ID. */
  private inFlightSpawns = new Map<number, Promise<void>>();

  /** Bootstrap retries waiting for a spawn slot or the previous spawn unwind. */
  private pendingWorkerBootstrapRestarts = new Map<number, TaskRun>();

  /** Prevent this controller from recovering a retry before cleanup finishes. */
  private workerBootstrapRestartsAwaitingCleanup = new Set<number>();

  /** Watches local release artifacts for changes (local dev only). */
  private artifactWatchers: fs.FSWatcher[] = [];

  public constructor(
    protected readonly appEnv: 'development' | 'preview' | 'production',
  ) {
    const useLocalReleaseArtifacts = this.appEnv === 'development';
    const configuredWorkerReleasePath = Env.DOCKER_WORKER_RELEASE_PATH;

    this.localWorkerReleasePath =
      configuredWorkerReleasePath ??
      (!useLocalReleaseArtifacts || process.env.USE_WORKER_RELEASE === 'true'
        ? undefined
        : BaseController.getDefaultLocalWorkerReleaseArchivePath());
  }

  private static getDefaultLocalReleasesDir(): string {
    return resolveFromWorkspaceRoot(
      BaseController.DEFAULT_LOCAL_RELEASES_DIR_NAME,
      BaseController.SOURCE_DIR,
    );
  }

  private static getDefaultLocalWorkerReleaseArchivePath(): string {
    return path.join(
      BaseController.getDefaultLocalReleasesDir(),
      BaseController.DEFAULT_LOCAL_WORKER_RELEASE_ARCHIVE,
    );
  }

  public async start() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    await this.setup();

    this.watchLocalArtifacts();

    let lastOrphanCheckAt = 0;
    let lastWorkerBootstrapCheckAt = 0;
    const orphanCheckInterval = SANDBOX_ORPHAN_SCAN_INTERVAL_MS;

    console.log('Looping for task runs...');

    while (this.isRunning) {
      this.isProcessingIteration = true;

      try {
        await getRedis().set(
          REDIS_KEYS.CONTROLLER_HEARTBEAT,
          Date.now().toString(),
          'EX',
          this.HEARTBEAT_TTL_SECONDS,
        );

        const iterationNow = Date.now();

        if (
          iterationNow - lastWorkerBootstrapCheckAt >
          SANDBOX_ORPHAN_SCAN_INTERVAL_MS
        ) {
          lastWorkerBootstrapCheckAt = iterationNow;
          await this.recoverPersistedWorkerBootstrapRestarts();
          await this.failTimedOutWorkerBootstraps();
        }

        const pendingRestart = this.pendingWorkerBootstrapRestarts
          .values()
          .next().value;

        if (
          pendingRestart &&
          this.inFlightSpawns.size < this.MAX_CONCURRENT_SPAWNS &&
          !this.inFlightSpawns.has(pendingRestart.id)
        ) {
          this.pendingWorkerBootstrapRestarts.delete(pendingRestart.id);

          if (this.spawnWorkerInBackground(pendingRestart)) {
            console.log(
              `[BaseController] Retrying worker bootstrap for task run #${pendingRestart.id}`,
            );
            continue;
          }

          this.pendingWorkerBootstrapRestarts.set(
            pendingRestart.id,
            pendingRestart,
          );
        }

        if (this.inFlightSpawns.size >= this.MAX_CONCURRENT_SPAWNS) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          continue;
        }

        const id = await dequeueTaskRun();

        if (id) {
          const taskRun = await db.query.taskRuns.findFirst({
            where: eq(taskRuns.id, id),
          });

          if (taskRun) {
            // Spawn worker in background to avoid blocking the main loop.
            // The spawnWorkerInBackground method handles errors and cleanup.
            if (this.spawnWorkerInBackground(taskRun)) {
              console.log(
                `🎯 New task run from Redis: run #${taskRun.id} of kind ${taskRun.payloadKind} in ${taskRun.payload.repo} (in-flight: ${this.inFlightSpawns.size})`,
              );
            }
          } else {
            console.error(`❌ No task run record found for id ${id}`);
          }
        } else {
          const now = Date.now();

          const isOrphanCheckDue =
            now - lastOrphanCheckAt > orphanCheckInterval;

          if (isOrphanCheckDue) {
            lastOrphanCheckAt = now;
            const taskRun = await getOrphanedTaskRun();

            if (taskRun && this.spawnWorkerInBackground(taskRun)) {
              captureControllerMessage(
                'Controller started task using database fallback logic',
                {
                  runId: taskRun.id,
                  runStatus: taskRun.status,
                  payloadKind: taskRun.payloadKind,
                  provider: taskRun.vendor,
                  repo: taskRun.payload.repo,
                  phase: 'database_fallback',
                  source: 'orphaned_task_run_scan',
                },
                {
                  component: 'dequeue-loop',
                  signal: 'database-fallback-task-start',
                },
              );

              console.log(
                `🎯 New task run from database: run #${taskRun.id} of kind ${taskRun.payloadKind} in ${taskRun.payload.repo} (in-flight: ${this.inFlightSpawns.size})`,
              );
            }
          } else {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        }
      } catch (error) {
        captureControllerException(error, {
          phase: 'dequeue_loop',
        });
        console.error(
          `🚨 Caught error in dequeueTaskRun / spawnWorker loop: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        this.isProcessingIteration = false;

        if (this.iterationCompleteResolver) {
          this.iterationCompleteResolver();
          this.iterationCompleteResolver = null;
        }
      }
    }
  }

  public async stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    console.log(
      '[BaseController] Waiting for current iteration to complete...',
    );

    await this.waitForIterationComplete();
    console.log('[BaseController] Current iteration completed');

    await this.waitForInFlightSpawns();
    console.log('[BaseController] All in-flight spawns completed');

    for (const watcher of this.artifactWatchers) {
      watcher.close();
    }
    this.artifactWatchers = [];

    await this.teardown();
    console.log('[BaseController] Teardown complete');
  }

  private async waitForIterationComplete(): Promise<void> {
    const iterationPromise = new Promise<void>((resolve) => {
      // Set the resolver BEFORE checking isProcessingIteration to avoid race condition.
      // If we checked first and then set the resolver, the finally block could run
      // between the check and setting the resolver, causing the resolver to never be called.
      this.iterationCompleteResolver = resolve;

      // Now check if iteration is still processing. If not, resolve immediately.
      if (!this.isProcessingIteration) {
        resolve();
      }
    });

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        console.warn(
          `[BaseController] Shutdown timeout (${this.SHUTDOWN_TIMEOUT_MS}ms) reached, proceeding with shutdown`,
        );
        resolve();
      }, this.SHUTDOWN_TIMEOUT_MS);
    });

    await Promise.race([iterationPromise, timeoutPromise]);
  }

  protected async setup(): Promise<void> {}

  protected async teardown(): Promise<void> {}

  /**
   * In local dev mode, watch shipped release artifacts for changes.
   * This keeps the controller aware of the current worker release archive path.
   *
   * This is a no-op when the dev stack is configured to use GitHub worker releases.
   */
  private watchLocalArtifacts(): void {
    const pathsToWatch = [
      this.localWorkerReleasePath
        ? {
            kind: 'worker release archive' as const,
            path: this.localWorkerReleasePath,
            reason: 'worker_release_rebuilt',
          }
        : null,
    ].filter((value): value is NonNullable<typeof value> => Boolean(value));

    if (pathsToWatch.length === 0) {
      return;
    }

    for (const entry of pathsToWatch) {
      if (!fs.existsSync(entry.path)) {
        console.warn(
          `[BaseController] Local ${entry.kind} path does not exist: ${entry.path}`,
        );
        continue;
      }

      console.log(
        `[BaseController] Watching local ${entry.kind} for changes: ${entry.path}`,
      );

      const watcher = fs.watch(entry.path, () => {
        console.log(
          `[BaseController] Local ${entry.kind} changed: ${entry.path} (${entry.reason})`,
        );
      });

      watcher.on('error', (err) => {
        captureControllerException(err, {
          phase: 'artifact_watch',
          artifactKind: entry.kind,
          path: entry.path,
        });
        console.error(
          `[BaseController] ${entry.kind} watch error: ${err.message}`,
        );
      });

      this.artifactWatchers.push(watcher);
    }
  }

  protected abstract spawnFreshWorker(
    taskRun: TaskRun,
    authToken: string,
    deploymentSlug: string,
    sandboxTimeoutMs: number,
    provider: ComputeProvider,
  ): Promise<void>;

  protected async spawnWorker(taskRun: TaskRun): Promise<void> {
    try {
      const dequeuedRun = await this.dequeueTaskRun(taskRun);

      if (!dequeuedRun) {
        console.log(
          `[BaseController] Skipping spawn for task run #${taskRun.id} because it left the dequeueable state before dispatch`,
        );

        return;
      }

      const { authToken } = dequeuedRun;
      const provider = resolveComputeProviderTarget(
        taskRun.vendor,
        await resolveDefaultComputeProvider(),
      );
      const sandboxTimeoutMs = SANDBOX_TIMEOUT_MS;

      await this.spawnFreshWorker(
        taskRun,
        authToken,
        'deployment',
        sandboxTimeoutMs,
        provider,
      );
    } catch (error) {
      await this.handleSpawnTaskRunError(taskRun, error);
    }
  }

  private spawnWorkerInBackground(taskRun: TaskRun): boolean {
    if (this.inFlightSpawns.has(taskRun.id)) {
      console.warn(
        `[BaseController] Task run #${taskRun.id} is already being spawned, skipping`,
      );

      return false;
    }

    if (this.inFlightSpawns.size >= this.MAX_CONCURRENT_SPAWNS) {
      console.warn(
        `[BaseController] Max concurrent spawns (${this.MAX_CONCURRENT_SPAWNS}) reached, skipping task run #${taskRun.id}`,
      );

      return false;
    }

    const spawnStartedAt = Date.now();

    const progressLogInterval = setInterval(() => {
      console.warn(
        `[BaseController] Worker spawn still in progress for task run #${taskRun.id} after ${Date.now() - spawnStartedAt}ms`,
      );
    }, this.LOG_INTERVAL_MS);

    const spawnPromise = this.spawnWorker(taskRun)
      .then(() => {
        console.log(
          `[BaseController] ✅ Worker spawned successfully for task run #${taskRun.id} in ${Date.now() - spawnStartedAt}ms`,
        );
      })
      .catch((error) => {
        // Error is already handled in handleSpawnTaskRunError, just log here.
        console.error(
          `[BaseController] ❌ Worker spawn failed for task run #${taskRun.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        clearInterval(progressLogInterval);
        this.inFlightSpawns.delete(taskRun.id);
      });

    this.inFlightSpawns.set(taskRun.id, spawnPromise);

    return true;
  }

  /** Wait for all in-flight spawns to complete. Used during shutdown. */
  private async waitForInFlightSpawns(): Promise<void> {
    if (this.inFlightSpawns.size === 0) {
      return;
    }

    console.log(
      `[BaseController] Waiting for ${this.inFlightSpawns.size} in-flight spawns to complete...`,
    );

    await Promise.allSettled(this.inFlightSpawns.values());
  }

  protected async dequeueTaskRun(
    taskRun: TaskRun,
  ): Promise<{ taskRun: TaskRun; authToken: string } | null> {
    const sandboxTimeoutMs = SANDBOX_TIMEOUT_MS;

    if (
      taskRun.status === RunStatus.Pending ||
      taskRun.status === RunStatus.Dequeued
    ) {
      const access = await readManagedDeploymentAccess();

      if (access.state === 'read_only') {
        await this.finishFailedTaskRun(
          taskRun,
          'This deployment is read-only. New task launches are paused.',
          TaskRunErrorCode.DeploymentReadOnly,
        );
        return null;
      }
    }

    // Task runs without a human driver use the deployment service principal;
    // the token carries no user claim rather than borrowing an arbitrary
    // user's identity.
    const authToken = await createRunToken({
      runId: taskRun.id,
      userId: taskRun.actingUserId ?? null,
      timeoutMs: sandboxTimeoutMs,
    });

    if (!authToken) {
      throw new Error(
        `Failed to create runtime token for task run ${taskRun.id}`,
      );
    }

    let dequeueSkipped = false;
    const fallbackComputeProvider = await resolveDefaultComputeProvider();

    await db.transaction(async (tx) => {
      const updatedRuns = await tx
        .update(taskRuns)
        .set({ status: RunStatus.Dequeued, dequeuedAt: new Date() })
        .where(
          and(
            eq(taskRuns.id, taskRun.id),
            eq(taskRuns.status, taskRun.status),
            isNull(taskRuns.canceledAt),
          ),
        )
        .returning();

      if (updatedRuns.length === 0) {
        dequeueSkipped = true;
        return;
      }

      await recordTaskRunLifecycleEvent(tx, {
        runId: taskRun.id,
        taskId: taskRun.taskId,
        eventType: 'decision',
        message:
          'Controller dequeued task run and handed it to provider dispatch.',
        details: {
          stage: 'controller_dequeue',
          status: RunStatus.Dequeued,
          provider: resolveComputeProviderTarget(
            taskRun.vendor,
            fallbackComputeProvider,
          ),
          environmentId: taskRun.payload.environmentId ?? null,
          machineId: taskRun.machineId ?? null,
        },
      });
    });

    if (dequeueSkipped) {
      const latestRun = await db.query.taskRuns.findFirst({
        where: eq(taskRuns.id, taskRun.id),
        columns: {
          status: true,
          canceledAt: true,
        },
      });

      if (latestRun?.canceledAt || latestRun?.status === RunStatus.Canceled) {
        return null;
      }

      if (!latestRun || latestRun.status !== taskRun.status) {
        return null;
      }

      throw new Error(
        `Task run ${taskRun.id}: failed to transition from ${taskRun.status} to ${RunStatus.Dequeued}`,
      );
    }

    return { taskRun, authToken };
  }

  protected async handleSpawnTaskRunError(
    taskRun: TaskRun,
    error: unknown,
  ): Promise<void> {
    const errorMessage = formatSpawnWorkerError(error);
    const errorCode =
      getTaskRunErrorCode(error) ?? classifyDockerSpawnError(errorMessage);

    // Drift signal: a docker spawn failure the classifiers no longer
    // recognize means the UI falls back to raw diagnostics.
    if (!errorCode && errorMessage.startsWith('Failed to run docker')) {
      console.warn(
        `[BaseController] Unclassified docker spawn failure for task run #${taskRun.id}`,
      );
    }

    // Report and rethrow a sanitized error so Sentry LinkedErrors never walks
    // a raw execFile/cause chain that embeds docker -e AUTH_TOKEN values.
    const reportError = new Error(errorMessage);

    captureControllerException(reportError, {
      runId: taskRun.id,
      payloadKind: taskRun.payloadKind,
      provider: taskRun.vendor,
      repo: taskRun.payload.repo,
      phase: 'spawn_worker',
    });

    console.error(
      `[BaseController] ❌ Error spawning ${taskRun.payloadKind} worker for task run #${taskRun.id}: ${errorMessage}`,
    );

    await this.finishFailedTaskRun(taskRun, errorMessage, errorCode);

    throw reportError;
  }

  /**
   * Atomically claims a detached worker exit as a bootstrap failure. The
   * worker's own dequeue transition races this conditional update, so a late
   * process exit cannot overwrite a run that reached processing.
   *
   * Returns true when the exit was claimed and provider cleanup is safe.
   */
  protected async handleWorkerExitBeforeStart(
    taskRun: TaskRun,
    exitCode: number,
  ): Promise<WorkerBootstrapExitDisposition> {
    if (await this.claimWorkerBootstrapRestart(taskRun, exitCode)) {
      this.workerBootstrapRestartsAwaitingCleanup.add(taskRun.id);
      return 'restart';
    }

    const errorMessage = `Worker process exited before claiming task run (exit code ${exitCode})`;
    const failed = await this.claimWorkerBootstrapFailure(
      taskRun,
      errorMessage,
      {
        message: 'Detached worker exited before claiming its task run',
        signal: 'worker-bootstrap-exit',
        exitCode,
      },
    );

    return failed ? 'failed' : 'ignore';
  }

  protected scheduleWorkerBootstrapRestart(taskRun: TaskRun): void {
    this.workerBootstrapRestartsAwaitingCleanup.delete(taskRun.id);

    const restartRun: TaskRun = {
      ...taskRun,
      status: RunStatus.Pending,
      dequeuedAt: null,
      machineId: null,
      machineDomain: null,
      machineDomains: null,
      primaryPortName: null,
      sandboxServerUrl: null,
      sandboxCmdId: null,
      proxyPorts: null,
      provisionStartedAt: null,
      provisionReadyAt: null,
    };

    if (!this.isRunning) {
      this.pendingWorkerBootstrapRestarts.set(taskRun.id, restartRun);
      console.log(
        `[BaseController] Queued worker bootstrap retry for task run #${taskRun.id} while the controller is stopped`,
      );
      return;
    }

    if (this.spawnWorkerInBackground(restartRun)) {
      console.log(
        `[BaseController] Retrying worker bootstrap for task run #${taskRun.id}`,
      );
      return;
    }

    this.pendingWorkerBootstrapRestarts.set(taskRun.id, restartRun);
    console.log(
      `[BaseController] Queued worker bootstrap retry for task run #${taskRun.id}`,
    );
  }

  protected async failTimedOutWorkerBootstraps(): Promise<number> {
    const overdueRuns = await db.query.taskRuns.findMany({
      where: and(
        eq(taskRuns.status, RunStatus.Dequeued),
        isNotNull(taskRuns.provisionReadyAt),
        lt(
          taskRuns.provisionReadyAt,
          new Date(Date.now() - WORKER_BOOTSTRAP_CLAIM_TIMEOUT_MS),
        ),
        isNull(taskRuns.startedAt),
        isNull(taskRuns.workerHeartbeatAt),
        isNull(taskRuns.canceledAt),
      ),
      orderBy: [asc(taskRuns.provisionReadyAt)],
    });

    const timeoutSeconds = Math.round(
      WORKER_BOOTSTRAP_CLAIM_TIMEOUT_MS / 1_000,
    );
    const errorMessage = `Worker did not claim task run within ${timeoutSeconds} seconds after the environment became ready`;
    let failedCount = 0;

    for (const taskRun of overdueRuns) {
      // provisionReadyAt is stamped before the final worker handoff. Do not
      // let the watchdog race a launch that this controller is still actively
      // completing (for example, environment OIDC priming).
      if (this.inFlightSpawns.has(taskRun.id)) {
        continue;
      }

      if (
        await this.claimWorkerBootstrapFailure(taskRun, errorMessage, {
          message: 'Worker did not claim its task run after provisioning',
          signal: 'worker-bootstrap-timeout',
        })
      ) {
        failedCount += 1;
      }
    }

    return failedCount;
  }

  protected async recoverPersistedWorkerBootstrapRestarts(): Promise<number> {
    const scheduledRuns = await findPersistedWorkerBootstrapRestarts();

    let recoveredCount = 0;

    for (const taskRun of scheduledRuns) {
      if (this.workerBootstrapRestartsAwaitingCleanup.has(taskRun.id)) {
        continue;
      }

      this.scheduleWorkerBootstrapRestart(taskRun);
      recoveredCount += 1;
    }

    return recoveredCount;
  }

  private async claimWorkerBootstrapFailure(
    taskRun: TaskRun,
    errorMessage: string,
    diagnostic: {
      message: string;
      signal: string;
      exitCode?: number;
    },
  ): Promise<boolean> {
    const now = new Date();
    const claimed = await db.transaction(async (tx) => {
      const updatedRuns = await tx
        .update(taskRuns)
        .set({
          status: RunStatus.Failed,
          error: errorMessage,
          completedAt: now,
        })
        .where(
          and(
            eq(taskRuns.id, taskRun.id),
            eq(taskRuns.status, RunStatus.Dequeued),
            isNull(taskRuns.startedAt),
            isNull(taskRuns.workerHeartbeatAt),
            isNull(taskRuns.canceledAt),
          ),
        )
        .returning({ id: taskRuns.id });

      if (updatedRuns.length === 0) {
        return false;
      }

      // Keep the task projection durable with the terminal run transition.
      // finishRun repeats this sync while applying notifications and cleanup,
      // but a later side-effect failure cannot leave the task active forever.
      await syncTaskStateFromRuns(tx, taskRun.taskId);
      return true;
    });

    if (!claimed) {
      console.log(
        `[BaseController] Ignoring worker bootstrap failure for task run #${taskRun.id} because the run already advanced`,
      );
      return false;
    }

    captureControllerMessage(
      diagnostic.message,
      {
        runId: taskRun.id,
        payloadKind: taskRun.payloadKind,
        provider: taskRun.vendor,
        ...(diagnostic.exitCode === undefined
          ? {}
          : { exitCode: diagnostic.exitCode }),
        phase: 'worker_bootstrap',
      },
      {
        component: 'worker-lifecycle',
        signal: diagnostic.signal,
      },
    );

    console.error(
      `[BaseController] ❌ ${errorMessage} for task run #${taskRun.id}`,
    );

    try {
      await this.finishFailedTaskRun(taskRun, errorMessage);
    } catch (error) {
      captureControllerException(error, {
        runId: taskRun.id,
        payloadKind: taskRun.payloadKind,
        provider: taskRun.vendor,
        phase: 'worker_bootstrap_finalize',
      });
      console.error(
        `[BaseController] Failed to complete bootstrap-failure side effects for task run #${taskRun.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return true;
  }

  private async claimWorkerBootstrapRestart(
    taskRun: TaskRun,
    exitCode: number,
  ): Promise<boolean> {
    const claimed = await db.transaction(async (tx) => {
      const [lockedRun] = await tx.execute<{ id: number }>(sql`
        SELECT id
        FROM task_runs
        WHERE id = ${taskRun.id}
          AND status = ${RunStatus.Dequeued}
          AND started_at IS NULL
          AND worker_heartbeat_at IS NULL
          AND canceled_at IS NULL
        FOR UPDATE
      `);

      if (!lockedRun) {
        return false;
      }

      const [previousRestart] = await tx.execute<{ id: string }>(sql`
        SELECT id
        FROM task_run_events
        WHERE run_id = ${taskRun.id}
          AND source = 'run_lifecycle'
          AND details ->> 'stage' = 'worker_bootstrap_restart'
        LIMIT 1
      `);

      if (previousRestart) {
        return false;
      }

      await tx
        .update(taskRuns)
        .set({
          status: RunStatus.Pending,
          dequeuedAt: null,
          machineId: null,
          machineDomain: null,
          machineDomains: null,
          primaryPortName: null,
          sandboxServerUrl: null,
          sandboxCmdId: null,
          proxyPorts: null,
          provisionStartedAt: null,
          provisionReadyAt: null,
        })
        .where(eq(taskRuns.id, taskRun.id));

      await recordTaskRunLifecycleEvent(tx, {
        runId: taskRun.id,
        taskId: taskRun.taskId,
        eventType: 'decision',
        message:
          'Controller scheduled one fresh sandbox after a worker bootstrap exit.',
        details: {
          stage: 'worker_bootstrap_restart',
          status: RunStatus.Pending,
          provider: taskRun.vendor ?? null,
          previousMachineId: taskRun.machineId ?? null,
          exitCode,
          restartAttempt: 1,
        },
      });

      return true;
    });

    if (!claimed) {
      return false;
    }

    captureControllerMessage(
      'Controller scheduled a fresh sandbox after worker bootstrap failure',
      {
        runId: taskRun.id,
        payloadKind: taskRun.payloadKind,
        provider: taskRun.vendor,
        exitCode,
        restartAttempt: 1,
        phase: 'worker_bootstrap',
      },
      {
        component: 'worker-lifecycle',
        signal: 'worker-bootstrap-restart',
      },
    );

    return true;
  }

  private async finishFailedTaskRun(
    taskRun: TaskRun,
    errorMessage: string,
    errorCode?: TaskRunErrorCodeValue,
  ): Promise<void> {
    // Use the centralized termination path so all side-effects (email, Slack,
    // Linear notifications, lock release, etc.) are applied consistently.
    await finishRun({
      id: taskRun.id,
      status: RunStatus.Failed,
      error: errorMessage,
      ...(errorCode ? { errorCode } : {}),
    });

    // Snapshot-specific: only fail snapshots that are currently pending.
    // Scheduled refreshes keep the last ready snapshot in place while the
    // replacement is being created, so spawn failures must not overwrite it.
    if (taskRun.payloadKind === TaskPayloadKind.SnapshotEnvironment) {
      const environmentId = taskRun.payload.environmentId;

      if (environmentId) {
        const provider = resolveComputeProviderTarget(
          taskRun.vendor,
          await resolveDefaultComputeProvider(),
        );
        const pendingSnapshotMatch =
          buildPendingEnvironmentSnapshotMatchForTaskRun(taskRun);
        await updatePendingEnvironmentSnapshot(db, {
          environmentId,
          provider,
          snapshotId: null,
          snapshotStatus: 'failed',
          snapshotCreatedAt: null,
          snapshotExpiresAt: null,
          ...pendingSnapshotMatch,
        });
      }
    }
  }
}
