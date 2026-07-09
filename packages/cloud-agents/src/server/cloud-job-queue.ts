import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  type AuthorshipRuleActor,
  type BackgroundAutomationKey,
  type CloudTask,
  type CodingHarness,
  type SnapshotResumeTask,
  type CloudTaskLaunchClass,
  type SourceControlProvider,
  type TaskInitiator,
  type TaskSurface,
  type TaskTrigger,
  type TaskVisibility,
  type TaskWorkflow,
  CloudTaskStatus,
  TaskPayloadKind,
  DEFAULT_DELEGATED_KEEPALIVE_MS,
  DEFAULT_KEEPALIVE_MS,
  DEFAULT_LAUNCH_CODING_HARNESS,
  getUserDisplayName,
  getPrimaryPortFromConfig,
  isConfiguredEnvValue,
  normalizeDeploymentModelConfig,
  resolveCloudTaskRuntimePolicy,
  resolveCloudTaskWorkspace,
  resolveComputeProviderTarget,
  TASK_TIMEOUT_MS,
} from '@roomote/types';
import { Env } from '@roomote/env';
import {
  type CloudJob,
  type DatabaseTransaction,
  db,
  deploymentSettings,
  ensureAutomationRowsOnce,
  createTaskWithRetry,
  markTaskStartParallelCountEndedAt,
  recordTaskStartParallelCount,
  syncTaskStateFromRuns,
  taskPullRequests,
  taskRuns,
  tasks,
  users,
  environments,
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  recordSnapshotResumeEvent,
  resolveDefaultComputeProvider,
  resolveWorkspaceSourceControlProvider,
  sql,
} from '@roomote/db/server';
import type { MetadataRecord } from '@roomote/feature-flags/server';

import { type Redis, getRedis } from '@roomote/redis';
import { captureEvent } from '@roomote/telemetry/server';
import { generateCloudJobTitle, hasDeterministicCloudJobTitle } from '../utils';
import { DEFAULT_STANDARD_TASK_PROVIDER } from '../task-runtime-defaults';
import { evaluateCommitAuthor } from './authorship-rules';
import { findLatestGithubIdentityForUser } from './commit-author';
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
    const endedAt = new Date();

    await db.transaction(async (tx) => {
      await tx
        .update(taskRuns)
        .set({
          status: CloudTaskStatus.Canceled,
          canceledAt: endedAt,
          error: message,
        })
        .where(eq(taskRuns.id, cloudJob.id));

      // Derive the task state from all its runs. Enqueue-failure cancels
      // bypass finishCloudJob entirely, so without this sync the task stays
      // 'active' forever. The shared @roomote/db helper keeps siblings honest.
      await syncTaskStateFromRuns(tx, cloudJob.taskId);
    });
  } catch (cancelError) {
    console.warn(
      `[enqueueCloudTask] Failed to cancel run ${cloudJob.id} after ${failureContext}: ${getErrorMessage(
        cancelError,
        'Unknown cancellation error',
      )}`,
    );
  }
}

async function resolveMatchedHumanActor(
  tx: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  linkedUserId: string | null,
): Promise<AuthorshipRuleActor | null> {
  if (!linkedUserId) {
    return null;
  }

  const user = await tx.query.users.findFirst({
    where: eq(users.id, linkedUserId),
    columns: {
      id: true,
      name: true,
      email: true,
    },
  });

  const githubIdentity = await findLatestGithubIdentityForUser(
    tx,
    linkedUserId,
  );

  return {
    userId: linkedUserId,
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
  const deployment = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: {
      metadata: true,
      taskModelSettings: true,
      runtimeModelConfig: true,
    },
  });

  return {
    harness: task.harness ?? DEFAULT_LAUNCH_CODING_HARNESS,
    deploymentMetadata:
      (deployment?.metadata as MetadataRecord | null | undefined) ?? null,
    deploymentTaskModelSettings: deployment?.taskModelSettings ?? null,
    deploymentCodeReviewModelId: resolveCodeReviewModelId(
      normalizeDeploymentModelConfig(deployment?.runtimeModelConfig),
    ),
  };
}

