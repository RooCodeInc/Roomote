import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  type BackgroundAutomationKey,
  type TaskSpec,
  type CodingHarness,
  type ComputeProvider,
  type SnapshotResumeTask,
  type RunLaunchClass,
  type SourceControlProvider,
  type TaskInitiator,
  type TaskGoalInput,
  type TaskSurface,
  type TaskTrigger,
  type TaskVisibility,
  type TaskWorkflow,
  type TaskPhase,
  RunStatus,
  TaskPayloadKind,
  TASK_KICKOFF_MESSAGE_SOURCE,
  activeRunStatuses,
  DEFAULT_DELEGATED_KEEPALIVE_MS,
  DEFAULT_KEEPALIVE_MS,
  DEFAULT_LAUNCH_CODING_HARNESS,
  getDisplayModelProviderId,
  getTaskInitiatorLinkedUserId,
  getFastAgentParentFromPayload,
  getTaskReportConsumerFromPayload,
  getPrimaryPortFromConfig,
  isConfiguredEnvValue,
  isReasoningEffort,
  MANAGED_DEPLOYMENT_READ_ONLY_MESSAGE,
  normalizeDeploymentModelConfig,
  resolveTaskRuntimePolicy,
  resolveTaskWorkspace,
  resolveComputeProviderTarget,
  populateCommunicationMetadata,
  sourceControlProviderSchema,
  TASK_TIMEOUT_MS,
  isManagedDeploymentReadOnly,
  isRoomoteDeploymentDisabled,
} from '@roomote/types';
import { Env, isRoomoteCloudEnabled } from '@roomote/env';
import {
  type TaskRun,
  type DatabaseTransaction,
  db,
  deploymentSettings,
  ensureAutomationRowsOnce,
  ensureSessionForTask,
  isChatGptSubscriptionConnected,
  createTaskWithRetry,
  markTaskStartParallelCountEndedAt,
  projectPendingPrReviewEventsForAssociation,
  recordTaskStartParallelCount,
  syncTaskStateFromRuns,
  taskPullRequests,
  taskRuns,
  taskMessages,
  tasks,
  users,
  environments,
  sessions,
  sessionTasks,
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  recordSnapshotResumeEvent,
  resolveDefaultComputeProvider,
  resolveWorkspaceRepositoryProviders,
  resolveWorkspaceSourceControlHost,
  sql,
} from '@roomote/db/server';
import { type Redis, getRedis } from '@roomote/redis';
import {
  captureActivationTaskCreated,
  captureEvent,
  captureTaskSettled,
} from '@roomote/telemetry/server';
import { generateTaskRunTitle, hasDeterministicTaskRunTitle } from '../utils';
import { DEFAULT_STANDARD_TASK_MODEL_PROVIDER } from '../task-runtime-defaults';
import {
  evaluateCommitAuthor,
  findLatestGithubIdentityForUser,
  type MatchedHumanActor,
} from './commit-author';
import { resolveEffectiveHarnessModelState } from './harness-model-overrides';
import {
  generateLlmTaskTitle,
  isFallbackTaskTitle,
  LLM_TITLE_LOCKED_CHECKPOINT,
} from './llm-task-title';
import { resolveRequestedWorkKindDecision } from './requested-work-kind';

enum TaskRunQueueKeys {
  // Keep the v2 layout during the debounce rollout. Old and new producers and
  // controllers must see the same entries while they coexist.
  Queue = 'queue:cloud-jobs:v2',
  Entries = 'queue:cloud-jobs:v2:entries',
  EntryScopes = 'queue:cloud-jobs:v2:entry-scopes',
  Scopes = 'queue:cloud-jobs:v2:scopes',
}

const SNAPSHOT_RESUME_ADVISORY_LOCK_NAMESPACE = 0x52534d45;

/** True when the error (or any of its causes) is a Postgres deadlock (40P01). */
function isPostgresDeadlockError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (
      typeof current === 'object' &&
      current !== null &&
      'code' in current &&
      (current as { code?: unknown }).code === '40P01'
    ) {
      return true;
    }
    current =
      typeof current === 'object' && current !== null && 'cause' in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

export class SnapshotResumeAlreadyExistsError extends Error {
  constructor(public readonly existingRunId: number) {
    super(`Snapshot resume run ${existingRunId} already exists.`);
    this.name = 'SnapshotResumeAlreadyExistsError';
  }
}

export function resolveFreshTaskComputeProvider(
  provider: string | null | undefined,
  fallback: ComputeProvider,
  taskType?: TaskPayloadKind,
  cloudEnabled = isRoomoteCloudEnabled(Env.R_CLOUD_ENABLED),
): ComputeProvider {
  // Managed deployments own the sandbox lifecycle, so fresh work must not
  // escape to a previously configured bring-your-own provider.
  return cloudEnabled && taskType !== TaskPayloadKind.SnapshotEnvironment
    ? 'roomote'
    : resolveComputeProviderTarget(provider, fallback);
}

export function shouldCaptureTaskCreatedEvent(
  taskType: TaskPayloadKind,
): boolean {
  // Environment snapshots are maintenance work, not product task activity.
  return taskType !== TaskPayloadKind.SnapshotEnvironment;
}

/** Activation counts only fresh, human-initiated product tasks. */
export function shouldCaptureActivationTaskCreatedEvent(input: {
  taskType: TaskPayloadKind;
  workflow: TaskWorkflow;
  initiator: TaskInitiator;
  sourceRunId?: number | null;
  environmentDefinitionId?: string;
  verifiesEnvironmentId?: string;
}): boolean {
  return (
    input.initiator.kind === 'user' &&
    input.workflow === 'standard' &&
    input.taskType !== TaskPayloadKind.SnapshotEnvironment &&
    input.sourceRunId == null &&
    input.environmentDefinitionId == null &&
    input.verifiesEnvironmentId == null
  );
}

