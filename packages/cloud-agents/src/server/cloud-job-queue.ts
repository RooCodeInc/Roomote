import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  type AuthorshipRuleActor,
  type CloudTask,
  type CloudTaskPayload,
  type CodingHarness,
  type ComputeProvider,
  type HarnessModelOverrides,
  type CloudTaskLaunchClass,
  type RequestedWorkKind,
  CloudTaskStatus,
  CloudTaskType,
  DEFAULT_DELEGATED_KEEPALIVE_MS,
  DEFAULT_KEEPALIVE_MS,
  DEFAULT_LAUNCH_CODING_HARNESS,
  getUserDisplayName,
  getSlackThreadTsFromTaskPayload,
  getPrimaryPortFromConfig,
  isPrReviewJob,
  isConfiguredEnvValue,
  normalizeDeploymentModelConfig,
  resolveCloudTaskRuntimePolicy,
  resolveCloudTaskWorkspace,
  resolveComputeProviderTarget,
  resolveSourceControlProviderFromPayload,
  TASK_TIMEOUT_MS,
  type SourceControlProvider,
  isKnownAutomationTaskType,
  resolveTaskAutomationDisplayName,
} from '@roomote/types';
import { Env } from '@roomote/env';
import {
  type CloudJob,
  type DatabaseTransaction,
  type TaskAttributionSnapshot,
  db,
  deploymentSettings,
  buildTaskAttributionSnapshot,
  createTaskWithRetry,
  cloudJobs,
  markTaskStartParallelCountEndedAt,
  recordTaskStartParallelCount,
  taskPullRequests,
  tasks,
  users,
  environments,
  and,
  desc,
  eq,
  findLatestGithubIdentityForUser,
  inArray,
  isNull,
  lt,
  recordSnapshotResumeEvent,
  resolveDefaultComputeProvider,
  sql,
} from '@roomote/db/server';
import {
  evaluateFeatureFlagFromMetadata,
  FeatureFlag,
  type MetadataRecord,
} from '@roomote/feature-flags/server';

import { type Redis, getRedis } from '@roomote/redis';
import { captureEvent } from '@roomote/telemetry/server';
import { generateCloudJobTitle, hasDeterministicCloudJobTitle } from '../utils';
import { DEFAULT_STANDARD_TASK_PROVIDER } from '../task-runtime-defaults';
import { evaluateEffectiveAuthorship } from './authorship-rules';
import { resolveEffectiveHarnessModelState } from './harness-model-overrides';
import {
  generateLlmTaskTitle,
  isFallbackTaskTitle,
  LLM_TITLE_LOCKED_CHECKPOINT,
} from './llm-task-title';
import { resolveRequestedWorkKindDecision } from './router/requested-work-kind';

enum CloudJobQueueKeys {
  Queue = 'queue:cloud-jobs',
}

const cloudJobQueueEntrySchema = z.object({
  id: z.number(),
  scope: z.string(),
});

export type CloudJobQueueEntry = z.infer<typeof cloudJobQueueEntrySchema>;

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return fallback;
}

async function cancelCloudJobBeforeQueue(
  cloudJob: CloudJob,
  message: string,
  failureContext: string,
): Promise<void> {
  try {
    await db
      .update(cloudJobs)
      .set({
        status: CloudTaskStatus.Canceled,
        canceledAt: new Date(),
        error: message,
      })
      .where(eq(cloudJobs.id, cloudJob.id));
  } catch (cancelError) {
    console.warn(
      `[enqueueCloudTask] Failed to cancel cloud job ${cloudJob.id} after ${failureContext}: ${getErrorMessage(
        cancelError,
        'Unknown cancellation error',
      )}`,
    );
  }
}

async function resolvePersistedTaskAttributionSnapshot(
  tx: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  task: CloudTask,
): Promise<TaskAttributionSnapshot> {
  if (task.attributionOverride?.kind === 'automatic') {
    const overrideDisplayName =
      typeof task.attributionOverride.displayName === 'string'
        ? task.attributionOverride.displayName.trim()
        : '';
    return {
      attributionKind: 'automatic',
      attributedUserId: null,
      attributionSourceKind:
        task.attributionOverride.sourceKind ?? 'automation',
      attributionSourceDisplayName:
        overrideDisplayName || resolveTaskAutomationDisplayName(task) || null,
      attributionSourceExternalId: null,
      attributedGithubLogin: null,
      attributedGithubUserId: null,
    };
  }

  return buildTaskAttributionSnapshot(tx, task);
}

async function resolveMatchedHumanActor(
  tx: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  attributedUserId: string | null,
): Promise<AuthorshipRuleActor | null> {
  if (!attributedUserId) {
    return null;
  }

  const user = await tx.query.users.findFirst({
    where: eq(users.id, attributedUserId),
    columns: {
      id: true,
      name: true,
      email: true,
    },
  });

  const githubIdentity = await findLatestGithubIdentityForUser(
    tx,
    attributedUserId,
  );

  return {
    userId: attributedUserId,
    displayName: getUserDisplayName(user),
    githubLogin: githubIdentity.githubLogin,
    githubUserId: githubIdentity.githubUserId,
  };
}

function isRoomoteDeploymentDisabled(metadata: unknown): boolean {
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    'deployment_disabled' in metadata &&
    metadata.deployment_disabled === true
  );
}

type ResolvedHarnessSelection = {
  harness: CodingHarness;
  deploymentMetadata?: MetadataRecord | null;
  deploymentTaskModelSettings?:
    | import('@roomote/types').TaskModelSettings
    | null;
  deploymentCodeReviewModelId?: string | null;
};

const DEFAULT_DEPLOYMENT_ID = 'default';