function getInitialTaskPrompt(task: CloudTask): string | undefined {
  switch (task.type) {
    case TaskPayloadKind.StandardTask:
    case TaskPayloadKind.Scan:
    case TaskPayloadKind.McpRecommendations:
      return task.payload.description;
    case TaskPayloadKind.SlackAppMention:
      return task.payload.text;
    case TaskPayloadKind.LinearAgentSession:
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
  if (task.type !== TaskPayloadKind.StandardTask) {
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
          const removed = await this.redis.lrem(
            CloudJobQueueKeys.Queue,
            0,
            rawValue,
          );

          // If lrem removed nothing the entry was already claimed off the
          // queue by a worker; that worker owns the run's terminal state, so
          // skip the DB cancel + sync entirely to avoid racing it.
          if (removed === 0) {
            continue;
          }

          // Best-effort cancel in DB; do not block queue behavior during dedup.
          void db
            .transaction(async (tx) => {
              const endedAt = new Date();

              // Only cancel a run still waiting in the queue (pending/dequeued).
              // If it already advanced past dequeue it is claimed, so leave it
              // and its task state to the owning worker.
              const [canceledRun] = await tx
                .update(taskRuns)
                .set({
                  status: CloudTaskStatus.Canceled,
                  canceledAt: endedAt,
                  error: 'Superseded by a newer cloud job.',
                })
                .where(
                  and(
                    eq(taskRuns.id, otherEntry.id),
                    inArray(taskRuns.status, [
                      CloudTaskStatus.Pending,
                      CloudTaskStatus.Dequeued,
                    ]),
                  ),
                )
                .returning({ taskId: taskRuns.taskId });

              // The run was already claimed/terminal; nothing to sync.
              if (!canceledRun) {
                return;
              }

              // Derive the task state from all its runs so the superseded run's
              // task does not stay 'active' forever, while an already-completed
              // sibling still wins.
              await syncTaskStateFromRuns(tx, canceledRun.taskId);

              await markTaskStartParallelCountEndedAt(tx, {
                runId: otherEntry.id,
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
      environmentId: sql<string>`${taskRuns.payload}->>'environmentId'`,
    })
    .from(taskPullRequests)
    .innerJoin(tasks, eq(tasks.id, taskPullRequests.taskId))
    .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .where(
      and(
        eq(taskPullRequests.sourceControlProvider, sourceControlProvider),
        eq(taskPullRequests.repository, repoFullName),
        eq(taskPullRequests.prNumber, prNumber),
        eq(tasks.workflow, 'standard'),
        sql`${taskRuns.payload}->>'environmentId' IS NOT NULL`,
      ),
    )
    .orderBy(desc(taskPullRequests.detectedAt), desc(taskRuns.createdAt));

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

  const payloadRepo = sql<string>`${taskRuns.payload}->>'repo'`;

  const rows = await db
    .select({
      environmentId: sql<string>`${taskRuns.payload}->>'environmentId'`,
      createdAt: taskRuns.createdAt,
    })
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(
      and(
        eq(tasks.workflow, 'standard'),
        inArray(
          sql<string>`${taskRuns.payload}->>'environmentId'`,
          candidateEnvironmentIds,
        ),
        sql`(
          ${payloadRepo} = ${repoFullName}
          OR EXISTS (
            SELECT 1
            FROM ${taskPullRequests}
            WHERE ${taskPullRequests.taskId} = ${taskRuns.taskId}
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
   * Optional explicit launch-class override used to resolve runtime keepalive
   * policy. When omitted, automation-initiated launches derive the
   * 'automation' class from the initiator and everything else falls back to
   * the payload-kind inference.
   */
  launchClass?: CloudTaskLaunchClass;
  /**
   * Leave `actingUserId` unset until a real follow-up sender can be resolved
   * (Slack channel auto-start path).
   */
  skipInitialActingUser?: boolean;
  /**
   * Persist the run without pushing it onto the controller Redis queue.
   * Intended for direct-run jobs that are claimed by an explicitly invoked
   * worker command inside an already-running sandbox.
   */
  enqueue?: boolean;
  /**
   * Initial persisted status for the new run. Defaults to `pending`, matching
   * normal queue-driven launches.
   */
  initialStatus?: CloudTaskStatus.Pending | CloudTaskStatus.Dequeued;
  /**
   * Avoid best-effort LLM title generation for short-lived synthetic jobs.
   */
  skipEarlyTitleGeneration?: boolean;
  /**
   * Runs inside the run-creation transaction after the new run row is
   * inserted and before the transaction commits.
   */
  afterCreateInTransaction?: (
    tx: DatabaseTransaction,
    cloudJob: CloudJob,
  ) => Promise<void>;
  /**
   * Runs after the run row is created but before it is pushed onto the
   * controller queue. If this throws, the run is canceled and never queued.
   */
  beforeEnqueue?: (cloudJob: CloudJob) => Promise<void>;
}

/**
 * Channel bindings stamped onto the tasks row at creation. Callers derive
 * these from the surface context they already hold (webhook/message
 * metadata); enqueue never sniffs them out of the payload.
 */
export type TaskChannelBindings = {
  slackChannelId?: string | null;
  slackThreadTs?: string | null;
  linearSessionId?: string | null;
  linearIssueId?: string | null;
  linearOrganizationId?: string | null;
};

/**
 * PR linkage persisted as a task_pull_requests row inside the create
 * transaction. Required for 'pr_review' and 'pr_conflict_resolve' launches;
 * callers have all of this from the triggering webhook.
 */
export type TaskPrLinkage = {
  provider: SourceControlProvider;
  host?: string | null;
  repository: string;
  prNumber: number;
  prUrl: string;
  prTitle?: string | null;
  prSha?: string | null;
  prBaseRef?: string | null;
  prBaseSha?: string | null;
  githubReactionId?: number | null;
  githubCheckRunId?: number | null;
  githubReviewCommentId?: number | null;
};

type FreshCloudTask = Exclude<
  CloudTask,
  { type: typeof TaskPayloadKind.SnapshotResume }
>;

/**
 * A fresh launch creates a tasks row (initiator stamp, classification,
 * commit-author block, channel bindings) plus its first run.
 */
export type FreshCloudTaskLaunch = {
  task: FreshCloudTask;
  initiator: TaskInitiator;
  workflow: TaskWorkflow;
  surface: TaskSurface;
  trigger: TaskTrigger;
  visibility?: TaskVisibility;
  channels?: TaskChannelBindings;
  /** Required when workflow is 'pr_review' or 'pr_conflict_resolve'. */
  prLinkage?: TaskPrLinkage;
  actingUserId?: never;
};

/**
 * A resume attaches a new run (kind 'resume') to the source run's existing
 * task. It never creates a task, never re-attributes, and must not carry
 * initiator/classification fields.
 */
export type ResumeCloudTaskLaunch = {
  task: SnapshotResumeTask;
  /** The resuming human; null/omitted for automation-driven resumes. */
  actingUserId?: string | null;
  initiator?: never;
  workflow?: never;
  surface?: never;
  trigger?: never;
  visibility?: never;
  channels?: never;
  prLinkage?: never;
};

export type EnqueueCloudTaskInput =
  | FreshCloudTaskLaunch
  | ResumeCloudTaskLaunch;

const PR_LINKAGE_REQUIRED_WORKFLOWS: ReadonlySet<TaskWorkflow> = new Set([
  'pr_review',
  'pr_conflict_resolve',
]);

const PR_SCOPED_PAYLOAD_KINDS: ReadonlySet<TaskPayloadKind> = new Set([
  TaskPayloadKind.GithubPrReview,
  TaskPayloadKind.GithubPrReviewSync,
]);

/**
 * Computes the Redis queue scope for a fresh launch. PR review launches share
 * a `${repository}:${prNumber}` scope so a newer review of the same PR
 * supersedes a queued one; everything else gets a unique scope.
 */
export function resolveQueueScope(params: {
  workflow: TaskWorkflow;
  payloadKind: TaskPayloadKind;
  prLinkage?: TaskPrLinkage | null;
}): string {
  if (
    params.workflow === 'pr_review' &&
    params.prLinkage &&
    PR_SCOPED_PAYLOAD_KINDS.has(params.payloadKind)
  ) {
    return `${params.prLinkage.repository}:${params.prLinkage.prNumber}`;
  }

  return randomUUID();
}

function getRunLockScope(cloudJob: CloudJob): string {
  if (PR_SCOPED_PAYLOAD_KINDS.has(cloudJob.payloadKind)) {
    const payload = cloudJob.payload as { repo?: string; prNumber?: number };

    if (payload.repo && typeof payload.prNumber === 'number') {
      return `${payload.repo}:${payload.prNumber}`;
    }
  }

  return randomUUID();
}

function getInitiatorLinkedUserId(initiator: TaskInitiator): string | null {
  if (initiator.kind === 'automation') {
    return null;
  }

  if ('userId' in initiator) {
    return initiator.userId;
  }

  return initiator.matchedUserId ?? null;
}

type TaskInitiatorColumns = {
  initiatorKind: 'user' | 'automation';
  initiatorUserId: string | null;
  initiatorAutomation: BackgroundAutomationKey | null;
  actorExternalId: string | null;
  actorDisplayName: string | null;
};

function resolveInitiatorColumns(
  initiator: TaskInitiator,
): TaskInitiatorColumns {
  if (initiator.kind === 'automation') {
    return {
      initiatorKind: 'automation',
      initiatorUserId: null,
      initiatorAutomation: initiator.key,
      actorExternalId: initiator.actor?.externalId ?? null,
      actorDisplayName: initiator.actor?.displayName ?? null,
    };
  }

  if ('userId' in initiator) {
    return {
      initiatorKind: 'user',
      initiatorUserId: initiator.userId,
      initiatorAutomation: null,
      actorExternalId: null,
      actorDisplayName: null,
    };
  }

  return {
    initiatorKind: 'user',
    initiatorUserId: initiator.matchedUserId ?? null,
    initiatorAutomation: null,
    actorExternalId: initiator.externalId,
    actorDisplayName: initiator.displayName ?? null,
  };
}

async function assertUserIsNotDeleted(userId: string | null): Promise<void> {
  if (!userId) {
    return;
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { deletedAt: true },
  });

  if (user?.deletedAt) {
    throw new Error('Cannot create cloud task for deleted user.');
  }
}

type EnvironmentContext = {
  initialPaths: Record<string, string> | undefined;
};

/**
 * Resolves the environment referenced by the payload, defaulting the payload
 * port to the environment's primary port and collecting per-port initial
 * paths. Mutates `task.payload.port` like the launch flow always has.
 */
async function resolveEnvironmentContext(
  task: CloudTask,
): Promise<EnvironmentContext> {
  let initialPaths: Record<string, string> | undefined;

  if (!task.payload.environmentId) {
    return { initialPaths };
  }

  const environment = await db.query.environments.findFirst({
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

  return { initialPaths };
}

async function pushRunOntoQueue(params: {
  cloudJob: CloudJob;
  scope: string;
  options: EnqueueCloudTaskOptions;
}): Promise<void> {
  const { cloudJob, scope, options } = params;

  if (options.enqueue === false) {
    return;
  }

  if (options.beforeEnqueue) {
    try {
      await options.beforeEnqueue(cloudJob);
    } catch (error) {
      const message = getErrorMessage(error, 'Failed before cloud job enqueue');

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
      scope,
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
        sql`SELECT id FROM task_runs WHERE id = ${cloudJob.id} FOR UPDATE`,
      );

      const persistedRun = await tx.query.taskRuns.findFirst({
        where: eq(taskRuns.id, cloudJob.id),
        columns: {
          status: true,
          canceledAt: true,
          completedAt: true,
        },
      });

      if (
        !persistedRun ||
        persistedRun.status === CloudTaskStatus.Canceled ||
        persistedRun.canceledAt !== null ||
        persistedRun.completedAt !== null
      ) {
        return;
      }

      await recordTaskStartParallelCount(tx, {
        runId: cloudJob.id,
        payloadKind: cloudJob.payloadKind,
        taskId: cloudJob.taskId,
        startedAt: new Date(),
      });
    });
  } catch (loggingError) {
    console.warn(
      `[enqueueCloudTask] Failed to record task-start parallel count for run ${cloudJob.id}: ${
        loggingError instanceof Error
          ? loggingError.message
          : String(loggingError)
      }`,
    );
  }
}

export async function enqueueCloudTask(
  input: EnqueueCloudTaskInput,
  options: EnqueueCloudTaskOptions = {},
): Promise<CloudJob> {
  await assertDeploymentIsActive();

  if (input.task.type === TaskPayloadKind.SnapshotResume) {
    return enqueueSnapshotResume(input as ResumeCloudTaskLaunch, options);
  }

  return enqueueFreshLaunch(input as FreshCloudTaskLaunch, options);
}

async function enqueueFreshLaunch(
  input: FreshCloudTaskLaunch,
  options: EnqueueCloudTaskOptions,
): Promise<CloudJob> {
  const { task, initiator, workflow, surface, trigger } = input;
  const visibility: TaskVisibility = input.visibility ?? 'visible';
  const linkedUserId = getInitiatorLinkedUserId(initiator);

  await assertUserIsNotDeleted(linkedUserId);

  if (PR_LINKAGE_REQUIRED_WORKFLOWS.has(workflow) && !input.prLinkage) {
    throw new Error(
      `A '${workflow}' launch requires prLinkage so the pull request row can be created with the task.`,
    );
  }

  // Auto-resolve environment for PR tasks when no environmentId is set.
  // This allows PR Reviewer review/follow-up jobs to benefit from project
  // configuration (setup commands, env vars, services, agent instructions).
  const PR_TASK_TYPES = new Set<TaskPayloadKind>([
    TaskPayloadKind.GithubPrReview,
    TaskPayloadKind.GithubPrReviewSync,
    TaskPayloadKind.GithubPrReviewFollowUp,
  ]);
  const workspace = resolveCloudTaskWorkspace(task.payload);

  // Stamp the source-control provider once at launch when the caller omitted
  // it. Downstream consumers (token minting, worker repository resolution)
  // otherwise fall back to the GitHub default, which breaks GitLab/Gitea/ADO
  // deployments for any launch surface that forgot the stamp. The shared
  // resolver covers every workspace shape (repository, repository_set,
  // environment, all_repositories) so environment- and all-repositories-based
  // launches (e.g. Linear) get stamped too.
  if (
    !('sourceControlProvider' in task.payload) ||
    !task.payload.sourceControlProvider
  ) {
    const resolvedProvider = await resolveWorkspaceSourceControlProvider(
      db,
      workspace,
    );

    if (resolvedProvider) {
      task.payload.sourceControlProvider = resolvedProvider;
    }
  }

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

  const { initialPaths } = await resolveEnvironmentContext(task);

  const resolvedHarness = await resolveRequestedHarness(task);
  const targetHarness = resolvedHarness.harness;
  const { task: taskWithHarnessOverrides, model: effectiveTaskModel } =
    resolveEffectiveHarnessModelState({
      task,
      targetHarness,
      isSnapshotResume: false,
      sourceJobHarnessModelOverrides: undefined,
      deploymentMetadata: resolvedHarness.deploymentMetadata,
      deploymentTaskModelSettings: resolvedHarness.deploymentTaskModelSettings,
      deploymentCodeReviewModelId:
        resolvedHarness.deploymentCodeReviewModelId ?? null,
    });

  const repositoryName = taskWithHarnessOverrides.payload.repo || null;
  const resolvedTaskPolicy = resolveCloudTaskRuntimePolicy({
    taskType: taskWithHarnessOverrides.type,
    launchClass:
      options.launchClass ??
      (initiator.kind === 'automation' ? 'automation' : undefined),
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
  const targetComputeProvider = resolveComputeProviderTarget(
    task.computeProvider,
    await resolveDefaultComputeProvider(),
  );

  const requestedWorkKindDecision =
    task.requestedWorkKindDecision ??
    (await resolveRequestedWorkKindDecision({
      prompt: getInitialTaskPrompt(task),
      bootstrapSkill: getRequestedWorkKindBootstrapSkill(task),
      userId: linkedUserId,
    }));

  const initiatorColumns = resolveInitiatorColumns(initiator);

  // tasks.initiator_automation references automations.key; make sure the
  // seeded rows exist before stamping an automation initiator.
  if (initiator.kind === 'automation') {
    await ensureAutomationRowsOnce();
  }

  const initialPrompt = getInitialTaskPrompt(task) ?? null;
  const externalGithubIdentity = {
    githubLogin: 'githubLogin' in task ? task.githubLogin : null,
    githubUserId: 'githubUserId' in task ? task.githubUserId : null,
  };

  // This is the only place where fresh tasks and their first runs are created.
  const cloudJob = await db.transaction(async (tx) => {
    // Commit-author evaluation is unconditional at fresh enqueue.
    const [authorshipSettingsRow, matchedHumanActor] = await Promise.all([
      tx.query.deploymentSettings.findFirst({
        columns: {
          compiledAuthorshipRules: true,
        },
      }),
      resolveMatchedHumanActor(tx, linkedUserId),
    ]);
    const commitAuthor = evaluateCommitAuthor({
      compiledRules: authorshipSettingsRow?.compiledAuthorshipRules ?? [],
      initiator,
      matchedHumanActor,
      externalGithubIdentity,
      workflow,
      surface,
      repositoryFullName: repositoryName,
    });

    const createdTask = await createTaskWithRetry(
      {
        workflow,
        surface,
        trigger,
        visibility,
        state: 'active',
        ...initiatorColumns,
        ...commitAuthor,
        slackChannelId: input.channels?.slackChannelId ?? null,
        slackThreadTs: input.channels?.slackThreadTs ?? null,
        linearSessionId: input.channels?.linearSessionId ?? null,
        linearIssueId: input.channels?.linearIssueId ?? null,
        linearOrganizationId: input.channels?.linearOrganizationId ?? null,
        harness: targetHarness,
        provider: DEFAULT_STANDARD_TASK_PROVIDER,
        model: effectiveTaskModel,
        title,
        ...(hasDeterministicCloudJobTitle(taskWithHarnessOverrides.type)
          ? { llmTitleCheckpoint: LLM_TITLE_LOCKED_CHECKPOINT }
          : {}),
        prompt: initialPrompt,
        requestedWorkKind: requestedWorkKindDecision.kind,
        requestedWorkKindSource: requestedWorkKindDecision.source,
        requestedWorkKindConfidence: requestedWorkKindDecision.confidence,
        repositoryName,
        repositoryUrl: repositoryName
          ? `https://github.com/${repositoryName}`
          : null,
        defaultBranch: taskWithHarnessOverrides.payload.branch ?? null,
        timestamp: nowTs,
      },
      { db: tx },
    );

    if (input.prLinkage) {
      await tx.insert(taskPullRequests).values({
        taskId: createdTask.id,
        sourceControlProvider: input.prLinkage.provider,
        host: input.prLinkage.host ?? null,
        repository: input.prLinkage.repository,
        prNumber: input.prLinkage.prNumber,
        prUrl: input.prLinkage.prUrl,
        prTitle: input.prLinkage.prTitle ?? null,
        prSha: input.prLinkage.prSha ?? null,
        prBaseRef: input.prLinkage.prBaseRef ?? null,
        prBaseSha: input.prLinkage.prBaseSha ?? null,
        githubReactionId: input.prLinkage.githubReactionId ?? null,
        githubCheckRunId: input.prLinkage.githubCheckRunId ?? null,
        githubReviewCommentId: input.prLinkage.githubReviewCommentId ?? null,
      });
    }

    const [insertedRun] = await tx
      .insert(taskRuns)
      .values({
        taskId: createdTask.id,
        kind: 'fresh',
        payloadKind: taskWithHarnessOverrides.type,
        actingUserId: options.skipInitialActingUser ? null : linkedUserId,
        status: options.initialStatus ?? CloudTaskStatus.Pending,
        ...(options.initialStatus === CloudTaskStatus.Dequeued
          ? { dequeuedAt: new Date() }
          : {}),
        harness: targetHarness,
        vendor: targetComputeProvider,
        port: task.payload.port,
        initialPaths,
        payload: taskWithHarnessOverrides.payload,
        keepaliveMs,
      })
      .returning();

    if (!insertedRun) {
      throw new Error('Failed to create `task_runs` record.');
    }

    if (options.afterCreateInTransaction) {
      await options.afterCreateInTransaction(tx, insertedRun);
    }

    return insertedRun;
  });

  // Anonymous analytics (no-op unless enabled): task creation with
  // non-identifying routing facts only.
  void captureEvent('task_created', {
    ...(linkedUserId ? { userId: linkedUserId } : {}),
    properties: {
      taskType: cloudJob.payloadKind,
      workflow,
      surface,
      trigger,
      harness: cloudJob.harness ?? null,
      model: effectiveTaskModel,
      computeProvider: cloudJob.vendor ?? null,
    },
  });

  await pushRunOntoQueue({
    cloudJob,
    scope: resolveQueueScope({
      workflow,
      payloadKind: cloudJob.payloadKind,
      prLinkage: input.prLinkage,
    }),
    options,
  });

  // Fire-and-forget: generate an LLM title from the initial prompt during
  // startup so the user sees a meaningful title before the worker records
  // the first envelope. Titles live on tasks only.
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
          userId: linkedUserId,
          taskId: cloudJob.taskId,
          messages: [{ role: 'user', text: description }],
        });
        const shouldPersistGeneratedTitle =
          !isFallbackTaskTitle(generatedTitle);

        await db
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
          );
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

