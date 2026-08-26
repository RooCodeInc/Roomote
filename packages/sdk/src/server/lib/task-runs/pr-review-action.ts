import {
  attachCanonicalPrReviewActionMessage,
  claimCanonicalPrReviewAction,
  completeCanonicalPrReviewActionDispatch,
  db,
  eq,
  findPrReviewAutoPreference,
  retireCanonicalPrReviewActionsForDestination,
  slackInstallations,
  upsertPrReviewAutoPreference,
} from '@roomote/db/server';
import { getRedis } from '@roomote/redis';
import type { SourceControlProvider } from '@roomote/types';

/** Conversation providers that can render PR review action buttons. */
export type PrReviewActionProvider = 'slack' | 'discord' | 'telegram';

const PR_REVIEW_ACTION_PREFIX = 'pr-review-action:';
// The notification stays actionable for a week; after that the buttons report
// the offer as expired and the user falls back to replying in the thread.
const PR_REVIEW_ACTION_TTL_SECONDS = 7 * 24 * 60 * 60;

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * Pending state behind a PR review-feedback notification's action buttons.
 * Keyed by a nonce carried in the button value; claimed atomically on the
 * first click so double-clicks and concurrent clickers cannot dispatch the
 * follow-up twice.
 */
export interface PendingPrReviewAction {
  nonce: string;
  provider: PrReviewActionProvider;
  /** Slack workspace identity. Absent only on legacy pending records. */
  slackTeamId?: string;
  taskId: string;
  repository: string;
  prNumber: number;
  prUrl: string;
  channelId: string;
  /**
   * Slack thread_ts, Discord thread channel id, or Telegram topic id; null
   * for conversations without a thread dimension.
   */
  threadId: string | null;
  /**
   * Self-contained imperative instruction injected into the task when the
   * user accepts, written by the notification triage LLM alongside the
   * summary.
   */
  followUpPrompt: string;
  /**
   * Provider-native id of the posted notification message (Slack ts, Discord
   * or Telegram message id), attached after posting so the offer can be
   * visually retired later.
   */
  messageId?: string | null;
  /** Present for actions owned by the canonical Postgres delivery row. */
  canonicalDeliveryId?: string;
}

// GETDEL is atomic: exactly one clicker receives the record; every later
// click sees nil and reports the action as already handled.
const CLAIM_PR_REVIEW_ACTION_LUA = `
local val = redis.call('get', KEYS[1])
if not val then return nil end
if ARGV[1] ~= '' then
  local pending = cjson.decode(val)
  if pending.provider == 'slack' then
    if pending.slackTeamId and pending.slackTeamId ~= ARGV[1] then return nil end
    if not pending.slackTeamId and ARGV[2] ~= '1' then return nil end
  end
end
redis.call('del', KEYS[1])
return val
`;

// Attaching a message must not revive an offer that a typed reply or button
// click claimed after the notification was posted.
const ATTACH_PR_REVIEW_ACTION_MESSAGE_LUA = `
local val = redis.call('get', KEYS[1])
if not val then return 0 end
local pending = cjson.decode(val)
pending.messageId = ARGV[1]
redis.call('set', KEYS[1], cjson.encode(pending), 'KEEPTTL')
return 1
`;

// Read, clear, and claim the complete conversation index in one operation so
// offers added concurrently remain indexed for a later typed reply.
const CLAIM_PR_REVIEW_ACTIONS_FOR_THREAD_LUA = `
local nonces = redis.call('smembers', KEYS[1])
if #nonces == 0 then return {} end
redis.call('del', KEYS[1])
local claimed = {}
for _, nonce in ipairs(nonces) do
  local actionKey = ARGV[1] .. nonce
  local val = redis.call('get', actionKey)
  if val then
    redis.call('del', actionKey)
    table.insert(claimed, val)
  end
end
return claimed
`;

function getPrReviewActionKey(nonce: string): string {
  return `${PR_REVIEW_ACTION_PREFIX}${nonce}`;
}

