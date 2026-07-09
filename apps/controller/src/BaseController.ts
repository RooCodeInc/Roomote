import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type ComputeProvider,
  CloudTaskStatus,
  CloudTaskType,
  resolveComputeProviderTarget,
  SANDBOX_ORPHAN_SCAN_INTERVAL_MS,
  SANDBOX_TIMEOUT_MS,
} from '@roomote/types';
import { createJobToken } from '@roomote/auth';
import { Env } from '@roomote/env';
import { getRedis, REDIS_KEYS } from '@roomote/redis';
import {
  type CloudJob,
  db,
  cloudJobs,
  buildPendingEnvironmentSnapshotMatchForCloudJob,
  recordJobLifecycleEvent,
  resolveDefaultComputeProvider,
  updatePendingEnvironmentSnapshot,
  eq,
  and,
  isNull,
} from '@roomote/db/server';
import {
  dequeueCloudTask,
  resolveCredentialUserIdForCloudJob,
} from '@roomote/cloud-agents/server';
import { finishCloudJob } from '@roomote/sdk/server';

import { getOrphanedJob } from './orphaned-cloud-jobs';
import {
  captureControllerException,
  captureControllerMessage,
} from './monitoring/sentry';
import { resolveFromWorkspaceRoot } from './repo-paths';

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

  /** Track in-flight spawn operations by job ID. */
  private inFlightSpawns = new Map<number, Promise<void>>();

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
    const orphanCheckInterval = SANDBOX_ORPHAN_SCAN_INTERVAL_MS;

    console.log('Looping for jobs...');

    while (this.isRunning) {
      this.isProcessingIteration = true;

      try {
        await getRedis().set(
          REDIS_KEYS.CONTROLLER_HEARTBEAT,
          Date.now().toString(),
          'EX',
          this.HEARTBEAT_TTL_SECONDS,
        );

        if (this.inFlightSpawns.size >= this.MAX_CONCURRENT_SPAWNS) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          continue;
        }

        const id = await dequeueCloudTask();

        if (id) {
          const cloudJob = await db.query.cloudJobs.findFirst({
            where: eq(cloudJobs.id, id),
          });

          if (cloudJob) {
            // Spawn worker in background to avoid blocking the main loop.
            // The spawnWorkerInBackground method handles errors and cleanup.
            if (this.spawnWorkerInBackground(cloudJob)) {
              console.log(
                `🎯 New job from redis: job #${cloudJob.id} of type ${cloudJob.type} in ${cloudJob.payload.repo} (in-flight: ${this.inFlightSpawns.size})`,
              );
            }
          } else {
            console.error(`❌ No cloud job record found for id ${id}`);
          }
        } else {
          const now = Date.now();

          const isOrphanCheckDue =
            now - lastOrphanCheckAt > orphanCheckInterval;

          if (isOrphanCheckDue) {
            lastOrphanCheckAt = now;
            const cloudJob = await getOrphanedJob();

            if (cloudJob && this.spawnWorkerInBackground(cloudJob)) {
              captureControllerMessage(
                'Controller started task using database fallback logic',
                {
                  jobId: cloudJob.id,
                  jobStatus: cloudJob.status,
                  jobType: cloudJob.type,
                  provider: cloudJob.vendor,
                  repo: cloudJob.payload.repo,
                  phase: 'database_fallback',
                  source: 'orphaned_job_scan',
                },
                {
                  component: 'dequeue-loop',
                  signal: 'database-fallback-task-start',
                },
              );

              console.log(
                `🎯 New job from database: job #${cloudJob.id} of type ${cloudJob.type} in ${cloudJob.payload.repo} (in-flight: ${this.inFlightSpawns.size})`,
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
          `🚨 Caught error in dequeueCloudTask / spawnWorker loop: ${error instanceof Error ? error.message : String(error)}`,
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
    cloudJob: CloudJob,
    authToken: string,
    deploymentSlug: string,
    sandboxTimeoutMs: number,
    provider: ComputeProvider,
  ): Promise<void>;

  protected async spawnWorker(cloudJob: CloudJob): Promise<void> {
    try {
      const dequeuedJob = await this.dequeueCloudJob(cloudJob);

      if (!dequeuedJob) {
        console.log(
          `[BaseController] Skipping spawn for job #${cloudJob.id} because it left the dequeueable state before dispatch`,
        );

        return;
      }

      const { authToken } = dequeuedJob;
      const provider = resolveComputeProviderTarget(
        cloudJob.vendor,
        await resolveDefaultComputeProvider(),
      );
      const sandboxTimeoutMs = SANDBOX_TIMEOUT_MS;

      await this.spawnFreshWorker(
        cloudJob,
        authToken,
        'deployment',
        sandboxTimeoutMs,
        provider,
      );
    } catch (error) {
      await this.handleSpawnJobError(cloudJob, error);
    }
  }

  private spawnWorkerInBackground(cloudJob: CloudJob): boolean {
    if (this.inFlightSpawns.has(cloudJob.id)) {
      console.warn(
        `[BaseController] Job #${cloudJob.id} is already being spawned, skipping`,
      );

      return false;
    }

    if (this.inFlightSpawns.size >= this.MAX_CONCURRENT_SPAWNS) {
      console.warn(
        `[BaseController] Max concurrent spawns (${this.MAX_CONCURRENT_SPAWNS}) reached, skipping job #${cloudJob.id}`,
      );

      return false;
    }

    const spawnStartedAt = Date.now();

    const progressLogInterval = setInterval(() => {
      console.warn(
        `[BaseController] Worker spawn still in progress for job #${cloudJob.id} after ${Date.now() - spawnStartedAt}ms`,
      );
    }, this.LOG_INTERVAL_MS);

    const spawnPromise = this.spawnWorker(cloudJob)
      .then(() => {
        console.log(
          `[BaseController] ✅ Worker spawned successfully for job #${cloudJob.id} in ${Date.now() - spawnStartedAt}ms`,
        );
      })
      .catch((error) => {
        // Error is already handled in handleSpawnJobError, just log here.
        console.error(
          `[BaseController] ❌ Worker spawn failed for job #${cloudJob.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        clearInterval(progressLogInterval);
        this.inFlightSpawns.delete(cloudJob.id);
      });

    this.inFlightSpawns.set(cloudJob.id, spawnPromise);

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

  protected async dequeueCloudJob(
    cloudJob: CloudJob,
  ): Promise<{ cloudJob: CloudJob; authToken: string } | null> {
    const userId = await resolveCredentialUserIdForCloudJob(cloudJob);

    if (!userId) {
      throw new Error(
        `Job ${cloudJob.id}: cannot resolve a user for job token creation`,
      );
    }

    const sandboxTimeoutMs = SANDBOX_TIMEOUT_MS;

    const authToken = await createJobToken({
      cloudJobId: cloudJob.id,
      userId,
      timeoutMs: sandboxTimeoutMs,
    });

    if (!authToken) {
      throw new Error(
        `Failed to create job token for job ${cloudJob.id} from user ${userId}`,
      );
    }

    let dequeueSkipped = false;
    const fallbackComputeProvider = await resolveDefaultComputeProvider();

    await db.transaction(async (tx) => {
      const updatedJobs = await tx
        .update(cloudJobs)
        .set({ status: CloudTaskStatus.Dequeued, dequeuedAt: new Date() })
        .where(
          and(
            eq(cloudJobs.id, cloudJob.id),
            eq(cloudJobs.status, cloudJob.status),
            isNull(cloudJobs.canceledAt),
          ),
        )
        .returning();

      if (updatedJobs.length === 0) {
        dequeueSkipped = true;
        return;
      }

      await recordJobLifecycleEvent(tx, {
        cloudJobId: cloudJob.id,
        taskId: cloudJob.taskId,
        eventType: 'decision',
        message:
          'Controller dequeued cloud job and handed it to provider dispatch.',
        details: {
          stage: 'controller_dequeue',
          status: CloudTaskStatus.Dequeued,
          provider: resolveComputeProviderTarget(
            cloudJob.vendor,
            fallbackComputeProvider,
          ),
          environmentId: cloudJob.payload.environmentId ?? null,
          machineId: cloudJob.machineId ?? null,
        },
      });
    });

    if (dequeueSkipped) {
      const latestJob = await db.query.cloudJobs.findFirst({
        where: eq(cloudJobs.id, cloudJob.id),
        columns: {
          status: true,
          canceledAt: true,
        },
      });

      if (
        latestJob?.canceledAt ||
        latestJob?.status === CloudTaskStatus.Canceled
      ) {
        return null;
      }

      if (!latestJob || latestJob.status !== cloudJob.status) {
        return null;
      }

      throw new Error(
        `Job ${cloudJob.id}: failed to transition from ${cloudJob.status} to ${CloudTaskStatus.Dequeued}`,
      );
    }

    return { cloudJob, authToken };
  }

  protected async handleSpawnJobError(
    cloudJob: CloudJob,
    error: unknown,
  ): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);

    captureControllerException(error, {
      jobId: cloudJob.id,
      jobType: cloudJob.type,
      provider: cloudJob.vendor,
      repo: cloudJob.payload.repo,
      phase: 'spawn_worker',
    });

    console.error(
      `[BaseController] ❌ Error spawning ${cloudJob.type} worker for job #${cloudJob.id}: ${errorMessage}`,
    );

    // Use the centralized termination path so all side-effects (email, Slack,
    // Linear notifications, lock release, etc.) are applied consistently.
    await finishCloudJob({
      id: cloudJob.id,
      status: CloudTaskStatus.Failed,
      error: errorMessage,
    });

    // Snapshot-specific: only fail snapshots that are currently pending.
    // Scheduled refreshes keep the last ready snapshot in place while the
    // replacement is being created, so spawn failures must not overwrite it.
    if (cloudJob.type === CloudTaskType.SnapshotEnvironment) {
      const environmentId = cloudJob.payload.environmentId;

      if (environmentId) {
        const provider = resolveComputeProviderTarget(
          cloudJob.vendor,
          await resolveDefaultComputeProvider(),
        );
        const pendingSnapshotMatch =
          buildPendingEnvironmentSnapshotMatchForCloudJob(cloudJob);
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

    throw error;
  }
}
