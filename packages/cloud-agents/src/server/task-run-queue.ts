import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  type AuthorshipRuleActor,
  type BackgroundAutomationKey,
  type TaskSpec,
  type CodingHarness,
  type SnapshotResumeTask,
  type RunLaunchClass,
  type SourceControlProvider,
  type TaskInitiator,
  type TaskSurface,
  type TaskTrigger,
  type TaskVisibility,
  type TaskWorkflow,
  RunStatus,
  TaskPayloadKind,
  DEFAULT_DELEGATED_KEEPALIVE_MS,
  DEFAULT_KEEPALIVE_MS,
  DEFAULT_LAUNCH_CODING_HARNESS,
  getTaskInitiatorLinkedUserId,
  getUserDisplayName,
  getPrimaryPortFromConfig,
  isConfiguredEnvValue,
  normalizeDeploymentModelConfig,
  resolveTaskRuntimePolicy,
  resolveTaskWorkspace,
  resolveComputeProviderTarget,
  TASK_TIMEOUT_MS,
} from '@roomote/types';
import { Env } from '@roomote/env';
import {
  type TaskRun,
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
import { generateTaskRunTitle, hasDeterministicTaskRunTitle } from '../utils';
import { DEFAULT_STANDARD_TASK_MODEL_PROVIDER } from '../task-runtime-defaults';
import { evaluateCommitAuthor } from './authorship-rules';
import { findLatestGithubIdentityForUser } from './commit-author';
import { resolveEffectiveHarnessModelState } from './harness-model-overrides';
import {
  generateLlmTaskTitle,
  isFallbackTaskTitle,
  LLM_TITLE_LOCKED_CHECKPOINT,
} from './llm-task-title';
import { resolveRequestedWorkKindDecision } from './router/requested-work-kind';

enum TaskRunQueueKeys {
  // Version the storage layout so old and new controllers can coexist during
  // a rolling deployment. Both versions still contend on the same scope lock.
  LegacyQueue = 'queue:cloud-jobs',
  Queue = 'queue:cloud-jobs:v2',
  Entries = 'queue:cloud-jobs:v2:entries',
  EntryScopes = 'queue:cloud-jobs:v2:entry-scopes',
  Scopes = 'queue:cloud-jobs:v2:scopes',
}

const ATOMIC_ENQUEUE_SCRIPT = `
local incomingId = ARGV[1]
local incomingScope = ARGV[2]
local incomingRaw = ARGV[3]
local existingId = redis.call('HGET', KEYS[2], incomingScope)
local evictedId = ''

if existingId then
  redis.call('LREM', KEYS[1], 0, existingId)

  if existingId ~= incomingId then
    evictedId = existingId
    redis.call('HDEL', KEYS[3], existingId)
    redis.call('HDEL', KEYS[4], existingId)
  end
end

redis.call('HSET', KEYS[2], incomingScope, incomingId)
redis.call('HSET', KEYS[3], incomingId, incomingRaw)
redis.call('HSET', KEYS[4], incomingId, incomingScope)
redis.call('RPUSH', KEYS[1], incomingId)

return evictedId
`;

const ATOMIC_DEQUEUE_SCRIPT = `
local queueLength = redis.call('LLEN', KEYS[1])
local lockTtlSeconds = tonumber(ARGV[1])

for _ = 1, queueLength do
  local entryId = redis.call('LPOP', KEYS[1])

  if entryId then
    local rawValue = redis.call('HGET', KEYS[3], entryId)
    local entryScope = redis.call('HGET', KEYS[4], entryId)

    if rawValue and entryScope then
      local acquired = redis.call(
        'SET',
        entryScope,
        entryId,
        'EX',
        lockTtlSeconds,
        'NX'
      )

      if acquired then
        redis.call('HDEL', KEYS[3], entryId)
        redis.call('HDEL', KEYS[4], entryId)

        if redis.call('HGET', KEYS[2], entryScope) == entryId then
          redis.call('HDEL', KEYS[2], entryScope)
        end

        return rawValue
      end

      redis.call('RPUSH', KEYS[1], entryId)
    else
      redis.call('HDEL', KEYS[3], entryId)
      redis.call('HDEL', KEYS[4], entryId)
    end
  end
end

return nil
`;

const RELEASE_OWNED_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end

return 0
`;

// BLPOP cannot atomically combine queue removal with the scope-lock claim in
// ATOMIC_DEQUEUE_SCRIPT. Polling trades four idle EVAL calls per controller
// per second for a bounded 250ms wake-up delay; a future dedicated wake-up
// connection can remove that tradeoff without weakening claim atomicity.
const DEQUEUE_POLL_INTERVAL_MS = 250;

const taskRunQueueEntrySchema = z.object({
  id: z.number(),
  scope: z.string(),
});

export type TaskRunQueueEntry = z.infer<typeof taskRunQueueEntrySchema>;

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return fallback;
}

async function cancelTaskRunBeforeQueue(
  taskRun: TaskRun,
  message: string,
): Promise<void> {
  const endedAt = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(taskRuns)
      .set({
        status: RunStatus.Canceled,
        canceledAt: endedAt,
        error: message,
      })
      .where(eq(taskRuns.id, taskRun.id));

    // Derive the task state from all its runs. Enqueue-failure cancels bypass
    // finishRun entirely, so this transaction must either commit both state
    // changes or surface the cancellation failure to the producer.
    await syncTaskStateFromRuns(tx, taskRun.taskId);
  });
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
    throw new Error('Cannot create task run for disabled deployment.');
  }
}

function resolveCodeReviewModelId(
  persistedConfig: import('@roomote/types').DeploymentModelConfig,
): string | null {
  const envCodeReviewModel = isConfiguredEnvValue(
    process.env.R_CODE_REVIEW_MODEL,
  )
    ? process.env.R_CODE_REVIEW_MODEL!.trim()
    : null;

  return envCodeReviewModel ?? persistedConfig.roomoteCodeReviewModel;
}

async function resolveRequestedHarness(
  task: TaskSpec,
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

function getInitialTaskPrompt(task: TaskSpec): string | undefined {
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
  task: TaskSpec,
): 'explain-repo-code' | 'plan-repo-implementation' | undefined {
  if (task.type !== TaskPayloadKind.StandardTask) {
    return undefined;
  }

  return task.payload.bootstrap?.skill;
}

export class TaskRunQueue {
  private redis: Redis;
  private readonly timeout: number;

  constructor({ redis, timeout = 10 }: { redis: Redis; timeout?: number }) {
    this.redis = redis;
    this.timeout = timeout;

    if (timeout < 1 || timeout > 30) {
      throw new Error('Timeout must be between 1 and 30 seconds.');
    }
  }

  public async enqueue(entry: TaskRunQueueEntry): Promise<TaskRunQueueEntry[]> {
    const evictedEntries: TaskRunQueueEntry[] = [];
    const legacyEntries = await this.redis.lrange(
      TaskRunQueueKeys.LegacyQueue,
      0,
      -1,
    );

    for (const rawValue of legacyEntries) {
      try {
        const legacyEntry = taskRunQueueEntrySchema.parse(JSON.parse(rawValue));

        if (legacyEntry.scope !== entry.scope) {
          continue;
        }

        const removed = await this.redis.lrem(
          TaskRunQueueKeys.LegacyQueue,
          0,
          rawValue,
        );

        if (removed > 0 && legacyEntry.id !== entry.id) {
          evictedEntries.push(legacyEntry);
        }
      } catch {
        // Leave malformed legacy entries for dequeue to discard.
      }
    }

    const result = await this.redis.eval(
      ATOMIC_ENQUEUE_SCRIPT,
      4,
      TaskRunQueueKeys.Queue,
      TaskRunQueueKeys.Scopes,
      TaskRunQueueKeys.Entries,
      TaskRunQueueKeys.EntryScopes,
      entry.id.toString(),
      entry.scope,
      JSON.stringify(entry),
    );

    if (typeof result !== 'string') {
      throw new Error('Atomic queue enqueue returned an invalid result.');
    }

    if (result) {
      evictedEntries.push({ id: Number(result), scope: entry.scope });
    }

    return evictedEntries;
  }

  public async dequeue(blocking = true): Promise<TaskRunQueueEntry | null> {
    const deadline = Date.now() + this.timeout * 1000;

    do {
      const legacyRawValue = await this.redis.lpop(
        TaskRunQueueKeys.LegacyQueue,
      );

      if (legacyRawValue) {
        try {
          const legacyEntry = taskRunQueueEntrySchema.parse(
            JSON.parse(legacyRawValue),
          );
          const acquired = await this.redis.set(
            legacyEntry.scope,
            legacyEntry.id,
            'EX',
            Math.ceil(TASK_TIMEOUT_MS / 1000),
            'NX',
          );

          if (acquired === 'OK') {
            console.log(
              `[TaskRunQueue] acquired lock for ${legacyEntry.scope}`,
            );
            return legacyEntry;
          }

          await this.redis.rpush(TaskRunQueueKeys.LegacyQueue, legacyRawValue);
        } catch {
          // Invalid legacy entries are intentionally discarded.
        }
      }

      const rawValue = await this.redis.eval(
        ATOMIC_DEQUEUE_SCRIPT,
        4,
        TaskRunQueueKeys.Queue,
        TaskRunQueueKeys.Scopes,
        TaskRunQueueKeys.Entries,
        TaskRunQueueKeys.EntryScopes,
        Math.ceil(TASK_TIMEOUT_MS / 1000).toString(),
      );

      if (!rawValue) {
        if (!blocking || Date.now() >= deadline) {
          return null;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, DEQUEUE_POLL_INTERVAL_MS),
        );
        continue;
      }

      try {
        const entry = taskRunQueueEntrySchema.parse(
          JSON.parse(String(rawValue)),
        );
        console.log(`[TaskRunQueue] acquired lock for ${entry.scope}`);
        return entry;
      } catch {
        continue;
      }
    } while (blocking && Date.now() < deadline);

    return null;
  }

  public async releaseLock(scope: string, ownerId: number): Promise<boolean> {
    const result = await this.redis.eval(
      RELEASE_OWNED_LOCK_SCRIPT,
      1,
      scope,
      ownerId.toString(),
    );
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

  static queue: TaskRunQueue | null = null;

  static getInstance(): TaskRunQueue {
    if (!TaskRunQueue.queue) {
      TaskRunQueue.queue = new TaskRunQueue({ redis: getRedis() });
    }

    return TaskRunQueue.queue;
  }
}

export class TaskRunQueueEnqueueError extends Error {
  public readonly runId: number;
  public readonly taskId: string;
  public readonly originalError: unknown;

  constructor(params: {
    runId: number;
    taskId: string;
    originalError: unknown;
  }) {
    super(
      `Failed to enqueue task run ${params.runId}: ${getErrorMessage(
        params.originalError,
        'Unknown queue error',
      )}`,
    );
    this.name = 'TaskRunQueueEnqueueError';
    this.runId = params.runId;
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
 * Disambiguation strategy for PR review and conflict-resolution workflows:
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

export interface EnqueueTaskOptions {
  /**
   * Optional explicit launch-class override used to resolve runtime keepalive
   * policy. When omitted, automation-initiated launches derive the
   * 'automation' class from the initiator and everything else falls back to
   * the payload-kind inference.
   */
  launchClass?: RunLaunchClass;
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
  initialStatus?: RunStatus.Pending | RunStatus.Dequeued;
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
    taskRun: TaskRun,
  ) => Promise<void>;
  /**
   * Runs after the run row is created but before it is pushed onto the
   * controller queue. If this throws, the run is canceled and never queued.
   */
  beforeEnqueue?: (taskRun: TaskRun) => Promise<void>;
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

type FreshTask = Exclude<
  TaskSpec,
  { type: typeof TaskPayloadKind.SnapshotResume }
>;

/**
 * A fresh launch creates a tasks row (initiator stamp, classification,
 * commit-author block, channel bindings) plus its first run.
 */
export type FreshTaskLaunch = {
  task: FreshTask;
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
export type ResumeTaskLaunch = {
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

export type EnqueueTaskInput = FreshTaskLaunch | ResumeTaskLaunch;

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

function getRunLockScope(taskRun: TaskRun): string | null {
  if (taskRun.queueScope) {
    return taskRun.queueScope;
  }

  // Compatibility for rows created before queue_scope was introduced. PR
  // scopes were deterministic; unique scopes were not and cannot be safely
  // reconstructed after the fact.
  if (PR_SCOPED_PAYLOAD_KINDS.has(taskRun.payloadKind)) {
    const payload = taskRun.payload as { repo?: string; prNumber?: number };

    if (payload.repo && typeof payload.prNumber === 'number') {
      return `${payload.repo}:${payload.prNumber}`;
    }
  }

  return null;
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
    throw new Error('Cannot create task run for deleted user.');
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
  task: TaskSpec,
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
  taskRun: TaskRun;
  scope: string;
  options: EnqueueTaskOptions;
}): Promise<void> {
  const { taskRun, scope, options } = params;

  if (options.enqueue === false) {
    return;
  }

  if (options.beforeEnqueue) {
    try {
      await options.beforeEnqueue(taskRun);
    } catch (error) {
      const message = getErrorMessage(error, 'Failed before task run enqueue');

      try {
        await cancelTaskRunBeforeQueue(taskRun, message);
      } catch (cancelError) {
        throw new AggregateError(
          [error, cancelError],
          `beforeEnqueue and cancellation both failed for task run ${taskRun.id}`,
        );
      }

      throw error;
    }
  }

  try {
    await db
      .update(taskRuns)
      .set({ queueScope: scope })
      .where(eq(taskRuns.id, taskRun.id));

    const evictedEntries = await TaskRunQueue.getInstance().enqueue({
      id: taskRun.id,
      scope,
    });

    if (evictedEntries.length > 0) {
      await db.transaction(async (tx) => {
        const endedAt = new Date();
        const evictedIds = evictedEntries.map((entry) => entry.id);
        const canceledRuns = await tx
          .update(taskRuns)
          .set({
            status: RunStatus.Canceled,
            canceledAt: endedAt,
            error: 'Superseded by a newer task run.',
          })
          .where(
            and(
              inArray(taskRuns.id, evictedIds),
              eq(taskRuns.status, RunStatus.Pending),
            ),
          )
          .returning({ id: taskRuns.id, taskId: taskRuns.taskId });

        for (const canceledRun of canceledRuns) {
          await syncTaskStateFromRuns(tx, canceledRun.taskId);
          await markTaskStartParallelCountEndedAt(tx, {
            runId: canceledRun.id,
            endedAt,
          });

          console.log(`[TaskRunQueue] evicted ${canceledRun.id} (${scope})`);
        }
      });
    }
  } catch (error) {
    let originalError = error;

    try {
      await cancelTaskRunBeforeQueue(
        taskRun,
        getErrorMessage(error, 'Failed to enqueue task run'),
      );
    } catch (cancelError) {
      originalError = new AggregateError(
        [error, cancelError],
        `Queue enqueue and cancellation both failed for task run ${taskRun.id}`,
      );
    }

    throw new TaskRunQueueEnqueueError({
      runId: taskRun.id,
      taskId: taskRun.taskId,
      originalError,
    });
  }

  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM task_runs WHERE id = ${taskRun.id} FOR UPDATE`,
      );

      const persistedRun = await tx.query.taskRuns.findFirst({
        where: eq(taskRuns.id, taskRun.id),
        columns: {
          status: true,
          canceledAt: true,
          completedAt: true,
        },
      });

      if (
        !persistedRun ||
        persistedRun.status === RunStatus.Canceled ||
        persistedRun.canceledAt !== null ||
        persistedRun.completedAt !== null
      ) {
        return;
      }

      await recordTaskStartParallelCount(tx, {
        runId: taskRun.id,
        payloadKind: taskRun.payloadKind,
        taskId: taskRun.taskId,
        startedAt: new Date(),
      });
    });
  } catch (loggingError) {
    console.warn(
      `[enqueueTask] Failed to record task-start parallel count for run ${taskRun.id}: ${
        loggingError instanceof Error
          ? loggingError.message
          : String(loggingError)
      }`,
    );
  }
}