// Secondary index: every pending offer nonce for a conversation, so a typed
// reply in the thread can retire all of them at once.
function getPrReviewActionThreadKey(input: {
  provider: PrReviewActionProvider;
  slackTeamId?: string;
  channelId: string;
  threadId: string | null;
}): string {
  if (input.provider !== 'slack' || !input.slackTeamId) {
    return `${PR_REVIEW_ACTION_PREFIX}thread:${input.provider}:${input.channelId}:${input.threadId ?? '-'}`;
  }

  return `${PR_REVIEW_ACTION_PREFIX}thread:${input.provider}:${input.slackTeamId}:${input.channelId}:${input.threadId ?? '-'}`;
}

export async function setPendingPrReviewAction(
  pending: PendingPrReviewAction,
): Promise<void> {
  if (pending.canonicalDeliveryId) {
    return;
  }
  const redis = getRedis();
  const threadKey = getPrReviewActionThreadKey(pending);

  await redis
    .multi()
    .set(
      getPrReviewActionKey(pending.nonce),
      JSON.stringify(pending),
      'EX',
      PR_REVIEW_ACTION_TTL_SECONDS,
    )
    .sadd(threadKey, pending.nonce)
    .expire(threadKey, PR_REVIEW_ACTION_TTL_SECONDS)
    .exec();
}

/**
 * Records the posted notification message id on an already-stored pending
 * offer so retirement can edit the message later. No-op when the offer was
 * already claimed.
 */
export async function attachPendingPrReviewActionMessage(
  nonce: string,
  messageId: string,
  options: { leaseToken?: string } = {},
): Promise<boolean> {
  if (
    isUuid(nonce) &&
    options.leaseToken &&
    (await attachCanonicalPrReviewActionMessage(
      nonce,
      messageId,
      options.leaseToken,
    ))
  ) {
    return true;
  }
  const redis = getRedis();
  const attached = await redis
    .eval(
      ATTACH_PR_REVIEW_ACTION_MESSAGE_LUA,
      1,
      getPrReviewActionKey(nonce),
      messageId,
    )
    .catch(() => 0);
  return attached === 1;
}

export async function claimPendingPrReviewAction(
  nonce: string,
  options: {
    expectedSlackTeamId?: string;
    choice?: 'yes' | 'auto' | 'dismiss';
    actingUserId?: string;
  } = {},
): Promise<PendingPrReviewAction | null> {
  const canonical = isUuid(nonce)
    ? await claimCanonicalPrReviewAction({
        deliveryId: nonce,
        choice: options.choice ?? 'yes',
        actingUserId: options.actingUserId,
        expectedSlackTeamId: options.expectedSlackTeamId,
      })
    : null;
  if (
    canonical?.provider &&
    canonical.provider !== 'teams' &&
    canonical.taskId &&
    canonical.channelId &&
    canonical.followUpPrompt
  ) {
    return {
      nonce,
      canonicalDeliveryId: nonce,
      provider: canonical.provider,
      ...(canonical.provider === 'slack' && canonical.slackTeamId
        ? { slackTeamId: canonical.slackTeamId }
        : {}),
      taskId: canonical.taskId,
      repository: canonical.repository,
      prNumber: canonical.prNumber,
      prUrl: canonical.prUrl,
      channelId: canonical.channelId,
      threadId: canonical.threadId,
      followUpPrompt: canonical.followUpPrompt,
      messageId: canonical.messageId,
    };
  }

  const redis = getRedis();
  let allowLegacySlackRecord = false;

  if (options.expectedSlackTeamId) {
    const rawPending = await redis.get(getPrReviewActionKey(nonce));

    try {
      const pending = rawPending
        ? (JSON.parse(rawPending) as PendingPrReviewAction)
        : null;

      if (pending?.provider === 'slack' && !pending.slackTeamId) {
        allowLegacySlackRecord = await isOnlyActiveSlackWorkspace(
          options.expectedSlackTeamId,
        );
      }
    } catch {
      return null;
    }
  }

  const raw = await redis.eval(
    CLAIM_PR_REVIEW_ACTION_LUA,
    1,
    getPrReviewActionKey(nonce),
    options.expectedSlackTeamId ?? '',
    allowLegacySlackRecord ? '1' : '0',
  );

  if (typeof raw !== 'string') {
    return null;
  }

  try {
    const pending = JSON.parse(raw) as PendingPrReviewAction;

    await redis
      .srem(getPrReviewActionThreadKey(pending), nonce)
      .catch(() => undefined);

    return pending;
  } catch {
    return null;
  }
}