async function assertDeploymentIsActive(): Promise<void> {
  const deployment = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: {
      metadata: true,
    },
  });

  if (isRoomoteDeploymentDisabled(deployment?.metadata)) {
    throw new Error('Cannot create cloud task for disabled deployment.');
  }
}

function resolveCodeReviewModelId(
  persistedConfig: import('@roomote/types').DeploymentModelConfig,
): string | null {
  const envCodeReviewModel = isConfiguredEnvValue(
    process.env.ROOMOTE_CODE_REVIEW_MODEL,
  )
    ? process.env.ROOMOTE_CODE_REVIEW_MODEL!.trim()
    : null;

  return envCodeReviewModel ?? persistedConfig.roomoteCodeReviewModel;
}

async function resolveRequestedHarness(
  task: CloudTask,
): Promise<ResolvedHarnessSelection> {
  if (task.harness) {
    const deployment = await db.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
      columns: {
        metadata: true,
        taskModelSettings: true,
        runtimeModelConfig: true,
      },
    });

    return {
      harness: task.harness,
      deploymentMetadata:
        (deployment?.metadata as MetadataRecord | null | undefined) ?? null,
      deploymentTaskModelSettings: deployment?.taskModelSettings ?? null,
      deploymentCodeReviewModelId: resolveCodeReviewModelId(
        normalizeDeploymentModelConfig(deployment?.runtimeModelConfig),
      ),
    };
  }

  const deployment = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: {
      metadata: true,
      taskModelSettings: true,
      runtimeModelConfig: true,
    },
  });

  return {
    harness: DEFAULT_LAUNCH_CODING_HARNESS,
    deploymentMetadata:
      (deployment?.metadata as MetadataRecord | null | undefined) ?? null,
    deploymentTaskModelSettings: deployment?.taskModelSettings ?? null,
    deploymentCodeReviewModelId: resolveCodeReviewModelId(
      normalizeDeploymentModelConfig(deployment?.runtimeModelConfig),
    ),
  };
}

function getRequestedWorkKindPrompt(task: CloudTask): string | undefined {
  switch (task.type) {
    case CloudTaskType.StandardTask:
      return task.payload.description;
    case CloudTaskType.SlackAppMention:
      return task.payload.text;
    case CloudTaskType.LinearAgentSession:
      return (
        task.payload.commentBody ||
        task.payload.issueDescription ||
        task.payload.issueTitle
      );
    default:
      return undefined;
  }
}

function getRequestedWorkKindBootstrapSkill(
  task: CloudTask,
): 'explain-repo-code' | 'plan-repo-implementation' | undefined {
  if (task.type !== CloudTaskType.StandardTask) {
    return undefined;
  }

  return task.payload.bootstrap?.skill;
}

export class CloudJobQueue {
  private redis: Redis;
  private readonly timeout: number;

  constructor({ redis, timeout = 10 }: { redis: Redis; timeout?: number }) {
    this.redis = redis;
    this.timeout = timeout;

    if (timeout < 1 || timeout > 30) {
      throw new Error('Timeout must be between 1 and 30 seconds.');
    }
  }

  public async enqueue(entry: CloudJobQueueEntry): Promise<void> {
    const entries = await this.redis.lrange(CloudJobQueueKeys.Queue, 0, -1);

    // Discard entries with the same scope.
    for (const rawValue of entries) {
      try {
        const otherEntry = cloudJobQueueEntrySchema.parse(JSON.parse(rawValue));

        if (otherEntry.scope === entry.scope) {
          await this.redis.lrem(CloudJobQueueKeys.Queue, 0, rawValue);

          // Best-effort cancel in DB; do not block queue behavior during dedup.
          void db
            .transaction(async (tx) => {
              const endedAt = new Date();

              await tx
                .update(cloudJobs)
                .set({
                  status: CloudTaskStatus.Canceled,
                  canceledAt: endedAt,
                  error: 'Superseded by a newer cloud job.',
                })
                .where(eq(cloudJobs.id, otherEntry.id));

              await markTaskStartParallelCountEndedAt(tx, {
                cloudJobId: otherEntry.id,
                endedAt,
              });
            })
            .catch(() => {
              // Ignore DB errors here; deduplication should proceed regardless.
            });

          console.log(
            `[CloudJobQueue] evicted ${otherEntry.id} (${otherEntry.scope})`,
          );
        }
      } catch {
        // Ignore invalid entries.
      }
    }

    await this.redis.rpush(CloudJobQueueKeys.Queue, JSON.stringify(entry));
  }

  public async dequeue(blocking = true): Promise<CloudJobQueueEntry | null> {
    const seen = new Set<number>();

    while (true) {
      const rawValue = blocking
        ? (await this.redis.blpop(CloudJobQueueKeys.Queue, this.timeout))?.[1]
        : await this.redis.lpop(CloudJobQueueKeys.Queue);

      if (!rawValue) {
        return null;
      }

      let entry;

      try {
        entry = cloudJobQueueEntrySchema.parse(JSON.parse(rawValue));
      } catch {
        continue;
      }

      if (seen.has(entry.id)) {
        await this.enqueue(entry);
        return null;
      }

      seen.add(entry.id);

      if (await this.acquireLock(entry)) {
        console.log(`[CloudJobQueue] acquired lock for ${entry.scope}`);
        return entry;
      }

      await this.enqueue(entry);
    }
  }

  private async acquireLock(entry: CloudJobQueueEntry): Promise<boolean> {
    const result = await this.redis.set(
      entry.scope,
      entry.id,
      'EX',
      Math.ceil(TASK_TIMEOUT_MS / 1000), // TTL in seconds - 1h.
      'NX',
    );

    return result === 'OK';
  }

  public async releaseLock(scope: string): Promise<boolean> {
    const result = await this.redis.del(scope);
    return result === 1;
  }

