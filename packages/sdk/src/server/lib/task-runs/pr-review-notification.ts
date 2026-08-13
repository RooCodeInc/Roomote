import { randomUUID } from 'node:crypto';

import { Queue } from 'bullmq';
import { z } from 'zod';

import type { TaskRun } from '@roomote/db/server';
import { and, db, eq, taskPullRequests } from '@roomote/db/server';
import { getRedis } from '@roomote/redis';
import {
  type CommunicationProvider,
  getCommunicationChannelFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationServiceUrlFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
  sourceControlProviderSchema,
} from '@roomote/types';

import { resolveSlackTaskRunRouting } from './slack-task-run-routing';

export const PR_REVIEW_NOTIFICATION_QUEUE_NAME = 'pr-review-notification-jobs';

/**
 * Debounce window for ordinary PR review activity so related review comments
 * collapse into one notification.
 */
export const PR_REVIEW_NOTIFICATION_DEBOUNCE_MS = 1 * 60 * 1000;

/**
 * Roomote's own inline findings are provisional until its review summary
 * completes. Keep them as a fallback instead of presenting them as a second
 * notification while the review is still running.
 */
export const PR_REVIEW_NOTIFICATION_ROOMOTE_FALLBACK_MS = 15 * 60 * 1000;

/**
 * Delay before re-checking an owner task that is still actively running when
 * the notification job fires. The notification is intentionally held until
 * the task goes idle.
 */
export const PR_REVIEW_NOTIFICATION_DEFER_MS = 5 * 60 * 1000;

/**
 * Upper bound on idle-wait deferrals. The notification only posts while the
 * owning task is idle, so once the cap is reached the pending feedback is
 * dropped instead of being posted mid-run. At the 5-minute recheck interval
 * this cap roughly matches the 24-hour pending-events TTL, so it mainly
 * protects against tasks stuck in a running state scheduling deferral jobs
 * forever.
 */
export const PR_REVIEW_NOTIFICATION_MAX_DEFERRALS = 288;

const PENDING_EVENTS_TTL_SECONDS = 24 * 60 * 60;
const SCHEDULED_MARKER_TTL_BUFFER_SECONDS = 15 * 60;
const REVIEW_CYCLE_TTL_SECONDS = 30 * 24 * 60 * 60;
const ORPHAN_ACTIVITY_TTL_SECONDS = 15 * 60;
const ORPHAN_REPLAY_REPAIR_INDEX_KEY =
  'pr-review-notification:orphan-replay-repair';
const ORPHAN_REPLAY_REPAIR_BATCH_SIZE = 100;
export const ORPHAN_REPLAY_REPAIR_DELAY_MS = 60 * 1000;
export const PR_REVIEW_ASSOCIATION_REPLAY_DELAYS_MS = [
  1_000, 5_000, 30_000, 120_000, 300_000,
] as const;
const SET_REVIEW_CYCLE_IF_NEWER_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then
  local decoded = cjson.decode(current)
  if tonumber(decoded.observedAt) > tonumber(ARGV[2]) then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
return 1
`;
const APPEND_ORPHAN_ACTIVITY_SCRIPT = `
local marker = redis.call('GET', KEYS[2])
local claimed = 0
if not marker then
  marker = ARGV[1] .. ':1'
  claimed = 1
else
  local separator = string.match(marker, '^.*():')
  local chainId = string.sub(marker, 1, separator - 1)
  local revision = tonumber(string.sub(marker, separator + 1)) + 1
  marker = chainId .. ':' .. revision