export async function completePendingPrReviewActionDispatch(
  pending: PendingPrReviewAction,
  runId: number,
): Promise<void> {
  if (!pending.canonicalDeliveryId) return;
  await completeCanonicalPrReviewActionDispatch({
    deliveryId: pending.canonicalDeliveryId,
    runId,
  });
}

async function isOnlyActiveSlackWorkspace(teamId: string): Promise<boolean> {
  const installations = await db.query.slackInstallations.findMany({
    where: eq(slackInstallations.isActive, true),
    columns: { teamId: true },
    limit: 2,
  });

  return installations.length === 1 && installations[0]?.teamId === teamId;
}

/**
 * Claims every pending offer bound to a conversation — used when a typed
 * reply lands in the thread, which supersedes the offers: the person chose
 * their own response, so the buttons must die. Returns the claimed records
 * so callers can visually retire the posted messages.
 */
export async function claimPendingPrReviewActionsForThread(input: {
  provider: PrReviewActionProvider;
  slackTeamId?: string;
  channelId: string;
  threadId: string | null;
}): Promise<PendingPrReviewAction[]> {
  const canonical = (
    await retireCanonicalPrReviewActionsForDestination(input)
  ).flatMap((action) =>
    action?.provider &&
    action.provider !== 'teams' &&
    action.taskId &&
    action.channelId &&
    action.followUpPrompt
      ? [
          {
            nonce: action.deliveryId,
            canonicalDeliveryId: action.deliveryId,
            provider: action.provider,
            ...(action.provider === 'slack' && action.slackTeamId
              ? { slackTeamId: action.slackTeamId }
              : {}),
            taskId: action.taskId,
            repository: action.repository,
            prNumber: action.prNumber,
            prUrl: action.prUrl,
            channelId: action.channelId,
            threadId: action.threadId,
            followUpPrompt: action.followUpPrompt,
            messageId: action.messageId,
          } satisfies PendingPrReviewAction,
        ]
      : [],
  );
  const redis = getRedis();
  const threadKeys = [getPrReviewActionThreadKey(input)];

  if (
    input.provider === 'slack' &&
    input.slackTeamId &&
    (await isOnlyActiveSlackWorkspace(input.slackTeamId))
  ) {
    threadKeys.push(
      getPrReviewActionThreadKey({ ...input, slackTeamId: undefined }),
    );
  }

  const claimed: PendingPrReviewAction[] = [];

  for (const threadKey of threadKeys) {
    const rawClaims = await redis.eval(
      CLAIM_PR_REVIEW_ACTIONS_FOR_THREAD_LUA,
      1,
      threadKey,
      PR_REVIEW_ACTION_PREFIX,
    );

    for (const raw of Array.isArray(rawClaims) ? rawClaims : []) {
      if (typeof raw !== 'string') {
        continue;
      }

      try {
        claimed.push(JSON.parse(raw) as PendingPrReviewAction);
      } catch {
        // Malformed record; skip.
      }
    }
  }

  return [...canonical, ...claimed];
}

/**
 * Marks a task's PR so future review feedback is dispatched into the task
 * automatically instead of asking first. The enabling user becomes the acting
 * user for those auto-dispatched follow-ups.
 */
export async function enableAutoHandlePrReviewFeedback(input: {
  taskId: string;
  repository: string;
  prNumber: number;
  userId: string;
  sourceControlProvider?: SourceControlProvider;
  host?: string | null;
  repositoryId?: string | null;
  sourceDestinationKey?: string | null;
}): Promise<void> {
  await upsertPrReviewAutoPreference({
    sourceControlProvider: input.sourceControlProvider ?? 'github',
    host: input.host,
    repositoryId: input.repositoryId,
    repository: input.repository,
    prNumber: input.prNumber,
    enabledByUserId: input.userId,
    sourceTaskId: input.taskId,
    sourceDestinationKey: input.sourceDestinationKey,
  });
}

export async function findAutoHandlePrReviewFeedbackPreference(input: {
  sourceControlProvider: SourceControlProvider;
  host?: string | null;
  repositoryId?: string | null;
  repository: string;
  prNumber: number;
}): Promise<{
  taskId: string;
  userId: string;
  destinationKey: string | null;
} | null> {
  const preference = await findPrReviewAutoPreference(input);
  return preference;
}