const ATOMIC_ENQUEUE_SCRIPT = `
local incomingId = ARGV[1]
local incomingScope = ARGV[2]
local incomingRaw = ARGV[3]
local delayMs = tonumber(ARGV[4]) or 0
local evictedIds = {}

local existingId = redis.call('HGET', KEYS[2], incomingScope)

if ARGV[5] == '1' and existingId then
  return {incomingId}
end

if existingId then
  redis.call('LREM', KEYS[1], 0, existingId)

  if existingId ~= incomingId then
    table.insert(evictedIds, existingId)
    redis.call('HDEL', KEYS[3], existingId)
    redis.call('HDEL', KEYS[4], existingId)
  end
end

local existingLock = redis.call('GET', incomingScope)
local existingDelayOwner = existingId and ('delay:' .. existingId) or nil

if delayMs > 0 then
  if not existingLock or existingLock == existingDelayOwner then
    redis.call('PSETEX', incomingScope, delayMs, 'delay:' .. incomingId)
  end
elseif existingLock == existingDelayOwner then
  redis.call('DEL', incomingScope)
end

redis.call('HSET', KEYS[2], incomingScope, incomingId)
redis.call('HSET', KEYS[3], incomingId, incomingRaw)
redis.call('HSET', KEYS[4], incomingId, incomingScope)
redis.call('RPUSH', KEYS[1], incomingId)

return evictedIds
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
  availableAt: z.number().int().nonnegative().optional(),
  preserveExisting: z.boolean().optional(),
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

  const canceled = await db.transaction(async (tx) => {
    const [canceledRun] = await tx
      .update(taskRuns)
      .set({
        status: RunStatus.Canceled,
        canceledAt: endedAt,
        error: message,
      })
      .where(
        and(
          eq(taskRuns.id, taskRun.id),
          eq(taskRuns.status, RunStatus.Pending),
        ),
      )
      .returning({ id: taskRuns.id });

    if (!canceledRun) {
      return false;
    }

    // Derive the task state from all its runs. Enqueue-failure cancels bypass
    // finishRun entirely, so this transaction must either commit both state
    // changes or surface the cancellation failure to the producer.
    await syncTaskStateFromRuns(tx, taskRun.taskId);
    return true;
  });

  if (canceled) {
    void captureTaskSettled(taskRun.id, RunStatus.Canceled);
  }
}

async function cancelEvictedTaskRuns(
  entries: TaskRunQueueEntry[],
  message: string,
): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  const canceledRuns = await db.transaction(async (tx) => {
    const endedAt = new Date();
    const canceledRuns = await tx
      .update(taskRuns)
      .set({
        status: RunStatus.Canceled,
        canceledAt: endedAt,
        error: message,
      })
      .where(
        and(
          inArray(
            taskRuns.id,
            entries.map((entry) => entry.id),
          ),
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
    }

    return canceledRuns;
  });

  for (const canceledRun of canceledRuns) {
    void captureTaskSettled(canceledRun.id, RunStatus.Canceled);
  }
}

async function resolveMatchedHumanActor(
  tx: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  linkedUserId: string | null,
): Promise<MatchedHumanActor | null> {
  if (!linkedUserId) {
    return null;
  }

  const githubIdentity = await findLatestGithubIdentityForUser(
    tx,
    linkedUserId,
  );

  return {
    userId: linkedUserId,
    githubLogin: githubIdentity.githubLogin,
    githubUserId: githubIdentity.githubUserId,
  };
}

type ResolvedHarnessSelection = {
  harness: CodingHarness;
  deploymentTaskModelSettings?:
    | import('@roomote/types').TaskModelSettings
    | null;
  deploymentCodeReviewModelId?: string | null;
  deploymentCodeReviewReasoningEffort?:
    | import('@roomote/types').ReasoningEffort
    | null;
  deploymentCodingReasoningEffort?:
    | import('@roomote/types').ReasoningEffort
    | null;
};

const DEFAULT_DEPLOYMENT_ID = 'default';

export class DeploymentReadOnlyError extends Error {
  readonly code = 'deployment_read_only';

  constructor() {
    super(MANAGED_DEPLOYMENT_READ_ONLY_MESSAGE);
    this.name = 'DeploymentReadOnlyError';
  }
}

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

  if (isManagedDeploymentReadOnly(deployment?.metadata)) {
    throw new DeploymentReadOnlyError();
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

function resolveCodingReasoningEffort(
  persistedConfig: import('@roomote/types').DeploymentModelConfig,
): import('@roomote/types').ReasoningEffort | null {
  const envEffort = process.env.R_MODEL_REASONING_EFFORT?.trim();

  return isReasoningEffort(envEffort)
    ? envEffort
    : persistedConfig.roomoteModelReasoningEffort;
}

function resolveCodeReviewReasoningEffort(
  persistedConfig: import('@roomote/types').DeploymentModelConfig,
): import('@roomote/types').ReasoningEffort | null {
  const envEffort = process.env.R_CODE_REVIEW_MODEL_REASONING_EFFORT?.trim();

  return isReasoningEffort(envEffort)
    ? envEffort
    : persistedConfig.roomoteCodeReviewModelReasoningEffort;
}

async function resolveRequestedHarness(
  task: TaskSpec,
): Promise<ResolvedHarnessSelection> {
  const deployment = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: {
      taskModelSettings: true,
      runtimeModelConfig: true,
    },
  });
  const deploymentModelConfig = normalizeDeploymentModelConfig(
    deployment?.runtimeModelConfig,
  );

  return {
    harness: task.harness ?? DEFAULT_LAUNCH_CODING_HARNESS,
    deploymentTaskModelSettings: deployment?.taskModelSettings ?? null,
    deploymentCodeReviewModelId: resolveCodeReviewModelId(
      deploymentModelConfig,
    ),
    deploymentCodeReviewReasoningEffort: resolveCodeReviewReasoningEffort(
      deploymentModelConfig,
    ),
    deploymentCodingReasoningEffort: resolveCodingReasoningEffort(
      deploymentModelConfig,
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
      Math.max(0, (entry.availableAt ?? 0) - Date.now()).toString(),
      entry.preserveExisting ? '1' : '0',
    );

    if (!Array.isArray(result)) {
      throw new Error('Atomic queue enqueue returned an invalid result.');
    }

    for (const evictedId of result) {
      evictedEntries.push({ id: Number(evictedId), scope: entry.scope });
    }

    return evictedEntries;
  }

  public async dequeue(blocking = true): Promise<TaskRunQueueEntry | null> {
    const deadline = Date.now() + this.timeout * 1000;

    do {
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
  /** Optional pre-runtime phase shown while a persisted run is intentionally deferred. */
  initialTaskPhase?: TaskPhase;
  /** Optional actionable error attached to an intentionally deferred run. */
  initialError?: string | null;
  /**
   * Avoid best-effort LLM title generation for short-lived synthetic jobs.
   */
  skipEarlyTitleGeneration?: boolean;
  /**
   * Best-effort surface callback after the canonical early LLM title is
   * generated. The task title is persisted before this callback runs.
   */
  onEarlyTitleGenerated?: (input: {
    taskRun: TaskRun;
    title: string;
  }) => Promise<void> | void;
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

export async function persistEarlyGeneratedTaskTitle(input: {
  taskId: string;
  generatedTitle: string;
  /**
   * When false, store the generated title but leave checkpoint 0 open so the
   * first-message transcript path can retry surface sync (Discord/Telegram
   * rename). Surfaces pass false when their onEarlyTitleGenerated callback
   * failed after the title was produced.
   */
  lockFirstMessageCheckpoint?: boolean;
}): Promise<boolean> {
  // Do not advance the checkpoint on fallback titles. Checkpoint 1 is the
  // first-message refresh gate; locking it without a real title prevents the
  // transcript path from producing a nicer title on the opening user prompt.
  if (isFallbackTaskTitle(input.generatedTitle)) {
    return false;
  }
  const lockFirstMessageCheckpoint = input.lockFirstMessageCheckpoint !== false;
  const [updatedTask] = await db
    .update(tasks)
    .set({
      ...(lockFirstMessageCheckpoint ? { llmTitleCheckpoint: 1 } : {}),
      updatedAt: new Date(),
      title: input.generatedTitle,
    })
    .where(
      and(
        eq(tasks.id, input.taskId),
        isNull(tasks.titleEditedByUserAt),
        lt(tasks.llmTitleCheckpoint, 1),
      ),
    )
    .returning({ id: tasks.id });

  return Boolean(updatedTask);
}

/**
 * PR linkage persisted as a task_pull_requests row inside the create
 * transaction. Required for 'pr_review' and 'pr_conflict_resolve' launches;
 * callers have all of this from the triggering webhook.
 */
export type TaskPrLinkage = {
  provider: SourceControlProvider;
  host?: string | null;
  /** Optional FK to the provider-scoped `repositories` row when known. */
  repositoryId?: string | null;
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
 * A fresh launch normally creates a tasks row (initiator stamp,
 * classification, commit-author block, channel bindings) plus its first run.
 * `existingTaskId` attaches another fresh run to an existing durable task.
 */
export type FreshTaskLaunch = {
  task: FreshTask;
  /** Reuse the durable task identity for a later PR review run. */
  existingTaskId?: string;
  goal?: TaskGoalInput;
  /** Explicit user-facing title. Locked against all LLM title generation. */
  title?: string;
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

export const PR_REVIEW_SYNC_DEBOUNCE_MS = 5_000;

export function resolvePrReviewQueuePolicy({
  payloadKind,
  sourceControlProvider = 'github',
  now = Date.now(),
}: {
  payloadKind: TaskPayloadKind;
  sourceControlProvider?: SourceControlProvider;
  now?: number;
}): Pick<TaskRunQueueEntry, 'availableAt' | 'preserveExisting'> {
  const shouldDebounce =
    payloadKind === TaskPayloadKind.GithubPrReviewSync &&
    sourceControlProvider === 'github';

  return shouldDebounce
    ? {
        availableAt: now + PR_REVIEW_SYNC_DEBOUNCE_MS,
        preserveExisting: true,
      }
    : {};
}

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

    const sourceControlProvider =
      'sourceControlProvider' in taskRun.payload
        ? taskRun.payload.sourceControlProvider
        : undefined;
    const queuePolicy = resolvePrReviewQueuePolicy({
      payloadKind: taskRun.payloadKind,
      sourceControlProvider,
    });
    const evictedEntries = await TaskRunQueue.getInstance().enqueue({
      id: taskRun.id,
      scope,
      ...queuePolicy,
    });

    await cancelEvictedTaskRuns(
      evictedEntries,
      'Superseded by a newer task run.',
    );
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

/**
 * Places an already-persisted pending run onto the controller queue. This is
 * used when an external readiness gate (such as first-time hosted compute
 * provisioning) releases a run that was created with `enqueue: false`.
 */
export async function queuePersistedTaskRun(taskRun: TaskRun): Promise<void> {
  await assertDeploymentIsActive();

  await pushRunOntoQueue({
    taskRun,
    scope: taskRun.queueScope ?? randomUUID(),
    options: {},
  });
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

async function inheritSourceCommunicationMetadata(
  task: FreshTask,
): Promise<void> {
  const sourceRunId = task.communicationContextSourceRunId;
  if (!sourceRunId) return;

  const sourceRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, sourceRunId),
    columns: { payload: true },
    with: {
      task: {
        columns: { slackChannelId: true, slackThreadTs: true },
      },
    },
  });

  if (!sourceRun) return;

  const payload = task.payload as Record<string, unknown>;

  // A launch that carries its own live context stays a live chat turn.
  if (payload.communicationProvider != null) return;

  populateCommunicationMetadata(payload, {
    sourcePayload: sourceRun.payload,
    channelId: sourceRun.task?.slackChannelId,
    threadId: sourceRun.task?.slackThreadTs,
  });

  // Slack parents keep their coordinates in task columns rather than
  // provider-neutral payload fields, so the provider needs stamping here.
  if (payload.communicationProvider == null && sourceRun.task?.slackChannelId) {
    payload.communicationProvider = 'slack';
  }

  // Only flag payloads that actually gained coordinates from the parent.
  if (payload.communicationProvider != null) {
    payload.communicationContextInherited = true;
  }
}

async function enqueueFreshLaunch(
  input: FreshTaskLaunch,
  options: EnqueueTaskOptions,
): Promise<TaskRun> {
  const { task, initiator, workflow, surface, trigger } = input;
  const visibility: TaskVisibility = input.visibility ?? 'visible';
  const linkedUserId = getTaskInitiatorLinkedUserId(initiator);
  await assertUserIsNotDeleted(linkedUserId);

  const requestedExistingTask = input.existingTaskId
    ? await db.query.tasks.findFirst({
        where: and(eq(tasks.id, input.existingTaskId), isNull(tasks.deletedAt)),
        columns: {
          id: true,
          workflow: true,
          harness: true,
        },
      })
    : null;

  if (input.existingTaskId && !requestedExistingTask) {
    throw new Error(`Task ${input.existingTaskId} was not found.`);
  }

  if (requestedExistingTask && workflow !== 'pr_review') {
    throw new Error('Only PR review launches can reuse an existing task.');
  }

  if (requestedExistingTask && requestedExistingTask.workflow !== workflow) {
    throw new Error(
      `Task ${requestedExistingTask.id} uses workflow '${requestedExistingTask.workflow}', not '${workflow}'.`,
    );
  }

  // Child launches inherit the provider-neutral origin coordinates so the
  // agent can see where the parent conversation started.
  await inheritSourceCommunicationMetadata(task);

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

  await stampWorkspaceSourceControlProviders(task.payload, workspace);

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
      await stampWorkspaceSourceControlProviders(task.payload, {
        type: 'environment',
        environmentId: envId,
      });

      console.log(
        `[enqueueTask] Auto-resolved environment ${envId} for ${workspace.repo}`,
      );
    }
  }

  const { initialPaths } = await resolveEnvironmentContext(task);

  const resolvedHarness = await resolveRequestedHarness(task);
  const targetHarness =
    requestedExistingTask?.harness ?? resolvedHarness.harness;
  const { task: taskWithHarnessOverrides, model: effectiveTaskModel } =
    resolveEffectiveHarnessModelState({
      task,
      targetHarness,
      isSnapshotResume: false,
      sourceRunHarnessModelOverrides: undefined,
      deploymentTaskModelSettings: resolvedHarness.deploymentTaskModelSettings,
      deploymentCodeReviewModelId:
        resolvedHarness.deploymentCodeReviewModelId ?? null,
      deploymentCodeReviewReasoningEffort:
        resolvedHarness.deploymentCodeReviewReasoningEffort ?? null,
      deploymentCodingReasoningEffort:
        resolvedHarness.deploymentCodingReasoningEffort ?? null,
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

  const explicitTitle = input.title?.trim() || null;
  const title =
    explicitTitle ??
    generateTaskRunTitle(
      taskWithHarnessOverrides,
      10_000,
      'description' in taskWithHarnessOverrides.payload &&
        taskWithHarnessOverrides.payload.description
        ? taskWithHarnessOverrides.payload.description
        : null,
    );
  const titleIsLocked =
    explicitTitle !== null ||
    hasDeterministicTaskRunTitle(taskWithHarnessOverrides.type);
  const targetComputeProvider = resolveFreshTaskComputeProvider(
    task.computeProvider,
    await resolveDefaultComputeProvider(),
    task.type,
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
  const initialGoalGeneration = input.goal
    ? `goal-generation:${randomUUID()}`
    : null;
  const externalGithubIdentity = {
    githubLogin: 'githubLogin' in task ? task.githubLogin : null,
    githubUserId: 'githubUserId' in task ? task.githubUserId : null,
  };

  const fastParent = getFastAgentParentFromPayload(
    taskWithHarnessOverrides.payload,
  );
  const launchIdempotencyKey =
    taskWithHarnessOverrides.payload.launchIdempotencyKey;

  // Fresh runs are persisted atomically with either a new task or the existing
  // durable task they continue.
  const runPersistTransaction = () =>
    db.transaction(async (tx) => {
      if (fastParent) {
        // Parallel launch_task calls from one Fast turn write the same
        // session and conversation rows; serializing per parent conversation
        // prevents lock-order deadlocks (40P01) between them.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`fast-parent-launch:${fastParent.sessionId}`}, 0))`,
        );
      }
      if (launchIdempotencyKey) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`task-launch:${launchIdempotencyKey}`}, 0))`,
        );
        const [existingRun] = await tx
          .select()
          .from(taskRuns)
          .where(
            and(
              sql`${taskRuns.payload}->>'launchIdempotencyKey' = ${launchIdempotencyKey}`,
              isNull(taskRuns.canceledAt),
            ),
          )
          .limit(1)
          .for('update');
        if (existingRun) {
          const existingFastParent = getFastAgentParentFromPayload(
            existingRun.payload,
          );
          if (
            fastParent &&
            existingFastParent?.sessionId !== fastParent.sessionId
          ) {
            throw new Error(
              'Launch idempotency key is already attached to another Fast Session.',
            );
          }
          if (fastParent) {
            const [existingSession] = await tx
              .select({ fastConversationId: sessions.fastConversationId })
              .from(sessionTasks)
              .innerJoin(sessions, eq(sessionTasks.sessionId, sessions.id))
              .where(eq(sessionTasks.taskId, existingRun.taskId))
              .limit(1);
            if (
              existingSession &&
              existingSession.fastConversationId !== fastParent.sessionId
            ) {
              throw new Error(
                'Launch idempotency key is already attached to another Session.',
              );
            }
          }
          await ensureSessionForTask(tx, {
            taskId: existingRun.taskId,
            fastConversationId: fastParent?.sessionId ?? null,
            origin: fastParent ? 'fast_delegation' : 'direct_launch',
            existingTaskReused: true,
          });
          return {
            taskRun: existingRun,
            createdRun: false,
            reusedTask: true,
          };
        }
      }
      const chatgptConnected = effectiveTaskModel.startsWith('openai/')
        ? await isChatGptSubscriptionConnected(tx)
        : false;
      const modelProvider =
        getDisplayModelProviderId(effectiveTaskModel, {
          chatgptConnected,
        }) ?? DEFAULT_STANDARD_TASK_MODEL_PROVIDER;

      const matchedHumanActor = await resolveMatchedHumanActor(
        tx,
        linkedUserId,
      );
      const commitAuthor = evaluateCommitAuthor({
        initiator,
        matchedHumanActor,
        externalGithubIdentity,
      });

      let existingTask = requestedExistingTask;

      if (workflow === 'pr_review' && input.prLinkage?.provider === 'github') {
        const canonicalKey = `${input.prLinkage.provider}:${input.prLinkage.repository}:${input.prLinkage.prNumber}`;
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${canonicalKey}, 0))`,
        );

        const [canonicalTask] = await tx
          .select({
            id: tasks.id,
            workflow: tasks.workflow,
            harness: tasks.harness,
          })
          .from(tasks)
          .innerJoin(taskPullRequests, eq(taskPullRequests.taskId, tasks.id))
          .where(
            and(
              eq(tasks.workflow, 'pr_review'),
              eq(
                taskPullRequests.sourceControlProvider,
                input.prLinkage.provider,
              ),
              eq(taskPullRequests.repository, input.prLinkage.repository),
              eq(taskPullRequests.prNumber, input.prLinkage.prNumber),
              isNull(tasks.deletedAt),
            ),
          )
          .orderBy(desc(tasks.createdAt))
          .limit(1);

        if (
          requestedExistingTask &&
          canonicalTask &&
          requestedExistingTask.id !== canonicalTask.id
        ) {
          throw new Error(
            `Task ${requestedExistingTask.id} is not the canonical review task for ${canonicalKey}.`,
          );
        }

        existingTask = canonicalTask ?? requestedExistingTask;
      }

      let taskId: string;

      if (existingTask) {
        await tx.execute(
          sql`SELECT id FROM tasks WHERE id = ${existingTask.id} FOR UPDATE`,
        );

        const existingLinkage = await tx.query.taskPullRequests.findFirst({
          where: and(
            eq(taskPullRequests.taskId, existingTask.id),
            eq(
              taskPullRequests.sourceControlProvider,
              input.prLinkage!.provider,
            ),
            eq(taskPullRequests.repository, input.prLinkage!.repository),
            eq(taskPullRequests.prNumber, input.prLinkage!.prNumber),
          ),
          columns: { taskId: true },
        });

        if (!existingLinkage) {
          throw new Error(
            `Task ${existingTask.id} is not linked to ${input.prLinkage!.provider}:${input.prLinkage!.repository}#${input.prLinkage!.prNumber}.`,
          );
        }

        const activeRun = await tx.query.taskRuns.findFirst({
          where: and(
            eq(taskRuns.taskId, existingTask.id),
            inArray(taskRuns.status, [...activeRunStatuses]),
          ),
        });

        if (activeRun) {
          await ensureSessionForTask(tx, {
            taskId: existingTask.id,
            fastConversationId:
              getFastAgentParentFromPayload(taskWithHarnessOverrides.payload)
                ?.sessionId ?? null,
            origin: 'follow_up',
            existingTaskReused: true,
          });
          return { taskRun: activeRun, createdRun: false, reusedTask: true };
        }

        taskId = existingTask.id;
      } else {
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
            modelProvider,
            model: effectiveTaskModel,
            title,
            ...(titleIsLocked
              ? { llmTitleCheckpoint: LLM_TITLE_LOCKED_CHECKPOINT }
              : {}),
            prompt: initialPrompt,
            goalObjective: input.goal?.objective ?? null,
            goalStatus: input.goal ? 'active' : null,
            goalMaxContinuations: input.goal?.maxContinuations ?? null,
            goalLastContinuationId: initialGoalGeneration,
            goalGenerationIds: initialGoalGeneration
              ? [initialGoalGeneration]
              : [],
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
        taskId = createdTask.id;
      }

      await ensureSessionForTask(tx, {
        taskId,
        fastConversationId: fastParent?.sessionId ?? null,
        origin: fastParent
          ? 'fast_delegation'
          : existingTask
            ? 'follow_up'
            : 'direct_launch',
        existingTaskReused: Boolean(existingTask),
      });

      if (input.prLinkage) {
        const prLinkage = {
          sourceControlProvider: input.prLinkage.provider,
          host: input.prLinkage.host ?? null,
          repositoryId: input.prLinkage.repositoryId ?? null,
          repository: input.prLinkage.repository,
          prNumber: input.prLinkage.prNumber,
          prUrl: input.prLinkage.prUrl,
          prTitle: input.prLinkage.prTitle ?? null,
          prSha: input.prLinkage.prSha ?? null,
          prBaseRef: input.prLinkage.prBaseRef ?? null,
          prBaseSha: input.prLinkage.prBaseSha ?? null,
        };
        const githubArtifactIds = {
          ...(input.prLinkage.githubReactionId !== undefined
            ? { githubReactionId: input.prLinkage.githubReactionId }
            : {}),
          ...(input.prLinkage.githubCheckRunId !== undefined
            ? { githubCheckRunId: input.prLinkage.githubCheckRunId }
            : {}),
          ...(input.prLinkage.githubReviewCommentId !== undefined
            ? { githubReviewCommentId: input.prLinkage.githubReviewCommentId }
            : {}),
        };

        if (existingTask) {
          const [updatedLinkage] = await tx
            .update(taskPullRequests)
            .set({ ...prLinkage, ...githubArtifactIds })
            .where(
              and(
                eq(taskPullRequests.taskId, taskId),
                eq(
                  taskPullRequests.sourceControlProvider,
                  input.prLinkage.provider,
                ),
                eq(taskPullRequests.repository, input.prLinkage.repository),
                eq(taskPullRequests.prNumber, input.prLinkage.prNumber),
              ),
            )
            .returning({ taskId: taskPullRequests.taskId });

          if (!updatedLinkage) {
            throw new Error(
              `Task ${taskId} is not linked to ${input.prLinkage.provider}:${input.prLinkage.repository}#${input.prLinkage.prNumber}.`,
            );
          }
        } else {
          await tx.insert(taskPullRequests).values({
            taskId,
            ...prLinkage,
            githubReactionId: input.prLinkage.githubReactionId ?? null,
            githubCheckRunId: input.prLinkage.githubCheckRunId ?? null,
            githubReviewCommentId:
              input.prLinkage.githubReviewCommentId ?? null,
          });
        }

        await projectPendingPrReviewEventsForAssociation(tx, {
          taskId,
          sourceControlProvider: input.prLinkage.provider,
          repository: input.prLinkage.repository,
          prNumber: input.prLinkage.prNumber,
        });
      }

      const [insertedRun] = await tx
        .insert(taskRuns)
        .values({
          taskId,
          kind: 'fresh',
          payloadKind: taskWithHarnessOverrides.type,
          actingUserId: options.skipInitialActingUser ? null : linkedUserId,
          status: options.initialStatus ?? RunStatus.Pending,
          taskPhase: options.initialTaskPhase ?? null,
          error: options.initialError ?? null,
          ...(options.initialStatus === RunStatus.Dequeued
            ? { dequeuedAt: new Date() }
            : {}),
          harness: existingTask?.harness ?? targetHarness,
          vendor: targetComputeProvider,
          port: task.payload.port,
          initialPaths,
          payload: taskWithHarnessOverrides.payload,
          keepaliveMs,
          // Launching-run lineage for platform-spawned tasks. Without this on
          // the run row, notify-source-run-on-settle has no pointer back to
          // the parent run.
          sourceRunId: taskWithHarnessOverrides.sourceRunId ?? null,
        })
        .returning();

      if (!insertedRun) {
        throw new Error('Failed to create `task_runs` record.');
      }

      if (options.afterCreateInTransaction) {
        await options.afterCreateInTransaction(tx, insertedRun);
      }

      if (existingTask) {
        await syncTaskStateFromRuns(tx, taskId);
      }

      return {
        taskRun: insertedRun,
        createdRun: true,
        reusedTask: Boolean(existingTask),
      };
    });

  let persisted: Awaited<ReturnType<typeof runPersistTransaction>>;
  try {
    persisted = await runPersistTransaction();
  } catch (error) {
    if (!isPostgresDeadlockError(error)) {
      throw error;
    }
    // The aborted transaction persisted nothing, so one retry is safe and
    // absorbs any remaining lock-order conflict with an unrelated writer.
    console.warn(
      `[task-run-queue] Retrying task persistence after a deadlock: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    persisted = await runPersistTransaction();
  }
  const { taskRun, createdRun, reusedTask } = persisted;

  if (!createdRun) {
    return taskRun;
  }

  const delegated = Boolean(
    reusedTask ||
    getFastAgentParentFromPayload(taskWithHarnessOverrides.payload),
  );
  void captureEvent(delegated ? 'session_task_delegated' : 'session_created', {
    ...(linkedUserId ? { userId: linkedUserId } : {}),
    properties: { surface, outcome: 'created' },
  });

  if (shouldCaptureTaskCreatedEvent(taskRun.payloadKind)) {
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
  }

  if (
    shouldCaptureActivationTaskCreatedEvent({
      taskType: taskRun.payloadKind,
      workflow,
      initiator,
      sourceRunId: taskWithHarnessOverrides.sourceRunId,
      environmentDefinitionId:
        taskWithHarnessOverrides.payload.environmentDefinitionId,
      verifiesEnvironmentId:
        taskWithHarnessOverrides.payload.verifiesEnvironmentId,
    })
  ) {
    void captureActivationTaskCreated({
      workflow,
      surface,
      trigger,
      harness: taskRun.harness ?? null,
      model: effectiveTaskModel,
      computeProvider: taskRun.vendor ?? null,
    });
  }

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
  if (
    !options.skipEarlyTitleGeneration &&
    !reusedTask &&
    !explicitTitle &&
    !hasDeterministicTaskRunTitle(task.type) &&
    initialPrompt?.trim()
  ) {
    void (async () => {
      try {
        const generatedTitle = await generateLlmTaskTitle({
          userId: linkedUserId,
          taskId: taskRun.taskId,
          messages: [{ role: 'user', text: initialPrompt }],
        });
        if (isFallbackTaskTitle(generatedTitle)) {
          return;
        }

        // Persist the title before any surface callback so Discord/Telegram
        // concurrent re-reads see the canonical value. When a surface callback
        // is present, leave checkpoint 0 open until rename succeeds — otherwise
        // a failed rename permanently skips the first-message retry path.
        const hasSurfaceCallback = Boolean(options.onEarlyTitleGenerated);
        const persistedGeneratedTitle = await persistEarlyGeneratedTaskTitle({
          taskId: taskRun.taskId,
          generatedTitle,
          lockFirstMessageCheckpoint: !hasSurfaceCallback,
        });
        if (!persistedGeneratedTitle) {
          return;
        }

        if (!options.onEarlyTitleGenerated) {
          return;
        }

        try {
          await options.onEarlyTitleGenerated({
            taskRun,
            title: generatedTitle,
          });
          // Rename landed (or was a no-op surface). Lock checkpoint 1 so the
          // first-message path does not spend another LLM title call.
          const lockedCheckpoint = await persistEarlyGeneratedTaskTitle({
            taskId: taskRun.taskId,
            generatedTitle,
            lockFirstMessageCheckpoint: true,
          });
          if (lockedCheckpoint) {
            return;
          }

          // A concurrent first-message refresh (or user edit) already advanced
          // past checkpoint 0. The callback above may have applied this older
          // early title last — re-read canonical title and re-apply if needed.
          const [latestTask] = await db
            .select({
              title: tasks.title,
              titleEditedByUserAt: tasks.titleEditedByUserAt,
            })
            .from(tasks)
            .where(eq(tasks.id, taskRun.taskId))
            .limit(1);
          if (
            !latestTask ||
            latestTask.titleEditedByUserAt ||
            !latestTask.title ||
            latestTask.title === generatedTitle
          ) {
            return;
          }

          await options.onEarlyTitleGenerated({
            taskRun,
            title: latestTask.title,
          });
        } catch (error) {
          console.warn(
            `[enqueueTask] Early-title callback failed for task ${taskRun.taskId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
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

/**
 * Payload kinds that can be re-enqueued on the same task after a terminal start
 * failure (for example Modal spend limit during sandbox create).
 * Snapshot resumes keep their dedicated retry path.
 */
const RELAUNCHABLE_FAILED_START_PAYLOAD_KINDS: ReadonlySet<TaskPayloadKind> =
  new Set([
    TaskPayloadKind.StandardTask,
    TaskPayloadKind.Scan,
    TaskPayloadKind.SlackAppMention,
    TaskPayloadKind.LinearAgentSession,
    TaskPayloadKind.GithubPrReviewFollowUp,
    TaskPayloadKind.McpRecommendations,
  ]);

/**
 * Whether the run's transcript holds anything the agent produced.
 *
 * Provider kickoff/start rows (for example Slack "started") are written
 * before provisioning and must not block restart after a failed start;
 * anything else means the run did work a relaunch would redo.
 */
async function hasNonKickoffTaskMessages(runId: number): Promise<boolean> {
  const priorHarnessMessage = await db.query.taskMessages.findFirst({
    where: and(
      eq(taskMessages.runId, runId),
      sql`coalesce(${taskMessages.metadata}->>'source', '') <> ${TASK_KICKOFF_MESSAGE_SOURCE}`,
    ),
    columns: { id: true },
  });

  return Boolean(priorHarnessMessage);
}

/**
 * Whether `enqueueTaskRelaunch` would accept this run, so a caller can offer
 * the control only where it works. Deriving it here rather than
 * re-implementing the rules in the UI is what keeps the button and the
 * command from disagreeing — a client-side approximation previously either
 * offered a retry that always errored, or hid one that would have worked.
 */
export async function canRetryFailedStart(sourceRun: {
  id: number;
  status: TaskRun['status'];
  payloadKind: TaskRun['payloadKind'];
  payload: TaskRun['payload'];
}): Promise<boolean> {
  if (sourceRun.status !== RunStatus.Failed) {
    return false;
  }

  if (!isRelaunchableFailedStartPayloadKind(sourceRun.payloadKind)) {
    return false;
  }

  if (!sourceRun.payload?.repo && !sourceRun.payload?.environmentId) {
    return false;
  }

  return !(await hasNonKickoffTaskMessages(sourceRun.id));
}

export function isRelaunchableFailedStartPayloadKind(
  payloadKind: TaskPayloadKind,
): boolean {
  return RELAUNCHABLE_FAILED_START_PAYLOAD_KINDS.has(payloadKind);
}

function reconstructFreshTaskFromFailedRun(sourceRun: TaskRun): FreshTask {
  const payload = {
    ...(sourceRun.payload as Record<string, unknown>),
  };

  // Discord launch idempotency keys the original gateway event on the first
  // run via task_runs_discord_source_event_unique (uncanceled rows only). A
  // failed-start relaunch creates another uncanceled run on the same task and
  // must not re-claim that source event, or Postgres rejects the insert with
  // 23505 and the UI surfaces a raw Failed query / stuck Booting state.
  delete payload.communicationSourceEventId;

  return {
    type: sourceRun.payloadKind,
    harness: sourceRun.harness ?? undefined,
    computeProvider: sourceRun.vendor ?? undefined,
    payload,
  } as FreshTask;
}

async function stampWorkspaceSourceControlProviders(
  payload: FreshTask['payload'],
  workspace: ReturnType<typeof resolveTaskWorkspace>,
): Promise<void> {
  const [repositoryProviders, workspaceHost] = await Promise.all([
    resolveWorkspaceRepositoryProviders(db, workspace),
    resolveWorkspaceSourceControlHost(db, workspace),
  ]);
  const isAggregateWorkspace =
    workspace.type === 'repository_set' ||
    workspace.type === 'all_repositories';
  const requiresCompleteCoverage =
    isAggregateWorkspace || workspace.type === 'environment';
  const expectedRepositoryCount =
    workspace.type === 'repository_set'
      ? new Set(workspace.repositories).size
      : undefined;

  if (requiresCompleteCoverage) {
    payload.repositoryProviders = repositoryProviders;
  }

  if (
    requiresCompleteCoverage &&
    (Object.keys(repositoryProviders).length === 0 ||
      (expectedRepositoryCount !== undefined &&
        Object.keys(repositoryProviders).length !== expectedRepositoryCount))
  ) {
    payload.sourceControlProvider = undefined;
    payload.sourceControlHost = undefined;
    return;
  }

  const providers = Object.values(repositoryProviders);
  const spansProviders = new Set(providers).size > 1;

  if (requiresCompleteCoverage && !spansProviders) {
    payload.sourceControlHost = workspaceHost;
  }

  if (spansProviders && !requiresCompleteCoverage) {
    payload.repositoryProviders = repositoryProviders;
  }

  const primaryProvider = providers[0];
  if (
    primaryProvider &&
    (spansProviders || payload.sourceControlProvider === undefined)
  ) {
    if (
      spansProviders ||
      (payload.sourceControlProvider !== undefined &&
        payload.sourceControlProvider !== primaryProvider)
    ) {
      payload.sourceControlHost = undefined;
    }
    payload.sourceControlProvider = primaryProvider;
  }
}

/**
 * Re-enqueues a failed first-start run on the same task (new run row, same task
 * id). Used when environment creation fails before the session can start and the
 * user retries after fixing provider capacity or configuration.
 */
export async function enqueueTaskRelaunch(
  input: {
    sourceRunId: number;
    actingUserId: string | null;
  },
  options: EnqueueTaskOptions = {},
): Promise<TaskRun> {
  await assertDeploymentIsActive();
  await assertUserIsNotDeleted(input.actingUserId);

  const sourceRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, input.sourceRunId),
  });

  if (!sourceRun) {
    throw new Error(
      `Source run ${input.sourceRunId} was not found for task relaunch.`,
    );
  }

  if (sourceRun.status !== RunStatus.Failed) {
    throw new Error('Only failed task starts can be retried.');
  }

  if (!isRelaunchableFailedStartPayloadKind(sourceRun.payloadKind)) {
    throw new Error(
      `Task type '${sourceRun.payloadKind}' does not support start retry.`,
    );
  }

  if (!sourceRun.payload?.repo && !sourceRun.payload?.environmentId) {
    throw new Error('Failed run has no workspace information to relaunch.');
  }

  const existingTask = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, sourceRun.taskId), isNull(tasks.deletedAt)),
    columns: {
      id: true,
      workflow: true,
      harness: true,
    },
  });

  if (!existingTask) {
    throw new Error(
      `Task ${sourceRun.taskId} was not found for task relaunch.`,
    );
  }

  if (await hasNonKickoffTaskMessages(sourceRun.id)) {
    throw new Error(
      'Only failed environment starts can be restarted. This run already has task messages.',
    );
  }

  const task = reconstructFreshTaskFromFailedRun({
    ...sourceRun,
    harness: sourceRun.harness ?? existingTask.harness,
  });

  const workspace = resolveTaskWorkspace(task.payload);

  await stampWorkspaceSourceControlProviders(task.payload, workspace);

  const { initialPaths } = await resolveEnvironmentContext(task);
  const resolvedHarness = await resolveRequestedHarness(task);
  const targetHarness = resolvedHarness.harness;
  const { task: taskWithHarnessOverrides } = resolveEffectiveHarnessModelState({
    task,
    targetHarness,
    isSnapshotResume: false,
    sourceRunHarnessModelOverrides: undefined,
    deploymentTaskModelSettings: resolvedHarness.deploymentTaskModelSettings,
    deploymentCodeReviewModelId:
      resolvedHarness.deploymentCodeReviewModelId ?? null,
    deploymentCodeReviewReasoningEffort:
      resolvedHarness.deploymentCodeReviewReasoningEffort ?? null,
    deploymentCodingReasoningEffort:
      resolvedHarness.deploymentCodingReasoningEffort ?? null,
  });

  const resolvedTaskPolicy = resolveTaskRuntimePolicy({
    taskType: taskWithHarnessOverrides.type,
    launchClass: options.launchClass,
    appEnv: Env.APP_ENV ?? 'development',
    defaultKeepaliveMs: DEFAULT_KEEPALIVE_MS,
    delegatedKeepaliveMs: DEFAULT_DELEGATED_KEEPALIVE_MS,
    sandboxTimeoutMs: TASK_TIMEOUT_MS,
  });

  const targetComputeProvider = resolveFreshTaskComputeProvider(
    task.computeProvider,
    await resolveDefaultComputeProvider(),
    task.type,
  );

  const taskRun = await db.transaction(async (tx) => {
    // Serialize concurrent retries on the same task so two retries cannot both
    // observe an empty active-run set and insert separate pending runs.
    await tx.execute(
      sql`SELECT id FROM tasks WHERE id = ${existingTask.id} FOR UPDATE`,
    );

    const activeRun = await tx.query.taskRuns.findFirst({
      where: and(
        eq(taskRuns.taskId, existingTask.id),
        inArray(taskRuns.status, [...activeRunStatuses]),
      ),
      columns: { id: true },
    });

    if (activeRun) {
      throw new Error('This task already has an active run.');
    }

    const stillFailed = await tx.query.taskRuns.findFirst({
      where: and(
        eq(taskRuns.id, sourceRun.id),
        eq(taskRuns.status, RunStatus.Failed),
      ),
      columns: { id: true },
    });

    if (!stillFailed) {
      throw new Error('Only failed task starts can be retried.');
    }

    const [insertedRun] = await tx
      .insert(taskRuns)
      .values({
        taskId: existingTask.id,
        kind: 'fresh',
        sourceRunId: sourceRun.id,
        payloadKind: taskWithHarnessOverrides.type,
        actingUserId: options.skipInitialActingUser ? null : input.actingUserId,
        status: options.initialStatus ?? RunStatus.Pending,
        taskPhase: options.initialTaskPhase ?? null,
        error: options.initialError ?? null,
        ...(options.initialStatus === RunStatus.Dequeued
          ? { dequeuedAt: new Date() }
          : {}),
        harness: targetHarness,
        vendor: targetComputeProvider,
        port: task.payload.port,
        initialPaths,
        payload: taskWithHarnessOverrides.payload,
        keepaliveMs: resolvedTaskPolicy.keepaliveMs,
      })
      .returning();

    if (!insertedRun) {
      throw new Error('Failed to create `task_runs` record.');
    }

    if (options.afterCreateInTransaction) {
      await options.afterCreateInTransaction(tx, insertedRun);
    }

    await syncTaskStateFromRuns(tx, existingTask.id);

    return insertedRun;
  });

  void captureEvent('task_created', {
    ...(input.actingUserId ? { userId: input.actingUserId } : {}),
    properties: {
      taskType: taskRun.payloadKind,
      workflow: existingTask.workflow,
      harness: taskRun.harness ?? null,
      computeProvider: taskRun.vendor ?? null,
      relaunch: true,
      sourceRunId: sourceRun.id,
    },
  });

  await pushRunOntoQueue({
    taskRun,
    scope: resolveQueueScope({
      workflow: existingTask.workflow as TaskWorkflow,
      payloadKind: taskRun.payloadKind,
    }),
    options,
  });

  return taskRun;
}