  public async isLocked(scope: string): Promise<boolean> {
    const result = await this.redis.get(scope);
    return result !== null;
  }

  public async getLockTTL(scope: string): Promise<number> {
    const ttl = await this.redis.ttl(scope);
    return ttl;
  }

  static queue: CloudJobQueue | null = null;

  static getInstance(): CloudJobQueue {
    if (!CloudJobQueue.queue) {
      CloudJobQueue.queue = new CloudJobQueue({ redis: getRedis() });
    }

    return CloudJobQueue.queue;
  }
}

export class CloudJobQueueEnqueueError extends Error {
  public readonly cloudJobId: number;
  public readonly taskId: string;
  public readonly originalError: unknown;

  constructor(params: {
    cloudJobId: number;
    taskId: string;
    originalError: unknown;
  }) {
    super(
      `Failed to enqueue cloud job ${params.cloudJobId}: ${getErrorMessage(
        params.originalError,
        'Unknown queue error',
      )}`,
    );
    this.name = 'CloudJobQueueEnqueueError';
    this.cloudJobId = params.cloudJobId;
    this.taskId = params.taskId;
    this.originalError = params.originalError;
  }
}

const NULL_AGENT_LINEAGE_TASK_TYPES = [
  CloudTaskType.StandardTask,
  CloudTaskType.SlackAppMention,
  CloudTaskType.LinearAgentSession,
  CloudTaskType.SnapshotResume,
] as const;

type EnvironmentMatch = { id: string; isPrimary: boolean; repoCount: number };

async function findMatchingEnvironments(
  repoFullName: string,
): Promise<EnvironmentMatch[]> {
  const envs = await db.query.environments.findMany({
    where: eq(environments.isEval, false),
    columns: { id: true, config: true },
  });

  const matches: EnvironmentMatch[] = [];

  for (const env of envs) {
    const repos = env.config?.repositories ?? [];

    const index = repos.findIndex(
      (r) => r.repository.toLowerCase() === repoFullName.toLowerCase(),
    );

    if (index >= 0) {
      matches.push({
        id: env.id,
        isPrimary: index === 0,
        repoCount: repos.length,
      });
    }
  }

  return matches;
}

async function findLineageEnvironmentForPr({
  repoFullName,
  prNumber,
  candidateEnvironmentIds,
  sourceControlProvider = 'github',
}: {
  repoFullName: string;
  prNumber: number;
  candidateEnvironmentIds: string[];
  sourceControlProvider?: SourceControlProvider;
}): Promise<string | undefined> {
  if (candidateEnvironmentIds.length === 0) {
    return undefined;
  }

  const rows = await db
    .select({
      environmentId: sql<string>`${cloudJobs.payload}->>'environmentId'`,
    })
    .from(taskPullRequests)
    .innerJoin(tasks, eq(tasks.id, taskPullRequests.taskId))
    .innerJoin(cloudJobs, eq(cloudJobs.taskId, tasks.id))
    .where(
      and(
        eq(taskPullRequests.sourceControlProvider, sourceControlProvider),
        eq(taskPullRequests.repository, repoFullName),
        eq(taskPullRequests.prNumber, prNumber),
        inArray(cloudJobs.type, [...NULL_AGENT_LINEAGE_TASK_TYPES]),
        sql`${cloudJobs.payload}->>'environmentId' IS NOT NULL`,
      ),
    )
    .orderBy(desc(taskPullRequests.detectedAt), desc(cloudJobs.createdAt));

  const candidateSet = new Set(candidateEnvironmentIds);

  return rows.find(({ environmentId }) => candidateSet.has(environmentId))
    ?.environmentId;
}

async function findHistoricalEnvironmentForRepo({
  repoFullName,
  candidateEnvironmentIds,
  sourceControlProvider = 'github',
}: {
  repoFullName: string;
  candidateEnvironmentIds: string[];
  sourceControlProvider?: SourceControlProvider;
}): Promise<string | undefined> {
  if (candidateEnvironmentIds.length === 0) {
    return undefined;
  }

  const payloadRepo = sql<string>`${cloudJobs.payload}->>'repo'`;

  const rows = await db
    .select({
      environmentId: sql<string>`${cloudJobs.payload}->>'environmentId'`,
      createdAt: cloudJobs.createdAt,
    })
    .from(cloudJobs)
    .innerJoin(tasks, eq(tasks.id, cloudJobs.taskId))
    .where(
      and(
        inArray(cloudJobs.type, [...NULL_AGENT_LINEAGE_TASK_TYPES]),
        inArray(
          sql<string>`${cloudJobs.payload}->>'environmentId'`,
          candidateEnvironmentIds,
        ),
        sql`(
          ${payloadRepo} = ${repoFullName}
          OR EXISTS (
            SELECT 1
            FROM ${taskPullRequests}
            WHERE ${taskPullRequests.taskId} = ${cloudJobs.taskId}
              AND ${taskPullRequests.sourceControlProvider} = ${sourceControlProvider}
              AND ${taskPullRequests.repository} = ${repoFullName}
          )
        )`,
      ),
    );

  const counts = new Map<string, { count: number; lastUsedAt: number }>();

  for (const { environmentId, createdAt } of rows) {
    const current = counts.get(environmentId) ?? {
      count: 0,
      lastUsedAt: 0,
    };

    current.count += 1;
    current.lastUsedAt = Math.max(current.lastUsedAt, createdAt.getTime());
    counts.set(environmentId, current);
  }

  let best: { id: string; count: number; lastUsedAt: number } | undefined;

  for (const [id, stats] of counts) {
    if (
      !best ||
      stats.count > best.count ||
      (stats.count === best.count && stats.lastUsedAt > best.lastUsedAt)
    ) {
      best = { id, ...stats };
    }
  }

  return best?.id;
}