async function enqueueSnapshotResume(
  input: ResumeCloudTaskLaunch,
  options: EnqueueCloudTaskOptions,
): Promise<CloudJob> {
  const { task } = input;
  const actingUserId = options.skipInitialActingUser
    ? null
    : (input.actingUserId ?? null);

  const sourceRunId = task.sourceCloudJobId ?? task.payload.sourceCloudJobId;
  const sourceSnapshotId =
    task.sourceSnapshotId ?? task.payload.sourceSnapshotId;

  if (!sourceRunId) {
    throw new Error('A snapshot resume requires a source run id.');
  }

  await assertUserIsNotDeleted(actingUserId);

  const sourceRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, sourceRunId),
    columns: {
      id: true,
      taskId: true,
      harness: true,
      vendor: true,
      payload: true,
    },
  });

  if (!sourceRun) {
    throw new Error(
      `Source run ${sourceRunId} was not found for snapshot resume.`,
    );
  }

  await recordSnapshotResumeRequestEvent({
    runId: sourceRun.id,
    taskId: sourceRun.taskId,
    eventType: 'decision',
    message: 'Snapshot resume requested.',
    details: {
      stage: 'request',
      sourceRunId: sourceRun.id,
      sourceSnapshotId: sourceSnapshotId ?? null,
      actingUserId,
    },
  });

  const { initialPaths } = await resolveEnvironmentContext(task);

  const sourceJobHarness = sourceRun.harness;
  const sourceJobVendor = resolveComputeProviderTarget(sourceRun.vendor);
  const sourceJobHarnessModelOverrides = (
    sourceRun.payload as {
      harnessModelOverrides?: import('@roomote/types').HarnessModelOverrides;
    }
  )?.harnessModelOverrides;

  if (task.harness && sourceJobHarness !== task.harness) {
    console.warn(
      `[enqueueCloudTask] SnapshotResume harness override: requested=${task.harness}, source=${sourceJobHarness}`,
    );
  }

  if (
    sourceJobVendor &&
    task.computeProvider &&
    sourceJobVendor !== task.computeProvider
  ) {
    console.warn(
      `[enqueueCloudTask] SnapshotResume computeProvider override: requested=${task.computeProvider}, source=${sourceJobVendor}`,
    );
  }

  const resolvedHarness = await resolveRequestedHarness(task);
  const targetHarness = sourceJobHarness ?? resolvedHarness.harness;
  const { task: taskWithHarnessOverrides } = resolveEffectiveHarnessModelState({
    task,
    targetHarness,
    isSnapshotResume: true,
    sourceJobHarnessModelOverrides,
    deploymentMetadata: resolvedHarness.deploymentMetadata,
    deploymentTaskModelSettings: resolvedHarness.deploymentTaskModelSettings,
    deploymentCodeReviewModelId:
      resolvedHarness.deploymentCodeReviewModelId ?? null,
  });

  const targetComputeProvider =
    sourceJobVendor ??
    resolveComputeProviderTarget(
      task.computeProvider,
      await resolveDefaultComputeProvider(),
    );

  const resolvedTaskPolicy = resolveCloudTaskRuntimePolicy({
    taskType: TaskPayloadKind.SnapshotResume,
    launchClass: options.launchClass,
    appEnv: Env.APP_ENV ?? 'development',
    defaultKeepaliveMs: DEFAULT_KEEPALIVE_MS,
    delegatedKeepaliveMs: DEFAULT_DELEGATED_KEEPALIVE_MS,
    sandboxTimeoutMs: TASK_TIMEOUT_MS,
  });

  let cloudJob: CloudJob;

  try {
    cloudJob = await db.transaction(async (tx) => {
      const [insertedRun] = await tx
        .insert(taskRuns)
        .values({
          taskId: sourceRun.taskId,
          kind: 'resume',
          sourceRunId: sourceRun.id,
          payloadKind: TaskPayloadKind.SnapshotResume,
          actingUserId,
          status: options.initialStatus ?? CloudTaskStatus.Pending,
          ...(options.initialStatus === CloudTaskStatus.Dequeued
            ? { dequeuedAt: new Date() }
            : {}),
          harness: targetHarness,
          vendor: targetComputeProvider,
          port: task.payload.port,
          initialPaths,
          payload: taskWithHarnessOverrides.payload,
          sourceSnapshotId: sourceSnapshotId ?? null,
          keepaliveMs: resolvedTaskPolicy.keepaliveMs,
        })
        .returning();

      if (!insertedRun) {
        throw new Error('Failed to create `task_runs` record.');
      }

      if (options.afterCreateInTransaction) {
        await options.afterCreateInTransaction(tx, insertedRun);
      }

      // The new resume run is non-terminal (pending/dequeued), so re-derive the
      // task state: a task that had gone terminal on a prior attempt flips back
      // to 'active' now that another attempt is queued.
      await syncTaskStateFromRuns(tx, sourceRun.taskId);

      return insertedRun;
    });
  } catch (error) {
    await recordSnapshotResumeRequestEvent({
      runId: sourceRun.id,
      taskId: sourceRun.taskId,
      eventType: 'failed',
      message: 'Snapshot resume request failed before a child run was created.',
      details: {
        stage: 'request',
        sourceRunId: sourceRun.id,
        sourceSnapshotId: sourceSnapshotId ?? null,
        actingUserId,
        error: error instanceof Error ? error.message : String(error),
      },
    });

    throw error;
  }

  void captureEvent('task_created', {
    ...(actingUserId ? { userId: actingUserId } : {}),
    properties: {
      taskType: cloudJob.payloadKind,
      harness: cloudJob.harness ?? null,
      computeProvider: cloudJob.vendor ?? null,
    },
  });

  await recordSnapshotResumeRequestEvent({
    runId: sourceRun.id,
    taskId: sourceRun.taskId,
    eventType: 'enqueued',
    message: `Created SnapshotResume run #${cloudJob.id}.`,
    details: {
      stage: 'request',
      sourceRunId: sourceRun.id,
      sourceSnapshotId: sourceSnapshotId ?? null,
      resumeRunId: cloudJob.id,
      resumeTaskId: cloudJob.taskId,
      actingUserId,
    },
  });

  await pushRunOntoQueue({
    cloudJob,
    scope: randomUUID(),
    options,
  });

  return cloudJob;
}

async function recordSnapshotResumeRequestEvent(input: {
  runId: number;
  taskId?: string;
  eventType: 'decision' | 'enqueued' | 'failed';
  message: string;
  details: Record<string, unknown>;
}): Promise<void> {
  try {
    await recordSnapshotResumeEvent(db, {
      runId: input.runId,
      taskId: input.taskId,
      eventType: input.eventType,
      message: input.message,
      details: input.details,
    });
  } catch (error) {
    console.warn(
      `[enqueueCloudTask] Failed to persist snapshot resume event for source run #${input.runId}: ${
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
  return CloudJobQueue.getInstance().releaseLock(getRunLockScope(cloudJob));
}

export async function isLockedCloudTask(cloudJob: CloudJob): Promise<boolean> {
  return CloudJobQueue.getInstance().isLocked(getRunLockScope(cloudJob));
}

export async function getCloudTaskLockTTL(cloudJob: CloudJob): Promise<number> {
  return CloudJobQueue.getInstance().getLockTTL(getRunLockScope(cloudJob));
}