end
redis.call('SET', KEYS[2], marker, 'EX', ARGV[3])
redis.call('RPUSH', KEYS[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return {marker, claimed}
`;
const CONSUME_ORPHAN_ACTIVITY_SCRIPT = `
local marker = redis.call('GET', KEYS[2])
if not marker or string.sub(marker, 1, string.len(ARGV[1]) + 1) ~= ARGV[1] .. ':' then
  return {}
end
local inputs = redis.call('LRANGE', KEYS[1], 0, -1)
redis.call('DEL', KEYS[1], KEYS[2])
return inputs
`;
const CLAIM_ORPHAN_REPLAY_SCRIPT = `
if redis.call('LLEN', KEYS[1]) == 0 then
  return 0
end
redis.call('SET', KEYS[2], ARGV[1] .. ':0', 'EX', ARGV[2])
return 1
`;
const GET_OR_RECLAIM_ORPHAN_REPLAY_SCRIPT = `
local marker = redis.call('GET', KEYS[2])
if marker then
  return marker
end
if redis.call('LLEN', KEYS[1]) == 0 then
  return false
end
marker = ARGV[1] .. ':0'
redis.call('SET', KEYS[2], marker, 'EX', ARGV[2])
return marker
`;
const FINISH_OR_ROTATE_ORPHAN_REPLAY_SCRIPT = `
-- release a quiet chain or rotate activity appended during final lookup
local marker = redis.call('GET', KEYS[2])
if marker == ARGV[1] then
  redis.call('DEL', KEYS[2])
  return 0
end
if marker and string.sub(marker, 1, string.len(ARGV[2]) + 1) == ARGV[2] .. ':' then
  redis.call('SET', KEYS[2], ARGV[3] .. ':0', 'EX', ARGV[4])
  return 1
end
return 0
`;
const RELEASE_ORPHAN_REPLAY_SCRIPT = `
local marker = redis.call('GET', KEYS[1])
if marker and string.sub(marker, 1, string.len(ARGV[1]) + 1) == ARGV[1] .. ':' then
  return redis.call('DEL', KEYS[1])
end
return 0
`;
const REQUEUE_AND_CLAIM_ORPHAN_REPLAY_SCRIPT = `
for index = 1, #ARGV - 2 do
  redis.call('RPUSH', KEYS[1], ARGV[index])
end
redis.call('EXPIRE', KEYS[1], ARGV[#ARGV])
redis.call('SET', KEYS[2], ARGV[#ARGV - 1] .. ':0', 'EX', ARGV[#ARGV])
return 1
`;
const CLEAR_ORPHAN_REPLAY_REPAIR_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[2])
return 1
`;
const COMPLETE_REVIEW_CYCLE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then
  local decoded = cjson.decode(current)
  if decoded.cycleId ~= ARGV[1] or tonumber(decoded.observedAt) > tonumber(ARGV[2]) then
    return 0
  end
end
redis.call('SET', KEYS[2], '1', 'EX', ARGV[4])
redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4])
return 1
`;
const RESTORE_REVIEW_CYCLE_IF_VALUE_MATCHES_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  if ARGV[2] == '' then
    return redis.call('DEL', KEYS[1])
  end
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  return 1
end
return 0
`;

const prReviewNotificationBatchKindSchema = z.enum(['human', 'roomote']);

const prReviewCycleStateSchema = z.object({
  cycleId: z.string(),
  phase: z.enum(['open', 'completed']),
  observedAt: z.number(),
});

type PrReviewCycleState = z.infer<typeof prReviewCycleStateSchema>;

export const prReviewActivityEventSchema = z.object({
  kind: z.enum(['issue_comment', 'review', 'review_comment', 'review_summary']),
  authorLogin: z.string(),
  /** Commit SHA reviewed by this event. */
  reviewHeadSha: z.string().optional(),
  /**
   * Stable feedback-batch identity. Human review events use GitHub's review
   * id; Roomote events use the explicit lifecycle opened by its in-progress
   * summary comment. This prevents separate passes on the same SHA from being
   * conflated.
   */
  batchId: z.string().optional(),
  /** GitHub review state for `review` events, e.g. `approved`. */
  reviewState: z.string().optional(),
  /** Short human-readable summary text for `review_summary` events. */
  summary: z.string().optional(),
  /** HTML URL of the review or comment the event describes, when known. */
  url: z.string().optional(),
  /** Provider event time used to order review lifecycle transitions. */
  observedAt: z.number().int().nonnegative().optional(),
  /**
   * True when the event was authored by Roomote's own GitHub identity (for
   * example results of the agent's own automated PR review), so the
   * notification can describe the feedback in the first person.
   */
  roomoteAuthored: z.boolean().optional(),
});

export type PrReviewActivityEvent = z.infer<typeof prReviewActivityEventSchema>;

export const prReviewNotificationRequestSchema = z.object({
  taskId: z.string(),
  repository: z.string(),
  prNumber: z.number().int().positive(),
  prUrl: z.string(),
  deferrals: z.number().int().min(0).default(0),
  immediate: z.boolean().optional(),
  batchKind: prReviewNotificationBatchKindSchema.optional(),
  batchId: z.string().optional(),
  sourceControlProvider: sourceControlProviderSchema.optional(),
});

export type PrReviewNotificationRequest = z.infer<
  typeof prReviewNotificationRequestSchema
>;

type PrReviewNotificationTarget = {
  taskId: string;
  repository: string;
  prNumber: number;
  sourceControlProvider?: z.infer<typeof sourceControlProviderSchema>;
  immediate?: boolean;
  batchKind?: z.infer<typeof prReviewNotificationBatchKindSchema>;
  batchId?: string;
};

export const startPrReviewNotificationCycleInputSchema = z.object({
  repository: z.string(),
  prNumber: z.number().int().positive(),
  reviewHeadSha: z.string(),
  cycleId: z.string(),
  observedAt: z.number().int().nonnegative(),
});

export type StartPrReviewNotificationCycleInput = z.infer<
  typeof startPrReviewNotificationCycleInputSchema
>;

export const enqueuePrReviewNotificationInputSchema = z.object({
  repository: z.string(),
  prNumber: z.number().int().positive(),
  prUrl: z.string(),
  event: prReviewActivityEventSchema,
  sourceControlProvider: sourceControlProviderSchema.optional(),
});

export type EnqueuePrReviewNotificationInput = z.infer<
  typeof enqueuePrReviewNotificationInputSchema
>;

export const prReviewAssociationReplayRequestSchema = z.object({
  kind: z.literal('association_replay'),
  sourceControlProvider: sourceControlProviderSchema,
  repository: z.string(),
  prNumber: z.number().int().positive(),
  chainId: z.string().uuid(),
  attempt: z
    .number()
    .int()
    .min(1)
    .max(PR_REVIEW_ASSOCIATION_REPLAY_DELAYS_MS.length),
});

export type PrReviewAssociationReplayRequest = z.infer<
  typeof prReviewAssociationReplayRequestSchema
>;

export const prReviewNotificationQueueRequestSchema = z.union([
  prReviewAssociationReplayRequestSchema,
  prReviewNotificationRequestSchema,
]);

export type PrReviewNotificationQueueRequest = z.infer<
  typeof prReviewNotificationQueueRequestSchema
>;

type EnqueuePrReviewNotificationResult = {
  notifiedTaskCount: number;
  reason?: string;
};

type PrReviewNotificationRoutingRun = Pick<
  TaskRun,
  'id' | 'taskId' | 'payload'
>;

export type PrReviewNotificationRoute =
  | { provider: 'slack'; channelId: string; threadId: string }
  | {
      provider: 'teams';
      channelId: string;
      threadId: string | null;
      serviceUrl: string;
    }
  | { provider: 'telegram'; channelId: string; threadId: string | null }
  | { provider: 'discord'; channelId: string; threadId: string | null };

let prReviewNotificationQueue: Queue<PrReviewNotificationQueueRequest> | null =
  null;

function getPrReviewNotificationQueue(): Queue<PrReviewNotificationQueueRequest> {
  if (!prReviewNotificationQueue) {
    const redis = getRedis();

    prReviewNotificationQueue = new Queue<PrReviewNotificationQueueRequest>(
      PR_REVIEW_NOTIFICATION_QUEUE_NAME,
      {
        connection: redis,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { age: 3600, count: 100 },
          removeOnFail: { age: 24 * 3600 },
        },
      },
    );
  }

  return prReviewNotificationQueue;
}

function buildTargetKeySuffix({
  taskId,
  repository,
  prNumber,
  sourceControlProvider = 'github',
  batchKind = 'human',
  batchId,
}: PrReviewNotificationTarget): string {
  const providerPrefix =
    sourceControlProvider === 'github' ? '' : `${sourceControlProvider}:`;
  return `${providerPrefix}${encodeURIComponent(taskId)}:${encodeURIComponent(repository)}#${prNumber}:${batchKind}${batchId ? `:${encodeURIComponent(batchId)}` : ''}`;
}

function buildLegacyTargetKeySuffix({
  taskId,
  repository,
  prNumber,
  sourceControlProvider = 'github',
  immediate = false,
}: PrReviewNotificationTarget): string {
  const providerPrefix =
    sourceControlProvider === 'github' ? '' : `${sourceControlProvider}:`;
  return `${providerPrefix}${encodeURIComponent(taskId)}:${encodeURIComponent(repository)}#${prNumber}${immediate ? ':immediate' : ''}`;
}

function buildPendingEventsKey(target: PrReviewNotificationTarget): string {
  if (target.batchKind === undefined) {
    return `pr-review-notification:pending:${buildLegacyTargetKeySuffix(target)}`;
  }

  return `pr-review-notification:pending:${buildTargetKeySuffix(target)}`;
}

function buildScheduledMarkerKey(target: PrReviewNotificationTarget): string {
  if (target.batchKind === undefined) {
    return `pr-review-notification:scheduled:${buildLegacyTargetKeySuffix(target)}`;
  }

  return `pr-review-notification:scheduled:${buildTargetKeySuffix(target)}:${target.immediate ? 'immediate' : 'delayed'}`;
}

type PrReviewAssociationTarget = Pick<
  EnqueuePrReviewNotificationInput,
  'repository' | 'prNumber'
> & { sourceControlProvider: z.infer<typeof sourceControlProviderSchema> };

function buildOrphanActivityKey(target: PrReviewAssociationTarget): string {
  return `pr-review-notification:orphan:${target.sourceControlProvider}:${encodeURIComponent(target.repository)}#${target.prNumber}`;
}

function buildOrphanReplayMarkerKey(target: PrReviewAssociationTarget): string {
  return `pr-review-notification:orphan-replay:${target.sourceControlProvider}:${encodeURIComponent(target.repository)}#${target.prNumber}`;
}

function buildOrphanReplayRepairMember(
  target: PrReviewAssociationTarget,
): string {
  return `${target.sourceControlProvider}:${encodeURIComponent(target.repository)}#${target.prNumber}`;
}

function buildOrphanReplayRepairPayloadKey(
  target: PrReviewAssociationTarget,
): string {
  return `pr-review-notification:orphan-replay-repair-payload:${buildOrphanReplayRepairMember(target)}`;
}

async function recordOrphanReplayRepair(
  request: PrReviewAssociationReplayRequest,
): Promise<string> {
  const target = {
    sourceControlProvider: request.sourceControlProvider,
    repository: request.repository,
    prNumber: request.prNumber,
  };
  const payload = JSON.stringify(request);

  await getRedis()
    .multi()
    .set(
      buildOrphanReplayRepairPayloadKey(target),
      payload,
      'EX',
      ORPHAN_ACTIVITY_TTL_SECONDS,
    )
    .zadd(
      ORPHAN_REPLAY_REPAIR_INDEX_KEY,
      Date.now() + ORPHAN_REPLAY_REPAIR_DELAY_MS,
      buildOrphanReplayRepairMember(target),
    )
    .exec();

  return payload;
}

async function clearOrphanReplayRepair(
  request: PrReviewAssociationReplayRequest,
  payload: string,
): Promise<void> {
  const target = {
    sourceControlProvider: request.sourceControlProvider,
    repository: request.repository,
    prNumber: request.prNumber,
  };

  await getRedis().eval(
    CLEAR_ORPHAN_REPLAY_REPAIR_SCRIPT,
    2,
    buildOrphanReplayRepairPayloadKey(target),
    ORPHAN_REPLAY_REPAIR_INDEX_KEY,
    payload,
    buildOrphanReplayRepairMember(target),
  );
}

async function scheduleOrphanAssociationReplay({
  target,
  chainId,
  attempt,
}: {
  target: PrReviewAssociationTarget;
  chainId: string;
  attempt: number;
}): Promise<void> {
  const delayMs = PR_REVIEW_ASSOCIATION_REPLAY_DELAYS_MS[attempt - 1];

  if (delayMs === undefined) {
    return;
  }

  const request = {
    kind: 'association_replay' as const,
    ...target,
    chainId,
    attempt,
  };
  const repairPayload = await recordOrphanReplayRepair(request);

  await getPrReviewNotificationQueue().add(
    'replay-pr-review-association',
    request,
    {
      delay: delayMs,
      jobId: `association-replay-${chainId}-${attempt}`,
    },
  );
  await clearOrphanReplayRepair(request, repairPayload).catch(() => undefined);
}

/** Re-enqueues orphan association replays whose Queue.add did not complete. */
export async function repairOrphanPrReviewAssociationReplays({
  now = Date.now(),
}: { now?: number } = {}): Promise<void> {
  const redis = getRedis();
  const members = await redis.zrangebyscore(
    ORPHAN_REPLAY_REPAIR_INDEX_KEY,
    '-inf',
    now,
    'LIMIT',
    0,
    ORPHAN_REPLAY_REPAIR_BATCH_SIZE,
  );

  for (const member of members) {
    const payloadKey = `pr-review-notification:orphan-replay-repair-payload:${member}`;
    const rawRequest = await redis.get(payloadKey);
    let request: PrReviewAssociationReplayRequest | null = null;

    if (rawRequest) {
      try {
        const parsed = prReviewAssociationReplayRequestSchema.safeParse(
          JSON.parse(rawRequest),
        );
        request = parsed.success ? parsed.data : null;
      } catch {
        request = null;
      }
    }

    if (!request || !rawRequest) {
      await redis
        .multi()
        .del(payloadKey)
        .zrem(ORPHAN_REPLAY_REPAIR_INDEX_KEY, member)
        .exec();
      continue;
    }

    const target = {
      sourceControlProvider: request.sourceControlProvider,
      repository: request.repository,
      prNumber: request.prNumber,
    };
    if ((await redis.llen(buildOrphanActivityKey(target))) === 0) {
      await clearOrphanReplayRepair(request, rawRequest).catch(() => undefined);
      continue;
    }

    try {
      await getPrReviewNotificationQueue().add(
        'replay-pr-review-association',
        request,
        {
          jobId: `association-replay-${request.chainId}-${request.attempt}`,
        },
      );
      await clearOrphanReplayRepair(request, rawRequest).catch(() => undefined);
    } catch (error) {
      console.warn(
        `[repairOrphanPrReviewAssociationReplays] Failed to enqueue replay for ${request.repository}#${request.prNumber}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function releaseOrphanReplay(
  target: PrReviewAssociationTarget,
  chainId: string,
): Promise<void> {
  await getRedis()
    .eval(
      RELEASE_ORPHAN_REPLAY_SCRIPT,
      1,
      buildOrphanReplayMarkerKey(target),
      chainId,
    )
    .catch(() => undefined);
}

async function scheduleClaimedOrphanReplay({
  target,
  chainId,
}: {
  target: PrReviewAssociationTarget;
  chainId: string;
}): Promise<void> {
  try {
    await scheduleOrphanAssociationReplay({ target, chainId, attempt: 1 });
  } catch (error) {
    await releaseOrphanReplay(target, chainId);
    throw error;
  }
}

/** Claims retained orphan activity after an association becomes observable. */
export async function wakePrReviewNotificationAssociation(
  target: PrReviewAssociationTarget,
): Promise<boolean> {
  const parsedTarget = {
    sourceControlProvider: sourceControlProviderSchema.parse(
      target.sourceControlProvider,
    ),
    repository: target.repository,
    prNumber: target.prNumber,
  };
  const chainId = randomUUID();
  const claimed = await getRedis().eval(
    CLAIM_ORPHAN_REPLAY_SCRIPT,
    2,
    buildOrphanActivityKey(parsedTarget),
    buildOrphanReplayMarkerKey(parsedTarget),
    chainId,
    ORPHAN_ACTIVITY_TTL_SECONDS,
  );

  if (claimed !== 1) {
    return false;
  }

  await scheduleClaimedOrphanReplay({ target: parsedTarget, chainId });
  return true;
}

async function appendOrphanActivityAndClaimReplay({
  target,
  input,
}: {
  target: PrReviewAssociationTarget;
  input: EnqueuePrReviewNotificationInput;
}): Promise<string | null> {
  const redis = getRedis();
  const chainId = randomUUID();
  const result = await redis.eval(
    APPEND_ORPHAN_ACTIVITY_SCRIPT,
    2,
    buildOrphanActivityKey(target),
    buildOrphanReplayMarkerKey(target),
    chainId,
    JSON.stringify(input),
    ORPHAN_ACTIVITY_TTL_SECONDS,
  );

  return Array.isArray(result) && result[1] === 1
    ? (String(result[0]).split(':')[0] ?? null)
    : null;
}

async function consumeOrphanActivity(
  target: PrReviewAssociationTarget,
  chainId: string,
): Promise<EnqueuePrReviewNotificationInput[]> {
  const rawInputs = await getRedis().eval(
    CONSUME_ORPHAN_ACTIVITY_SCRIPT,
    2,
    buildOrphanActivityKey(target),
    buildOrphanReplayMarkerKey(target),
    chainId,
  );

  if (!Array.isArray(rawInputs)) {
    return [];
  }

  return rawInputs.flatMap((raw) => {
    if (typeof raw !== 'string') {
      return [];
    }

    try {
      const parsed = enqueuePrReviewNotificationInputSchema.safeParse(
        JSON.parse(raw),
      );
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}

async function requeueOrphanActivity({
  target,
  chainId,
  inputs,
}: {
  target: PrReviewAssociationTarget;
  chainId: string;
  inputs: EnqueuePrReviewNotificationInput[];
}): Promise<void> {
  if (inputs.length === 0) {
    return;
  }

  await getRedis().eval(
    REQUEUE_AND_CLAIM_ORPHAN_REPLAY_SCRIPT,
    2,
    buildOrphanActivityKey(target),
    buildOrphanReplayMarkerKey(target),
    ...inputs.map((input) => JSON.stringify(input)),
    chainId,
    ORPHAN_ACTIVITY_TTL_SECONDS,
  );
}

function getPrReviewCycleStateKey({
  repository,
  prNumber,
  reviewHeadSha,
}: {
  repository: string;
  prNumber: number;
  reviewHeadSha: string;
}): string {
  return `pr-review-notification:review-cycle:${encodeURIComponent(repository)}#${prNumber}:${reviewHeadSha}`;
}

export function getPrReviewCompletedCycleKey({
  repository,
  prNumber,
  cycleId,
}: {
  repository: string;
  prNumber: number;
  cycleId: string;
}): string {
  return `pr-review-notification:review-cycle-completed:${encodeURIComponent(repository)}#${prNumber}:${encodeURIComponent(cycleId)}`;
}

function getPrReviewLatestCompletedCycleKey({
  repository,
  prNumber,
  reviewHeadSha,
}: {
  repository: string;
  prNumber: number;
  reviewHeadSha: string;
}): string {
  return `pr-review-notification:review-cycle-latest-completed:${encodeURIComponent(repository)}#${prNumber}:${reviewHeadSha}`;
}

async function readPrReviewCycleState({
  repository,
  prNumber,
  reviewHeadSha,
}: {
  repository: string;
  prNumber: number;
  reviewHeadSha: string;
}): Promise<{
  key: string;
  raw: string | null;
  state: PrReviewCycleState | null;
}> {
  const key = getPrReviewCycleStateKey({
    repository,
    prNumber,
    reviewHeadSha,
  });
  const raw = await getRedis().get(key);
  const parsed = raw
    ? prReviewCycleStateSchema.safeParse(JSON.parse(raw))
    : null;

  return {
    key,
    raw,
    state: parsed?.success ? parsed.data : null,
  };
}

/** Records the start of a concrete Roomote review pass. */
export async function startPrReviewNotificationCycle(
  input: StartPrReviewNotificationCycleInput,
): Promise<void> {
  const parsed = startPrReviewNotificationCycleInputSchema.parse(input);
  const key = getPrReviewCycleStateKey(parsed);
  const value = JSON.stringify({
    cycleId: parsed.cycleId,
    phase: 'open',
    observedAt: parsed.observedAt,
  } satisfies PrReviewCycleState);

  await getRedis().eval(
    SET_REVIEW_CYCLE_IF_NEWER_SCRIPT,
    1,
    key,
    value,
    parsed.observedAt,
    REVIEW_CYCLE_TTL_SECONDS,
  );
}

/**
 * Returns whether the given run carries originating-conversation context for
 * any supported communication provider. The Slack thread binding lives on the
 * tasks row; callers pass it alongside the run payload.
 */
export function hasPrReviewNotificationThreadContext(job: {
  payload: unknown;
  slackThreadTs: string | null;
}): boolean {
  if (job.slackThreadTs) {
    return true;
  }

  return Boolean(
    getCommunicationProviderFromTaskPayload(job.payload) &&
    getCommunicationChannelFromTaskPayload(job.payload),
  );
}

/**
 * Resolves the originating conversation for a task run across communication
 * providers. Slack payloads (including legacy field shapes) resolve through
 * the snapshot-resume source-run chain; Teams and Telegram resolve from the
 * provider-neutral communication payload fields, which are copied forward
 * onto resume-run payloads.
 */
export async function resolvePrReviewNotificationRoute(
  job: PrReviewNotificationRoutingRun,
): Promise<PrReviewNotificationRoute | null> {
  const provider = getCommunicationProviderFromTaskPayload(job.payload);

  if (provider === 'teams') {
    const channelId = getCommunicationChannelFromTaskPayload(job.payload);
    const serviceUrl = getCommunicationServiceUrlFromTaskPayload(job.payload);

    if (!channelId || !serviceUrl) {
      return null;
    }

    return {
      provider,
      channelId,
      serviceUrl,
      threadId: getCommunicationThreadIdFromTaskPayload(job.payload),
    };
  }

  if (provider === 'telegram') {
    const channelId = getCommunicationChannelFromTaskPayload(job.payload);

    if (!channelId) {
      return null;
    }

    return {
      provider,
      channelId,
      threadId: getCommunicationThreadIdFromTaskPayload(job.payload),
    };
  }

  if (provider === 'discord') {
    const channelId = getCommunicationChannelFromTaskPayload(job.payload);
    if (!channelId) return null;
    return {
      provider,
      channelId,
      threadId: getCommunicationThreadIdFromTaskPayload(job.payload),
    };
  }

  const { channel, threadTs } = await resolveSlackTaskRunRouting(job);

  if (!channel || !threadTs) {
    return null;
  }

  return { provider: 'slack', channelId: channel, threadId: threadTs };
}

/**
 * Schedules (or re-schedules) the delayed notification job. Also refreshes the
 * scheduled marker so concurrent webhook events keep appending to the pending
 * event list instead of scheduling duplicate jobs.
 */
export async function schedulePrReviewNotificationJob({
  request,
  delayMs,
}: {
  request: PrReviewNotificationRequest;
  delayMs: number;
}): Promise<void> {
  const redis = getRedis();
  const markerKey = buildScheduledMarkerKey(request);
  const markerTtlSeconds =
    Math.ceil(delayMs / 1000) + SCHEDULED_MARKER_TTL_BUFFER_SECONDS;

  await redis.set(markerKey, '1', 'EX', markerTtlSeconds);

  try {
    await getPrReviewNotificationQueue().add(
      'notify-pr-review-activity',
      request,
      { delay: delayMs },
    );
  } catch (error) {
    await redis.del(markerKey).catch(() => undefined);
    throw error;
  }
}

/**
 * Appends a pending review-activity event for the task and returns whether
 * this call claimed responsibility for scheduling the notification job.
 */
async function appendPendingEventAndClaimSchedule({
  target,
  event,
  delayMs,
}: {
  target: PrReviewNotificationTarget;
  event: PrReviewActivityEvent;
  delayMs: number;
}): Promise<boolean> {
  const redis = getRedis();
  const pendingKey = buildPendingEventsKey(target);
  const markerKey = buildScheduledMarkerKey(target);

  await redis
    .multi()
    .rpush(pendingKey, JSON.stringify(event))
    .expire(pendingKey, PENDING_EVENTS_TTL_SECONDS)
    .exec();

  const markerTtlSeconds =
    Math.ceil(delayMs / 1000) + SCHEDULED_MARKER_TTL_BUFFER_SECONDS;

  const claim = await redis.set(markerKey, '1', 'EX', markerTtlSeconds, 'NX');

  return claim === 'OK';
}

/**
 * Atomically drains the pending review-activity events for the task and
 * clears the scheduled marker so later events schedule a fresh notification.
 */
export async function consumePendingPrReviewActivity(
  target: PrReviewNotificationTarget,
): Promise<PrReviewActivityEvent[]> {
  const redis = getRedis();
  const pendingKey = buildPendingEventsKey(target);
  const delayedMarkerKey = buildScheduledMarkerKey({
    ...target,
    immediate: false,
  });
  const immediateMarkerKey = buildScheduledMarkerKey({
    ...target,
    immediate: true,
  });

  await redis.del(delayedMarkerKey, immediateMarkerKey).catch(() => undefined);

  const results = await redis
    .multi()
    .lrange(pendingKey, 0, -1)
    .del(pendingKey)
    .exec();

  const rawEvents = results?.[0]?.[1];

  if (!Array.isArray(rawEvents)) {
    return [];
  }

  const events: PrReviewActivityEvent[] = [];

  for (const raw of rawEvents) {
    if (typeof raw !== 'string') {
      continue;
    }

    try {
      const parsed = prReviewActivityEventSchema.safeParse(JSON.parse(raw));

      if (parsed.success) {
        events.push(parsed.data);
      }
    } catch {
      // Ignore malformed entries.
    }
  }

  const roomoteBatchIds = Array.from(
    new Set(
      events.flatMap((event) =>
        event.kind !== 'review_summary' &&
        event.roomoteAuthored &&
        event.batchId
          ? [event.batchId]
          : [],
      ),
    ),
  );
  const completedBatchIds = new Set<string>();
  const roomoteHeadShas = Array.from(
    new Set(
      events.flatMap((event) =>
        event.kind !== 'review_summary' &&
        event.roomoteAuthored &&
        event.reviewHeadSha &&
        event.observedAt !== undefined
          ? [event.reviewHeadSha]
          : [],
      ),
    ),
  );
  const completedHeadObservedAt = new Map<string, number>();

  await Promise.all([
    ...roomoteBatchIds.map(async (cycleId) => {
      let completed: string | null;

      try {
        completed = await redis.get(
          getPrReviewCompletedCycleKey({
            repository: target.repository,
            prNumber: target.prNumber,
            cycleId,
          }),
        );
      } catch {
        // The pending list is already drained; fail open so feedback is not lost.
        return;
      }

      if (completed) {
        completedBatchIds.add(cycleId);
      }
    }),
    ...roomoteHeadShas.map(async (reviewHeadSha) => {
      try {
        const raw = await redis.get(
          getPrReviewLatestCompletedCycleKey({
            repository: target.repository,
            prNumber: target.prNumber,
            reviewHeadSha,
          }),
        );
        const parsed = raw
          ? prReviewCycleStateSchema.safeParse(JSON.parse(raw))
          : null;

        if (parsed?.success && parsed.data.phase === 'completed') {
          completedHeadObservedAt.set(reviewHeadSha, parsed.data.observedAt);
        }
      } catch {
        // The pending list is already drained; fail open so feedback is not lost.
      }
    }),
  ]);

  return events.filter((event) => {
    if (event.kind === 'review_summary' || !event.roomoteAuthored) {
      return true;
    }

    if (event.batchId && completedBatchIds.has(event.batchId)) {
      return false;
    }

    const completedAt = event.reviewHeadSha
      ? completedHeadObservedAt.get(event.reviewHeadSha)
      : undefined;

    return (
      completedAt === undefined ||
      event.observedAt === undefined ||
      event.observedAt > completedAt
    );
  });
}

/**
 * Requeues events that could not be delivered so a retried notification job
 * can pick them up again.
 */
export async function requeuePendingPrReviewActivity({
  target,
  events,
}: {
  target: PrReviewNotificationTarget;
  events: PrReviewActivityEvent[];
}): Promise<void> {
  if (events.length === 0) {
    return;
  }

  const redis = getRedis();
  const pendingKey = buildPendingEventsKey(target);

  await redis
    .multi()
    .rpush(pendingKey, ...events.map((event) => JSON.stringify(event)))
    .expire(pendingKey, PENDING_EVENTS_TTL_SECONDS)
    .exec();
}

/**
 * Records PR review activity (submitted reviews and review comments) for the
 * tasks that own the pull request, and schedules a notification job per task.
 * Human feedback and Roomote review cycles use separate batches. A Roomote
 * summary promotes its cycle immediately, while inline findings remain a
 * delayed fallback if no summary arrives. Chat delivery still needs an
 * originating conversation route, but web-only tasks are enqueued too so the
 * summary can land in task history.
 * The notification is informational only: it tells the user about the review
 * feedback once the task is idle. No agent turn is started.
 */
export async function enqueuePrReviewNotification(
  input: EnqueuePrReviewNotificationInput,
): Promise<EnqueuePrReviewNotificationResult> {
  const parsedInput = enqueuePrReviewNotificationInputSchema.parse(input);

  return enqueuePrReviewNotificationAttempt(parsedInput);
}

export async function replayPrReviewNotificationAssociation(
  request: PrReviewAssociationReplayRequest,
): Promise<EnqueuePrReviewNotificationResult> {
  const parsed = prReviewAssociationReplayRequestSchema.parse(request);
  const target = {
    sourceControlProvider: parsed.sourceControlProvider,
    repository: parsed.repository,
    prNumber: parsed.prNumber,
  };
  const activeMarker = await getRedis().eval(
    GET_OR_RECLAIM_ORPHAN_REPLAY_SCRIPT,
    2,
    buildOrphanActivityKey(target),
    buildOrphanReplayMarkerKey(target),
    parsed.chainId,
    ORPHAN_ACTIVITY_TTL_SECONDS,
  );

  if (
    typeof activeMarker !== 'string' ||
    !activeMarker.startsWith(`${parsed.chainId}:`)
  ) {
    return { notifiedTaskCount: 0, reason: 'stale_association_replay' };
  }

  const prTaskLinks = await findPrReviewTaskLinks(target);

  if (prTaskLinks.length === 0) {
    const nextAttempt = parsed.attempt + 1;

    if (nextAttempt <= PR_REVIEW_ASSOCIATION_REPLAY_DELAYS_MS.length) {
      await scheduleOrphanAssociationReplay({
        target,
        chainId: parsed.chainId,
        attempt: nextAttempt,
      });
    } else {
      const nextChainId = randomUUID();
      const rotated = await getRedis().eval(
        FINISH_OR_ROTATE_ORPHAN_REPLAY_SCRIPT,
        2,
        buildOrphanActivityKey(target),
        buildOrphanReplayMarkerKey(target),
        activeMarker,
        parsed.chainId,
        nextChainId,
        ORPHAN_ACTIVITY_TTL_SECONDS,
      );

      if (rotated === 1) {
        await scheduleClaimedOrphanReplay({ target, chainId: nextChainId });
      }
    }

    return { notifiedTaskCount: 0, reason: 'no_linked_tasks' };
  }

  const inputs = await consumeOrphanActivity(target, parsed.chainId);
  let notifiedTaskCount = 0;

  for (const [index, input] of inputs.entries()) {
    try {
      const result = await enqueueLinkedPrReviewNotification(
        input,
        prTaskLinks,
      );
      notifiedTaskCount += result.notifiedTaskCount;
    } catch (error) {
      const nextAttempt = parsed.attempt + 1;
      const requeueChainId =
        nextAttempt <= PR_REVIEW_ASSOCIATION_REPLAY_DELAYS_MS.length
          ? parsed.chainId
          : randomUUID();
      await requeueOrphanActivity({
        target,
        chainId: requeueChainId,
        inputs: inputs.slice(index),
      });

      try {
        await scheduleOrphanAssociationReplay({
          target,
          chainId: requeueChainId,
          attempt:
            nextAttempt <= PR_REVIEW_ASSOCIATION_REPLAY_DELAYS_MS.length
              ? nextAttempt
              : 1,
        });
      } catch (scheduleError) {
        await releaseOrphanReplay(target, requeueChainId);
        throw scheduleError;
      }

      throw error;
    }
  }

  return { notifiedTaskCount };
}

async function enqueuePrReviewNotificationAttempt(
  parsedInput: EnqueuePrReviewNotificationInput,
): Promise<EnqueuePrReviewNotificationResult> {
  const target = {
    sourceControlProvider: parsedInput.sourceControlProvider ?? 'github',
    repository: parsedInput.repository,
    prNumber: parsedInput.prNumber,
  };
  const prTaskLinks = await findPrReviewTaskLinks(target);

  if (prTaskLinks.length === 0) {
    const chainId = await appendOrphanActivityAndClaimReplay({
      target,
      input: parsedInput,
    });

    if (chainId) {
      try {
        await scheduleOrphanAssociationReplay({
          target,
          chainId,
          attempt: 1,
        });
      } catch (error) {
        await releaseOrphanReplay(target, chainId);
        await wakePrReviewNotificationAssociation(target).catch(() => false);
        throw error;
      }
    }

    return { notifiedTaskCount: 0, reason: 'no_linked_tasks' };
  }

  await wakePrReviewNotificationAssociation(target);
  return enqueueLinkedPrReviewNotification(parsedInput, prTaskLinks);
}

async function findPrReviewTaskLinks(
  target: PrReviewAssociationTarget,
): Promise<Array<{ taskId: string }>> {
  return db.query.taskPullRequests.findMany({
    where: and(
      eq(taskPullRequests.sourceControlProvider, target.sourceControlProvider),
      eq(taskPullRequests.repository, target.repository),
      eq(taskPullRequests.prNumber, target.prNumber),
    ),
    columns: { taskId: true },
  });
}

async function enqueueLinkedPrReviewNotification(
  parsedInput: EnqueuePrReviewNotificationInput,
  prTaskLinks: Array<{ taskId: string }>,
): Promise<EnqueuePrReviewNotificationResult> {
  const taskIds = Array.from(new Set(prTaskLinks.map((link) => link.taskId)));

  const isRoomoteEvent = parsedInput.event.roomoteAuthored === true;
  const isRoomoteSummary =
    isRoomoteEvent && parsedInput.event.kind === 'review_summary';
  let event = parsedInput.event;
  let previousCycleRaw: string | null = null;
  let completedCycleKey: string | null = null;
  let completedCycleValue: string | null = null;
  let latestCompletedCycleKey: string | null = null;
  let previousLatestCompletedRaw: string | null = null;

  if (isRoomoteEvent && event.reviewHeadSha) {
    const reviewHeadSha = event.reviewHeadSha;

    try {
      const cycle = await readPrReviewCycleState({
        repository: parsedInput.repository,
        prNumber: parsedInput.prNumber,
        reviewHeadSha,
      });

      if (!isRoomoteSummary && cycle.state?.phase === 'completed') {
        if (
          event.observedAt === undefined ||
          event.observedAt <= cycle.state.observedAt
        ) {
          return {
            notifiedTaskCount: 0,
            reason: 'review_cycle_completed',
          };
        }
      }

      if (
        isRoomoteSummary &&
        cycle.state &&
        event.observedAt !== undefined &&
        cycle.state.observedAt > event.observedAt
      ) {
        return {
          notifiedTaskCount: 0,
          reason: 'stale_review_cycle',
        };
      }

      const cycleId =
        cycle.state?.phase === 'completed'
          ? (event.batchId ?? `head:${event.reviewHeadSha}`)
          : (cycle.state?.cycleId ??
            event.batchId ??
            `head:${event.reviewHeadSha}`);
      event = { ...event, batchId: cycleId };

      if (isRoomoteSummary) {
        const completedState = JSON.stringify({
          cycleId,
          phase: 'completed',
          observedAt: event.observedAt ?? Date.now(),
        } satisfies PrReviewCycleState);
        completedCycleKey = getPrReviewCompletedCycleKey({
          repository: parsedInput.repository,
          prNumber: parsedInput.prNumber,
          cycleId,
        });
        completedCycleValue = completedState;
        previousCycleRaw = cycle.raw;
        latestCompletedCycleKey = getPrReviewLatestCompletedCycleKey({
          repository: parsedInput.repository,
          prNumber: parsedInput.prNumber,
          reviewHeadSha,
        });
        previousLatestCompletedRaw = await getRedis().get(
          latestCompletedCycleKey,
        );

        const completed = await getRedis().eval(
          COMPLETE_REVIEW_CYCLE_SCRIPT,
          3,
          cycle.key,
          completedCycleKey,
          latestCompletedCycleKey,
          cycleId,
          event.observedAt ?? Date.now(),
          completedState,
          REVIEW_CYCLE_TTL_SECONDS,
        );

        if (completed !== 1) {
          return {
            notifiedTaskCount: 0,
            reason: 'stale_review_cycle',
          };
        }
      }
    } catch (error) {
      // Completion lookups are an optimization. Fail open so transient Redis
      // reads never discard review feedback.
      if (isRoomoteSummary) {
        throw error;
      }
    }
  }

  let notifiedTaskCount = 0;
  const notificationDelayMs = isRoomoteSummary
    ? 0
    : isRoomoteEvent
      ? PR_REVIEW_NOTIFICATION_ROOMOTE_FALLBACK_MS
      : PR_REVIEW_NOTIFICATION_DEBOUNCE_MS;

  try {
    for (const taskId of taskIds) {
      const immediate = isRoomoteSummary;
      const target = {
        taskId,
        repository: parsedInput.repository,
        prNumber: parsedInput.prNumber,
        sourceControlProvider:
          parsedInput.sourceControlProvider ?? ('github' as const),
        immediate,
        batchKind: isRoomoteEvent ? ('roomote' as const) : ('human' as const),
        ...(event.batchId ? { batchId: event.batchId } : {}),
      };

      const claimed = await appendPendingEventAndClaimSchedule({
        target,
        event,
        delayMs: notificationDelayMs,
      });

      if (claimed) {
        try {
          await getPrReviewNotificationQueue().add(
            'notify-pr-review-activity',
            {
              ...target,
              prUrl: parsedInput.prUrl,
              deferrals: 0,
              immediate,
              sourceControlProvider: target.sourceControlProvider,
            },
            { delay: notificationDelayMs },
          );
        } catch (error) {
          await getRedis()
            .del(buildScheduledMarkerKey(target))
            .catch(() => undefined);
          throw error;
        }
      }

      notifiedTaskCount += 1;
    }
  } catch (error) {
    if (
      completedCycleKey &&
      completedCycleValue &&
      latestCompletedCycleKey &&
      event.reviewHeadSha
    ) {
      const cycleStateKey = getPrReviewCycleStateKey({
        repository: parsedInput.repository,
        prNumber: parsedInput.prNumber,
        reviewHeadSha: event.reviewHeadSha,
      });
      await getRedis()
        .del(completedCycleKey)
        .catch(() => undefined);
      await getRedis()
        .eval(
          RESTORE_REVIEW_CYCLE_IF_VALUE_MATCHES_SCRIPT,
          1,
          cycleStateKey,
          completedCycleValue,
          previousCycleRaw ?? '',
          REVIEW_CYCLE_TTL_SECONDS,
        )
        .catch(() => undefined);
      await getRedis()
        .eval(
          RESTORE_REVIEW_CYCLE_IF_VALUE_MATCHES_SCRIPT,
          1,
          latestCompletedCycleKey,
          completedCycleValue,
          previousLatestCompletedRaw ?? '',
          REVIEW_CYCLE_TTL_SECONDS,
        )
        .catch(() => undefined);
    }

    throw error;
  }

  return { notifiedTaskCount };
}

function getPrReviewLinkFormatter(
  provider: CommunicationProvider,
): (label: string, url: string) => string {
  switch (provider) {
    case 'slack':
      return (label, url) => `<${url}|${label}>`;
    case 'teams':
      return (label, url) => `[${label}](${url})`;
    case 'telegram':
      return (label, url) => `${label} (${url})`;
    case 'discord':
      return (label, url) => `[${label}](${url})`;
  }
}

const MARKDOWN_LINK_SOURCE = String.raw`\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)`;

/**
 * Formats the notification text for aggregated PR review activity. The
 * summary (an LLM-written message that weaves markdown links to the pull
 * request or specific comments inline) is the entire message body; its
 * markdown links are converted to each provider's link syntax (Slack mrkdwn,
 * Teams Markdown, Telegram plain text). When the summary carries no link at
 * all, a link to the pull request is appended so the target stays reachable.
 */
export function formatPrReviewActivityMessage({
  repository,
  prNumber,
  prUrl,
  provider,
  summary,
}: {
  repository: string;
  prNumber: number;
  prUrl: string;
  provider: CommunicationProvider;
  summary: string;
}): string {
  const formatLink = getPrReviewLinkFormatter(provider);
  const trimmedSummary = summary.trim();
  const hasInlineLink = new RegExp(MARKDOWN_LINK_SOURCE).test(trimmedSummary);

  const text =
    provider === 'teams'
      ? trimmedSummary
      : trimmedSummary.replace(
          new RegExp(MARKDOWN_LINK_SOURCE, 'g'),
          (_match, label, url) => formatLink(label, url),
        );

  if (hasInlineLink) {
    return text;
  }

  return `${text}\n${formatLink(`${repository}#${prNumber}`, prUrl)}`;
}