export async function enqueueTask(
  input: EnqueueTaskInput,
  options: EnqueueTaskOptions = {},
): Promise<TaskRun> {
  await assertDeploymentIsActive();

  if (input.task.type === TaskPayloadKind.SnapshotResume) {
    return enqueueSnapshotResume(input as ResumeTaskLaunch, options);
  }

  return enqueueFreshLaunch(input as FreshTaskLaunch, options);
}

async function enqueueFreshLaunch(
  input: FreshTaskLaunch,
  options: EnqueueTaskOptions,
): Promise<TaskRun> {
  const { task, initiator, workflow, surface, trigger } = input;
  const visibility: TaskVisibility = input.visibility ?? 'visible';
  const linkedUserId = getTaskInitiatorLinkedUserId(initiator);

  await assertUserIsNotDeleted(linkedUserId);

  if (PR_LINKAGE_REQUIRED_WORKFLOWS.has(workflow) && !input.prLinkage) {
    throw new Error(
      `A '${workflow}' launch requires prLinkage so the pull request row can be created with the task.`,
    );
  }

  // Auto-resolve environment for PR tasks when no environmentId is set.
  // This allows PR review/follow-up jobs to benefit from project configuration
  // (setup commands, env vars, services, task instructions).
  const PR_TASK_TYPES = new Set<TaskPayloadKind>([
    TaskPayloadKind.GithubPrReview,
    TaskPayloadKind.GithubPrReviewSync,
    TaskPayloadKind.GithubPrReviewFollowUp,
  ]);
  const workspace = resolveTaskWorkspace(task.payload);

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
        `[enqueueTask] Auto-resolved environment ${envId} for ${workspace.repo}`,
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
      sourceRunHarnessModelOverrides: undefined,
      deploymentMetadata: resolvedHarness.deploymentMetadata,
      deploymentTaskModelSettings: resolvedHarness.deploymentTaskModelSettings,
      deploymentCodeReviewModelId:
        resolvedHarness.deploymentCodeReviewModelId ?? null,
    });

  const repositoryName = taskWithHarnessOverrides.payload.repo || null;
  const resolvedTaskPolicy = resolveTaskRuntimePolicy({
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

  const title = generateTaskRunTitle(
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
  const taskRun = await db.transaction(async (tx) => {
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
        modelProvider: DEFAULT_STANDARD_TASK_MODEL_PROVIDER,
        model: effectiveTaskModel,
        title,
        ...(hasDeterministicTaskRunTitle(taskWithHarnessOverrides.type)
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
        status: options.initialStatus ?? RunStatus.Pending,
        ...(options.initialStatus === RunStatus.Dequeued
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
      taskType: taskRun.payloadKind,
      workflow,
      surface,
      trigger,
      harness: taskRun.harness ?? null,
      model: effectiveTaskModel,
      computeProvider: taskRun.vendor ?? null,
    },
  });

  await pushRunOntoQueue({
    taskRun,
    scope: resolveQueueScope({
      workflow,
      payloadKind: taskRun.payloadKind,
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
    !hasDeterministicTaskRunTitle(task.type) &&
    typeof description === 'string' &&
    description.trim()
  ) {
    void (async () => {
      try {
        const generatedTitle = await generateLlmTaskTitle({
          userId: linkedUserId,
          taskId: taskRun.taskId,
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
              eq(tasks.id, taskRun.taskId),
              isNull(tasks.titleEditedByUserAt),
              lt(tasks.llmTitleCheckpoint, 1),
            ),
          );
      } catch (error) {
        console.warn(
          `[enqueueTask] Failed to generate early LLM title for task ${taskRun.taskId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    })();
  }

  return taskRun;
}

async function enqueueSnapshotResume(
  input: ResumeTaskLaunch,
  options: EnqueueTaskOptions,
): Promise<TaskRun> {
  const { task } = input;
  const actingUserId = options.skipInitialActingUser
    ? null
    : (input.actingUserId ?? null);

  const sourceRunId = task.sourceRunId ?? task.payload.sourceRunId;
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
  const sourceRunHarnessModelOverrides = (
    sourceRun.payload as {
      harnessModelOverrides?: import('@roomote/types').HarnessModelOverrides;
    }
  )?.harnessModelOverrides;

  if (task.harness && sourceJobHarness !== task.harness) {
    console.warn(
      `[enqueueTask] SnapshotResume harness override: requested=${task.harness}, source=${sourceJobHarness}`,
    );
  }

  if (
    sourceJobVendor &&
    task.computeProvider &&
    sourceJobVendor !== task.computeProvider
  ) {
    console.warn(
      `[enqueueTask] SnapshotResume computeProvider override: requested=${task.computeProvider}, source=${sourceJobVendor}`,
    );
  }

  const resolvedHarness = await resolveRequestedHarness(task);
  const targetHarness = sourceJobHarness ?? resolvedHarness.harness;
  const { task: taskWithHarnessOverrides } = resolveEffectiveHarnessModelState({
    task,
    targetHarness,
    isSnapshotResume: true,
    sourceRunHarnessModelOverrides,
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

  const resolvedTaskPolicy = resolveTaskRuntimePolicy({
    taskType: TaskPayloadKind.SnapshotResume,
    launchClass: options.launchClass,
    appEnv: Env.APP_ENV ?? 'development',
    defaultKeepaliveMs: DEFAULT_KEEPALIVE_MS,
    delegatedKeepaliveMs: DEFAULT_DELEGATED_KEEPALIVE_MS,
    sandboxTimeoutMs: TASK_TIMEOUT_MS,
  });

  let taskRun: TaskRun;

  try {
    taskRun = await db.transaction(async (tx) => {
      const [insertedRun] = await tx
        .insert(taskRuns)
        .values({
          taskId: sourceRun.taskId,
          kind: 'resume',
          sourceRunId: sourceRun.id,
          payloadKind: TaskPayloadKind.SnapshotResume,
          actingUserId,
          status: options.initialStatus ?? RunStatus.Pending,
          ...(options.initialStatus === RunStatus.Dequeued
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
      taskType: taskRun.payloadKind,
      harness: taskRun.harness ?? null,
      computeProvider: taskRun.vendor ?? null,
    },
  });

  await recordSnapshotResumeRequestEvent({
    runId: sourceRun.id,
    taskId: sourceRun.taskId,
    eventType: 'enqueued',
    message: `Created SnapshotResume run #${taskRun.id}.`,
    details: {
      stage: 'request',
      sourceRunId: sourceRun.id,
      sourceSnapshotId: sourceSnapshotId ?? null,
      resumeRunId: taskRun.id,
      resumeTaskId: taskRun.taskId,
      actingUserId,
    },
  });

  await pushRunOntoQueue({
    taskRun,
    scope: randomUUID(),
    options,
  });

  return taskRun;
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
      `[enqueueTask] Failed to persist snapshot resume event for source run #${input.runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function dequeueTaskRun(): Promise<number | null> {
  const entry = await TaskRunQueue.getInstance().dequeue();
  return entry ? entry.id : null;
}

export function releaseTaskRun(taskRun: TaskRun): Promise<boolean> {
  const scope = getRunLockScope(taskRun);

  return scope
    ? TaskRunQueue.getInstance().releaseLock(scope, taskRun.id)
    : Promise.resolve(false);
}

export async function isTaskRunLocked(taskRun: TaskRun): Promise<boolean> {
  const scope = getRunLockScope(taskRun);
  return scope ? TaskRunQueue.getInstance().isLocked(scope) : false;
}

export async function getTaskRunLockTTL(taskRun: TaskRun): Promise<number> {
  const scope = getRunLockScope(taskRun);
  return scope ? TaskRunQueue.getInstance().getLockTTL(scope) : -2;
}