/**
 * Finds the best-matching environment for a given repository.
 *
 * Disambiguation strategy for PR Reviewer/Fixer tasks:
 * 1. Prefer exact lineage from a delegated task that created the PR
 * 2. Otherwise prefer the environment with the most historical delegated-task jobs
 * 3. Fall back to environments where the repo is primary (first-listed)
 * 4. Among remaining ties, prefer fewer repositories (most specific)
 *
 * @returns The environment ID if found, undefined otherwise
 */
export async function findEnvironmentForRepo(
  repoFullName: string,
  prNumber?: number,
  sourceControlProvider?: SourceControlProvider,
): Promise<string | undefined> {
  const matches = await findMatchingEnvironments(repoFullName);

  if (matches.length === 0) return undefined;

  if (matches.length === 1) {
    return matches[0]!.id;
  }

  if (prNumber !== undefined) {
    const candidateEnvironmentIds = matches.map(({ id }) => id);

    const lineageEnvironmentId = await findLineageEnvironmentForPr({
      repoFullName,
      prNumber,
      candidateEnvironmentIds,
      sourceControlProvider,
    });

    if (lineageEnvironmentId) {
      return lineageEnvironmentId;
    }

    const historicalEnvironmentId = await findHistoricalEnvironmentForRepo({
      repoFullName,
      candidateEnvironmentIds,
      sourceControlProvider,
    });

    if (historicalEnvironmentId) {
      return historicalEnvironmentId;
    }
  }

  // Sort: primary matches first, then fewest repos
  matches.sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) {
      return a.isPrimary ? -1 : 1;
    }

    return a.repoCount - b.repoCount;
  });

  return matches[0]!.id;
}

export interface EnqueueCloudTaskOptions {
  /**
   * Optional launch-class hint used only to resolve runtime keepalive policy.
   */
  launchClass?: CloudTaskLaunchClass;
  /**
   * Keep the job owner for authorization, but leave `actingUserId` unset until
   * a real follow-up sender can be resolved.
   */
  skipInitialActingUser?: boolean;
  /**
   * Persist the job without pushing it onto the controller Redis queue.
   * Intended for direct-run jobs that are claimed by an explicitly invoked
   * worker command inside an already-running sandbox.
   */
  enqueue?: boolean;
  /**
   * Initial persisted status for the new job. Defaults to `pending`, matching
   * normal queue-driven launches.
   */
  initialStatus?: CloudTaskStatus.Pending | CloudTaskStatus.Dequeued;
  /**
   * Avoid best-effort LLM title generation for short-lived synthetic jobs.
   */
  skipEarlyTitleGeneration?: boolean;
  /**
   * Runs inside the cloud-job creation transaction after the new job row is
   * inserted and before the transaction commits.
   */
  afterCreateInTransaction?: (
    tx: DatabaseTransaction,
    cloudJob: CloudJob,
  ) => Promise<void>;
  /**
   * Runs after the cloud job row is created but before it is pushed onto the
   * controller queue. If this throws, the job is canceled and never queued.
   */
  beforeEnqueue?: (cloudJob: CloudJob) => Promise<void>;
}