/**
 * Resume runs execute in the source run's repositories, but resume entry
 * points rebuild the payload from scratch and may not copy the source-control
 * stamps forward. Without them, workspace preparation and token minting fall
 * back to the GitHub default and non-GitHub resumes fail with
 * "Repository not found".
 */
function inheritSnapshotResumeSourceControlStamps(
  payload: SnapshotResumeTask['payload'],
  sourcePayload: unknown,
): void {
  const source = (sourcePayload ?? {}) as {
    repositoryProviders?: unknown;
    sourceControlProvider?: unknown;
    sourceControlHost?: unknown;
  };

  const inheritsProvider = payload.sourceControlProvider === undefined;
  const provider = sourceControlProviderSchema.safeParse(
    source.sourceControlProvider,
  );

  if (inheritsProvider) {
    if (provider.success) {
      payload.sourceControlProvider = provider.data;
    }
  }

  const usesSourceProvider =
    provider.success && payload.sourceControlProvider === provider.data;

  if (usesSourceProvider && payload.repositoryProviders === undefined) {
    const repositoryProviders = z
      .record(sourceControlProviderSchema)
      .safeParse(source.repositoryProviders);

    if (repositoryProviders.success) {
      payload.repositoryProviders = repositoryProviders.data;
    }
  }

  if (
    inheritsProvider &&
    provider.success &&
    payload.sourceControlHost === undefined
  ) {
    const host =
      typeof source.sourceControlHost === 'string'
        ? source.sourceControlHost.trim()
        : '';

    if (host) {
      payload.sourceControlHost = host;
    }
  }
}

function inheritSnapshotResumeFastAgentParent(
  payload: SnapshotResumeTask['payload'],
  sourcePayload: unknown,
): void {
  const parent = getFastAgentParentFromPayload(sourcePayload);
  if (parent && !payload.fastAgentParent) {
    payload.fastAgentParent = parent;
  }
  if (
    parent &&
    getTaskReportConsumerFromPayload(sourcePayload) === 'orchestrator' &&
    !payload.reportConsumer
  ) {
    payload.reportConsumer = 'orchestrator';
  }
}

function inheritSnapshotResumeFastAgentSession(
  payload: SnapshotResumeTask['payload'],
  sourcePayload: unknown,
): void {
  const fastAgentSessionId = z
    .string()
    .uuid()
    .safeParse(
      sourcePayload && typeof sourcePayload === 'object'
        ? (sourcePayload as Record<string, unknown>).fastAgentSessionId
        : undefined,
    );
  if (fastAgentSessionId.success && !payload.fastAgentSessionId) {
    payload.fastAgentSessionId = fastAgentSessionId.data;
  }
}

function inheritSnapshotResumeCommunicationContext(
  payload: SnapshotResumeTask['payload'],
  sourcePayload: unknown,
): void {
  if (
    sourcePayload &&
    typeof sourcePayload === 'object' &&
    !Array.isArray(sourcePayload) &&
    (sourcePayload as Record<string, unknown>).communicationContextInherited ===
      true
  ) {
    payload.communicationContextInherited = true;
  }

  if (
    sourcePayload &&
    typeof sourcePayload === 'object' &&
    !Array.isArray(sourcePayload) &&
    (sourcePayload as Record<string, unknown>).liveTaskStream === true
  ) {
    // The card in the Slack thread belongs to the task; every resumed run
    // must keep updating it.
    payload.liveTaskStream = true;
  }
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
      payloadKind: true,
      sourceRunId: true,
      payload: true,
    },
  });

  if (!sourceRun) {
    throw new Error(
      `Source run ${sourceRunId} was not found for snapshot resume.`,
    );
  }

  inheritSnapshotResumeSourceControlStamps(task.payload, sourceRun.payload);
  inheritSnapshotResumeFastAgentParent(task.payload, sourceRun.payload);
  inheritSnapshotResumeFastAgentSession(task.payload, sourceRun.payload);
  inheritSnapshotResumeCommunicationContext(task.payload, sourceRun.payload);

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
  const sourceRunPayloadModelState = sourceRun.payload as {
    harnessModelOverrides?: import('@roomote/types').HarnessModelOverrides;
    modelRoleOverrides?: import('@roomote/types').TaskModelRoleOverrides;
    reasoningEffort?: unknown;
  } | null;
  const sourceRunHarnessModelOverrides =
    sourceRunPayloadModelState?.harnessModelOverrides;

  // Per-role model overrides ride the same inheritance: every resume
  // re-stamps them onto its own payload, so reading the immediate source run
  // is enough to carry them through arbitrarily long resume chains.
  if (
    !task.payload.modelRoleOverrides &&
    sourceRunPayloadModelState?.modelRoleOverrides
  ) {
    task.payload.modelRoleOverrides =
      sourceRunPayloadModelState.modelRoleOverrides;
  }

  // An explicit coding reasoning level inherits centrally too. Entry points
  // that build richer resume prompts already copy it via
  // restoreSnapshotResumeVisiblePromptFields, but resumes that skip that
  // helper would otherwise keep the model override while
  // applyOverrideTaskReasoningEffort re-stamps the deployment default level.
  if (
    !task.payload.reasoningEffort &&
    isReasoningEffort(sourceRunPayloadModelState?.reasoningEffort)
  ) {
    task.payload.reasoningEffort = sourceRunPayloadModelState.reasoningEffort;
  }

  let sourceTaskType = sourceRun.payloadKind;
  let parentRunId = sourceRun.sourceRunId;

  // Snapshot resumes point to the immediately preceding resume, so follow the
  // chain until reaching the original run whose role selected the model.
  while (
    sourceTaskType === TaskPayloadKind.SnapshotResume &&
    parentRunId !== null
  ) {
    const parentRun = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, parentRunId),
      columns: { payloadKind: true, sourceRunId: true, payload: true },
    });

    if (!parentRun) {
      break;
    }

    // Older resume rows may lack established source-control stamps.
    inheritSnapshotResumeSourceControlStamps(task.payload, parentRun.payload);

    sourceTaskType = parentRun.payloadKind;
    parentRunId = parentRun.sourceRunId;
  }

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
    sourceTaskType,
    deploymentTaskModelSettings: resolvedHarness.deploymentTaskModelSettings,
    deploymentCodeReviewModelId:
      resolvedHarness.deploymentCodeReviewModelId ?? null,
    deploymentCodeReviewReasoningEffort:
      resolvedHarness.deploymentCodeReviewReasoningEffort ?? null,
    deploymentCodingReasoningEffort:
      resolvedHarness.deploymentCodingReasoningEffort ?? null,
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
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${SNAPSHOT_RESUME_ADVISORY_LOCK_NAMESPACE}, ${sourceRun.id})`,
      );

      const existingResume = await tx.query.taskRuns.findFirst({
        where: and(
          eq(taskRuns.sourceRunId, sourceRun.id),
          eq(taskRuns.kind, 'resume'),
          isNull(taskRuns.canceledAt),
        ),
        columns: { id: true },
      });
      if (existingResume) {
        throw new SnapshotResumeAlreadyExistsError(existingResume.id);
      }

      const [insertedRun] = await tx
        .insert(taskRuns)
        .values({
          taskId: sourceRun.taskId,
          kind: 'resume',
          sourceRunId: sourceRun.id,
          payloadKind: TaskPayloadKind.SnapshotResume,
          actingUserId,
          status: options.initialStatus ?? RunStatus.Pending,
          taskPhase: options.initialTaskPhase ?? null,
          error: options.initialError ?? null,
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