export async function enqueueCloudTask(
  task: CloudTask,
  options: EnqueueCloudTaskOptions = {},
): Promise<CloudJob> {
  const { userId } = task;
  const slackThreadTs = resolveSlackThreadTs(task);

  const githubUserId = 'githubUserId' in task ? task.githubUserId : undefined;

  const snapshotResumeSourceCloudJobId =
    task.type === CloudTaskType.SnapshotResume
      ? (task.sourceCloudJobId ?? task.payload.sourceCloudJobId)
      : null;

  const snapshotResumeSourceSnapshotId =
    task.type === CloudTaskType.SnapshotResume
      ? (task.sourceSnapshotId ?? task.payload.sourceSnapshotId)
      : null;

  await assertDeploymentIsActive();

  // Automation-initiated tasks carry no stamped user id. Their attribution is
  // the automation name, and credential resolution happens lazily at job-token
  // mint time via `resolveCredentialUserIdForCloudJob`.
  const isAutomationInitiated =
    task.attributionOverride?.kind === 'automatic' ||
    isKnownAutomationTaskType(task.type);

  if (!userId && !githubUserId && !isAutomationInitiated) {
    throw new Error(
      'A cloud task must have a userId or a githubUserId, or be initiated by a known automation.',
    );
  }

  if (userId) {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { deletedAt: true },
    });

    if (user?.deletedAt) {
      throw new Error('Cannot create cloud task for deleted user.');
    }
  }

  // Auto-resolve environment for PR tasks when no environmentId is set.
  // This allows PR Reviewer review/follow-up jobs to benefit from project
  // configuration
  // (setup commands, env vars, services, agent instructions).
  const PR_TASK_TYPES = new Set([
    CloudTaskType.GithubPrReview,
    CloudTaskType.GithubPrReviewSync,
    CloudTaskType.GithubPrReviewFollowUp,
  ]);
  const workspace = resolveCloudTaskWorkspace(task.payload);

  if (
    PR_TASK_TYPES.has(task.type) &&
    !task.payload.environmentId &&
    workspace.type === 'repository'
  ) {
    const envId = await findEnvironmentForRepo(
      workspace.repo,
      'prNumber' in task.payload ? task.payload.prNumber : undefined,
    );

    if (envId) {
      task.payload.environmentId = envId;

      console.log(
        `[enqueueCloudTask] Auto-resolved environment ${envId} for ${workspace.repo}`,
      );
    }
  }

  let environment:
    | Pick<typeof environments.$inferSelect, 'id' | 'config'>
    | undefined;
  let initialPaths: Record<string, string> | undefined;

  if (task.payload.environmentId) {
    environment = await db.query.environments.findFirst({
      where: eq(environments.id, task.payload.environmentId),
      columns: {
        id: true,
        config: true,
      },
    });

    if (!environment) {
      throw new Error('Selected environment was not found.');
    }

    const primaryPort = getPrimaryPortFromConfig(environment.config.ports);
    if (!task.payload.port && primaryPort) {
      task.payload.port = primaryPort.port;
    }

    if (environment.config.ports) {
      const paths = Object.fromEntries(
        environment.config.ports
          .filter((port) => Boolean(port.initial_path))
          .map((port) => [port.name.toUpperCase(), port.initial_path!]),
      );

      if (Object.keys(paths).length > 0) {
        initialPaths = paths;
      }
    }
  }

  const prSourceControlProvider: SourceControlProvider =
    resolveSourceControlProviderFromPayload(task.payload);

  switch (task.type) {
    case CloudTaskType.GithubPrReview:
    case CloudTaskType.GithubPrReviewSync:
      task.prSourceControlProvider = prSourceControlProvider;
      task.prRepo = task.payload.repo;
      task.prNumber = task.payload.prNumber;
      task.prSha = task.payload.headSha;
      break;
    case CloudTaskType.GithubPrReviewFollowUp:
      task.prSourceControlProvider = prSourceControlProvider;
      task.prRepo = task.payload.repo;
      task.prNumber = task.payload.prNumber;
      break;
    case CloudTaskType.GithubPrConflictResolve:
      task.prSourceControlProvider = prSourceControlProvider;
      task.prRepo = task.payload.repo;
      task.prNumber = task.payload.prNumber;
      break;
    default:
      break;
  }

  // Determine canonical internal task ID and harness:
  // - SnapshotResume jobs inherit both from the source job when available.
  // - New jobs get a newly created task record.
  let internalTaskId: string | null = null;
  let sourceJobHarness: CloudTask['harness'] | null = null;
  let sourceJobVendor: ComputeProvider | null = null;
  let sourceJobHarnessInstructions: string | null = null;
  let sourceJobRequestedWorkKind: RequestedWorkKind | null = null;
  let sourceJobHarnessModelOverrides: HarnessModelOverrides | undefined;
  let sourceJobGithubPrRepo: string | null = null;
  let sourceJobGithubPrNumber: number | null = null;
  let sourceJobGithubPrSha: string | null = null;
  let sourceJobPrSourceControlProvider: SourceControlProvider | null = null;

  if (
    task.type === CloudTaskType.SnapshotResume &&
    task.payload.sourceCloudJobId
  ) {
    const sourceJob = await db.query.cloudJobs.findFirst({
      where: eq(cloudJobs.id, task.payload.sourceCloudJobId),
      columns: {
        taskId: true,
        harness: true,
        vendor: true,
        harnessInstructions: true,
        requestedWorkKind: true,
        prSourceControlProvider: true,
        prRepo: true,
        prNumber: true,
        prSha: true,
        payload: true,
      },
    });

    internalTaskId = sourceJob?.taskId ?? null;
    sourceJobHarness = sourceJob?.harness ?? null;
    sourceJobVendor = resolveComputeProviderTarget(sourceJob?.vendor);
    sourceJobHarnessInstructions = sourceJob?.harnessInstructions ?? null;
    sourceJobRequestedWorkKind = sourceJob?.requestedWorkKind ?? null;
    sourceJobPrSourceControlProvider =
      sourceJob?.prSourceControlProvider ?? null;
    sourceJobGithubPrRepo = sourceJob?.prRepo ?? null;
    sourceJobGithubPrNumber = sourceJob?.prNumber ?? null;
    sourceJobGithubPrSha = sourceJob?.prSha ?? null;
    sourceJobHarnessModelOverrides = sourceJob?.payload?.harnessModelOverrides;
  }

  if (task.type === CloudTaskType.SnapshotResume) {
    task.prSourceControlProvider =
      task.prSourceControlProvider ??
      sourceJobPrSourceControlProvider ??
      'github';
    task.prRepo = task.prRepo ?? sourceJobGithubPrRepo;
    task.prNumber = task.prNumber ?? sourceJobGithubPrNumber;
    task.prSha = task.prSha ?? sourceJobGithubPrSha;
  }

  const resolvedHarness = await resolveRequestedHarness(task);
  const targetHarness = sourceJobHarness ?? resolvedHarness.harness;
  const { task: taskWithHarnessOverrides, model: effectiveTaskModel } =
    resolveEffectiveHarnessModelState({
      task,
      targetHarness,
      isSnapshotResume: task.type === CloudTaskType.SnapshotResume,
      sourceJobHarnessModelOverrides,
      deploymentMetadata: resolvedHarness.deploymentMetadata,
      deploymentTaskModelSettings: resolvedHarness.deploymentTaskModelSettings,
      deploymentCodeReviewModelId:
        resolvedHarness.deploymentCodeReviewModelId ?? null,
    });

  const repositoryName = taskWithHarnessOverrides.payload.repo || null;
  const resolvedTaskPolicy = resolveCloudTaskRuntimePolicy({
    taskType: taskWithHarnessOverrides.type,
    launchClass: options.launchClass,
    appEnv: Env.APP_ENV ?? 'development',
    defaultKeepaliveMs: DEFAULT_KEEPALIVE_MS,
    delegatedKeepaliveMs: DEFAULT_DELEGATED_KEEPALIVE_MS,
    sandboxTimeoutMs: TASK_TIMEOUT_MS,
  });
  const keepaliveMs = resolvedTaskPolicy.keepaliveMs;
  const nowTs = Math.floor(Date.now() / 1000);

  const title = generateCloudJobTitle(
    taskWithHarnessOverrides,
    10_000,
    'description' in taskWithHarnessOverrides.payload &&
      taskWithHarnessOverrides.payload.description
      ? taskWithHarnessOverrides.payload.description
      : null,
  );
  const requestedComputeProvider = resolveComputeProviderTarget(
    task.computeProvider,
    await resolveDefaultComputeProvider(),
  );

  const targetComputeProvider = sourceJobVendor ?? requestedComputeProvider;

  if (
    task.type === CloudTaskType.SnapshotResume &&
    sourceJobHarness &&
    task.harness &&
    sourceJobHarness !== task.harness
  ) {
    console.warn(
      `[enqueueCloudTask] SnapshotResume harness override: requested=${task.harness}, source=${sourceJobHarness}`,
    );
  }

  if (
    task.type === CloudTaskType.SnapshotResume &&
    sourceJobVendor &&
    task.computeProvider &&
    sourceJobVendor !== task.computeProvider
  ) {
    console.warn(
      `[enqueueCloudTask] SnapshotResume computeProvider override: requested=${task.computeProvider}, source=${sourceJobVendor}`,
    );
  }

  const requestedWorkKindDecision =
    task.type === CloudTaskType.SnapshotResume
      ? await resolveRequestedWorkKindDecision({
          inheritedKind: sourceJobRequestedWorkKind,
          userId,
          taskId: internalTaskId,
        })
      : (task.requestedWorkKindDecision ??
        (await resolveRequestedWorkKindDecision({
          prompt: getRequestedWorkKindPrompt(task),
          bootstrapSkill: getRequestedWorkKindBootstrapSkill(task),
          userId,
          taskId: internalTaskId,
        })));

  if (snapshotResumeSourceCloudJobId && snapshotResumeSourceSnapshotId) {
    await recordSnapshotResumeRequestEvent({
      cloudJobId: snapshotResumeSourceCloudJobId,
      eventType: 'decision',
      message: 'Snapshot resume requested.',
      details: {
        stage: 'request',
        sourceCloudJobId: snapshotResumeSourceCloudJobId,
        sourceSnapshotId: snapshotResumeSourceSnapshotId,
        requestedCloudJobUserId: userId ?? null,
      },
    });
  }

  // This is currently the only place where we create cloud jobs.
  // Note that all of the validations above are enforced at the database level
  // as well.
  let cloudJob: CloudJob | null = null;

  try {
    cloudJob = await db.transaction(async (tx) => {
      const attributionSnapshot = await resolvePersistedTaskAttributionSnapshot(
        tx,
        taskWithHarnessOverrides,
      );
      // Gate the effective author / PR owner resolution behind the
      // AuthorshipRules org flag. When the flag is off we skip the rule fetch
      // and evaluation entirely and leave the effective-authorship columns
      // null, which downstream git-author/display resolution treats as legacy
      // attribution — so a flag-off launch is byte-identical to pre-rollout
      // behavior.
      const authorshipRulesEnabled = evaluateFeatureFlagFromMetadata(
        FeatureFlag.AuthorshipRules,
        resolvedHarness.deploymentMetadata ?? {},
      );
      const effectiveAuthorship = authorshipRulesEnabled
        ? await (async () => {
            const [authorshipSettingsRow, matchedHumanActor] =
              await Promise.all([
                tx.query.backgroundAgentSettings.findFirst({
                  columns: {
                    compiledAuthorshipRules: true,
                  },
                }),
                resolveMatchedHumanActor(
                  tx,
                  attributionSnapshot.attributedUserId,
                ),
              ]);
            return evaluateEffectiveAuthorship({
              compiledRules:
                authorshipSettingsRow?.compiledAuthorshipRules ?? [],
              matchedHumanActor,
              snapshot: attributionSnapshot,
              task: taskWithHarnessOverrides,
            });
          })()
        : null;
      const persistedAttributionSnapshot = {
        attributionKind: attributionSnapshot.attributionKind ?? undefined,
        attributedUserId: attributionSnapshot.attributedUserId ?? null,
        attributionSourceKind:
          attributionSnapshot.attributionSourceKind ?? undefined,
        attributionSourceDisplayName:
          attributionSnapshot.attributionSourceDisplayName ?? null,
        attributionSourceExternalId:
          attributionSnapshot.attributionSourceExternalId ?? null,
        attributedGithubLogin:
          attributionSnapshot.attributedGithubLogin ?? null,
        attributedGithubUserId:
          attributionSnapshot.attributedGithubUserId ?? null,
        effectiveAuthorKind: effectiveAuthorship?.effectiveAuthorKind ?? null,
        effectiveAuthorUserId:
          effectiveAuthorship?.effectiveAuthorUserId ?? null,
        effectiveAuthorDisplayName:
          effectiveAuthorship?.effectiveAuthorDisplayName ?? null,
        effectiveAuthorGithubLogin:
          effectiveAuthorship?.effectiveAuthorGithubLogin ?? null,
        effectiveAuthorGithubUserId:
          effectiveAuthorship?.effectiveAuthorGithubUserId ?? null,
        effectiveAuthorReason:
          effectiveAuthorship?.effectiveAuthorReason ?? null,
        effectiveAuthorRuleId:
          effectiveAuthorship?.effectiveAuthorRuleId ?? null,
        effectivePrOwnerKind: effectiveAuthorship?.effectivePrOwnerKind ?? null,
        effectivePrOwnerUserId:
          effectiveAuthorship?.effectivePrOwnerUserId ?? null,
        effectivePrOwnerDisplayName:
          effectiveAuthorship?.effectivePrOwnerDisplayName ?? null,
        effectivePrOwnerGithubLogin:
          effectiveAuthorship?.effectivePrOwnerGithubLogin ?? null,
        effectivePrOwnerReason:
          effectiveAuthorship?.effectivePrOwnerReason ?? null,
        effectivePrOwnerRuleId:
          effectiveAuthorship?.effectivePrOwnerRuleId ?? null,
      };
      let taskId = internalTaskId ?? null;

      if (taskId) {
        const existingTask = await tx.query.tasks.findFirst({
          where: eq(tasks.id, taskId),
          columns: { id: true },
        });

        if (!existingTask) {
          const createdTask = await createTaskWithRetry(
            {
              id: taskId,
              userId: userId ?? null,
              harness: targetHarness,
              provider: DEFAULT_STANDARD_TASK_PROVIDER,
              model: effectiveTaskModel,
              title,
              ...(hasDeterministicCloudJobTitle(taskWithHarnessOverrides.type)
                ? { llmTitleCheckpoint: LLM_TITLE_LOCKED_CHECKPOINT }
                : {}),
              repositoryName,
              repositoryUrl: repositoryName
                ? `https://github.com/${repositoryName}`
                : null,
              defaultBranch: taskWithHarnessOverrides.payload.branch ?? null,
              timestamp: nowTs,
              ...persistedAttributionSnapshot,
            },
            { db: tx },
          );

          taskId = createdTask.id;
        }
      } else {
        const createdTask = await createTaskWithRetry(
          {
            userId: userId ?? null,
            harness: targetHarness,
            provider: DEFAULT_STANDARD_TASK_PROVIDER,
            model: effectiveTaskModel,
            title,
            ...(hasDeterministicCloudJobTitle(taskWithHarnessOverrides.type)
              ? { llmTitleCheckpoint: LLM_TITLE_LOCKED_CHECKPOINT }
              : {}),
            repositoryName,
            repositoryUrl: repositoryName
              ? `https://github.com/${repositoryName}`
              : null,
            defaultBranch: taskWithHarnessOverrides.payload.branch ?? null,
            timestamp: nowTs,
            ...persistedAttributionSnapshot,
          },
          { db: tx },
        );

        taskId = createdTask.id;
      }

      const { computeProvider: _ignoredComputeProvider, ...taskInsertValues } =
        taskWithHarnessOverrides;

      const [insertedCloudJob] = await tx
        .insert(cloudJobs)
        .values({
          status: options.initialStatus ?? CloudTaskStatus.Pending,
          ...(options.initialStatus === CloudTaskStatus.Dequeued
            ? { dequeuedAt: new Date() }
            : {}),
          vendor: targetComputeProvider,
          port: task.payload.port,
          initialPaths,
          ...taskInsertValues,
          slackThreadTs,
          ...(sourceJobHarnessInstructions !== null
            ? { harnessInstructions: sourceJobHarnessInstructions }
            : {}),
          harness: targetHarness,
          title,
          requestedWorkKind: requestedWorkKindDecision.kind,
          requestedWorkKindSource: requestedWorkKindDecision.source,
          requestedWorkKindConfidence: requestedWorkKindDecision.confidence,
          actingUserId: options.skipInitialActingUser ? null : (userId ?? null),
          keepaliveMs,
          ...persistedAttributionSnapshot,
          taskId,
        })
        .returning();

      if (!insertedCloudJob) {
        throw new Error('Failed to create `cloudJobs` record.');
      }

      if (options.afterCreateInTransaction) {
        await options.afterCreateInTransaction(tx, insertedCloudJob);
      }

      return insertedCloudJob;
    });
  } catch (error) {
    if (snapshotResumeSourceCloudJobId && snapshotResumeSourceSnapshotId) {
      await recordSnapshotResumeRequestEvent({
        cloudJobId: snapshotResumeSourceCloudJobId,
        eventType: 'failed',
        message:
          'Snapshot resume request failed before a child job was created.',
        details: {
          stage: 'request',
          sourceCloudJobId: snapshotResumeSourceCloudJobId,
          sourceSnapshotId: snapshotResumeSourceSnapshotId,
          requestedCloudJobUserId: userId ?? null,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }

    throw error;
  }

  if (!cloudJob) {
    throw new Error('Failed to create `cloudJobs` record.');
  }

  // Anonymous analytics (no-op unless enabled): task creation with
  // non-identifying routing facts only.
  void captureEvent('task_created', {
    ...(userId ? { userId } : {}),
    properties: {
      taskType: cloudJob.type,
      harness: cloudJob.harness ?? null,
      model: effectiveTaskModel,
      computeProvider: cloudJob.vendor ?? null,
    },
  });

  if (snapshotResumeSourceCloudJobId && snapshotResumeSourceSnapshotId) {
    await recordSnapshotResumeRequestEvent({
      cloudJobId: snapshotResumeSourceCloudJobId,
      eventType: 'enqueued',
      message: `Created SnapshotResume job #${cloudJob.id}.`,
      details: {
        stage: 'request',
        sourceCloudJobId: snapshotResumeSourceCloudJobId,
        sourceSnapshotId: snapshotResumeSourceSnapshotId,
        resumeCloudJobId: cloudJob.id,
        resumeTaskId: cloudJob.taskId,
        requestedCloudJobUserId: userId ?? null,
      },
    });
  }

  // [CloudTaskType]          [Agent(s)]               [Trigger(s)]
  // ---------------------------------------------------------------------------
  // StandardTask             Generalist                Manual
  //
  // GithubPrReview           PR Reviewer               GitHub, Manual (TODO: What happens if you manually trigger a PR that is already reviewed?)
  // GithubPrReviewSync       PR Reviewer               GitHub
  // GithubPrReviewFollowUp   PR Reviewer               GitHub
  //
  // SlackAppMention          Generalist                Slack
  // ---------------------------------------------------------------------------
  //
  // The following task types are deprecated and currently unsupported in the standard GitHub workflow layer: GithubIssueFix, GithubIssueCommentRespond.
  // They are reserved for a future issue-specific cloud agent path.

  if (options.enqueue !== false) {
    if (options.beforeEnqueue) {
      try {
        await options.beforeEnqueue(cloudJob);
      } catch (error) {
        const message = getErrorMessage(
          error,
          'Failed before cloud job enqueue',
        );

        await cancelCloudJobBeforeQueue(
          cloudJob,
          message,
          'beforeEnqueue failed',
        );

        throw error;
      }
    }

    try {
      await CloudJobQueue.getInstance().enqueue({
        id: cloudJob.id,
        scope: getScope(task.type, task.payload),
      });
    } catch (error) {
      await cancelCloudJobBeforeQueue(
        cloudJob,
        getErrorMessage(error, 'Failed to enqueue cloud job'),
        'queue enqueue failed',
      );

      throw new CloudJobQueueEnqueueError({
        cloudJobId: cloudJob.id,
        taskId: cloudJob.taskId,
        originalError: error,
      });
    }

    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT id FROM cloud_jobs WHERE id = ${cloudJob.id} FOR UPDATE`,
        );

        const persistedCloudJob = await tx.query.cloudJobs.findFirst({
          where: eq(cloudJobs.id, cloudJob.id),
          columns: {
            status: true,
            canceledAt: true,
            completedAt: true,
          },
        });

        if (
          !persistedCloudJob ||
          persistedCloudJob.status === CloudTaskStatus.Canceled ||
          persistedCloudJob.canceledAt !== null ||
          persistedCloudJob.completedAt !== null
        ) {
          return;
        }

        await recordTaskStartParallelCount(tx, {
          cloudJobId: cloudJob.id,
          cloudJobType: task.type,
          taskId: cloudJob.taskId,
          startedAt: new Date(),
        });
      });
    } catch (loggingError) {
      console.warn(
        `[enqueueCloudTask] Failed to record task-start parallel count for cloud job ${cloudJob.id}: ${
          loggingError instanceof Error
            ? loggingError.message
            : String(loggingError)
        }`,
      );
    }
  }

  // Fire-and-forget: generate an LLM title from the initial prompt during
  // startup so the user sees a meaningful title before the worker records
  // the first envelope.
  const description =
    'description' in task.payload ? task.payload.description : undefined;

  if (
    !options.skipEarlyTitleGeneration &&
    !hasDeterministicCloudJobTitle(task.type) &&
    typeof description === 'string' &&
    description.trim()
  ) {
    void (async () => {
      try {
        const generatedTitle = await generateLlmTaskTitle({
          userId: cloudJob.userId,
          taskId: cloudJob.taskId,
          messages: [{ role: 'user', text: description }],
        });
        const shouldPersistGeneratedTitle =
          !isFallbackTaskTitle(generatedTitle);

        const [updatedTask] = await db
          .update(tasks)
          .set({
            llmTitleCheckpoint: 1,
            updatedAt: new Date(),
            ...(shouldPersistGeneratedTitle ? { title: generatedTitle } : {}),
          })
          .where(
            and(
              eq(tasks.id, cloudJob.taskId),
              isNull(tasks.titleEditedByUserAt),
              lt(tasks.llmTitleCheckpoint, 1),
            ),
          )
          .returning({ id: tasks.id });

        if (updatedTask) {
          if (shouldPersistGeneratedTitle) {
            await db
              .update(cloudJobs)
              .set({ title: generatedTitle })
              .where(eq(cloudJobs.id, cloudJob.id));
          }
        }
      } catch (error) {
        console.warn(
          `[enqueueCloudTask] Failed to generate early LLM title for task ${cloudJob.taskId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    })();
  }

  return cloudJob;
}

async function recordSnapshotResumeRequestEvent(input: {
  cloudJobId: number;
  eventType: 'decision' | 'enqueued' | 'failed';
  message: string;
  details: Record<string, unknown>;
}): Promise<void> {
  try {
    await recordSnapshotResumeEvent(db, {
      cloudJobId: input.cloudJobId,
      eventType: input.eventType,
      message: input.message,
      details: input.details,
    });
  } catch (error) {
    console.warn(
      `[enqueueCloudTask] Failed to persist snapshot resume event for source job #${input.cloudJobId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function dequeueCloudTask(): Promise<number | null> {
  const entry = await CloudJobQueue.getInstance().dequeue();
  return entry ? entry.id : null;
}

export function releaseCloudTask(cloudJob: CloudJob): Promise<boolean> {
  return CloudJobQueue.getInstance().releaseLock(
    getScope(cloudJob.type, cloudJob.payload),
  );
}

export async function isLockedCloudTask(cloudJob: CloudJob): Promise<boolean> {
  return CloudJobQueue.getInstance().isLocked(
    getScope(cloudJob.type, cloudJob.payload),
  );
}

export async function getCloudTaskLockTTL(cloudJob: CloudJob): Promise<number> {
  return CloudJobQueue.getInstance().getLockTTL(
    getScope(cloudJob.type, cloudJob.payload),
  );
}

function resolveSlackThreadTs(task: CloudTask): string | undefined {
  if (typeof task.slackThreadTs === 'string' && task.slackThreadTs.length > 0) {
    return task.slackThreadTs;
  }

  return getSlackThreadTsFromTaskPayload(task.payload) ?? undefined;
}

function getScope(type: CloudTaskType, payload: CloudTaskPayload): string {
  // Currently only PR review jobs require a scope to prevent multiple
  // concurrent jobs for the same PR.
  return isPrReviewJob(type, payload)
    ? `${payload.repo}:${payload.prNumber}`
    : randomUUID();
}
