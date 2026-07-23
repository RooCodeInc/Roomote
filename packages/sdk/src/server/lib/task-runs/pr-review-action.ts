import { and, db, eq, taskPullRequests } from '@roomote/db/server';
import { getRedis } from '@roomote/redis';

/** Conversation providers that can render PR review action buttons. */
export type PrReviewActionProvider = 'slack' | 'discord' | 'telegram';

const PR_REVIEW_ACTION_PREFIX = 'pr-review-action:';
// The notification stays actionable for a week; after that the buttons report
// the offer as expired and the user falls back to replying in the thread.
const PR_REVIEW_ACTION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Pending state behind a PR review-feedback notification's action buttons.
 * Keyed by a nonce carried in the button value; claimed atomically on the
 * first click so double-clicks and concurrent clickers cannot dispatch the
 * follow-up twice.
 */
export interface PendingPrReviewAction {
  nonce: string;
  provider: PrReviewActionProvider;
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
}

// GETDEL is atomic: exactly one clicker receives the record; every later
// click sees nil and reports the action as already handled.
const CLAIM_PR_REVIEW_ACTION_LUA = `
local val = redis.call('get', KEYS[1])
if not val then return nil end
redis.call('del', KEYS[1])
return val
`;

function getPrReviewActionKey(nonce: string): string {
  return `${PR_REVIEW_ACTION_PREFIX}${nonce}`;
}

// Secondary index: every pending offer nonce for a conversation, so a typed
// reply in the thread can retire all of them at once.
function getPrReviewActionThreadKey(input: {
  provider: PrReviewActionProvider;
  channelId: string;
  threadId: string | null;
}): string {
  return `${PR_REVIEW_ACTION_PREFIX}thread:${input.provider}:${input.channelId}:${input.threadId ?? '-'}`;
}

export async function setPendingPrReviewAction(
  pending: PendingPrReviewAction,
): Promise<void> {
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
): Promise<void> {
  const redis = getRedis();
  const key = getPrReviewActionKey(nonce);
  const raw = await redis.get(key);

  if (typeof raw !== 'string') {
    return;
  }

  try {
    const pending = JSON.parse(raw) as PendingPrReviewAction;

    await redis.set(
      key,
      JSON.stringify({ ...pending, messageId }),
      'EX',
      PR_REVIEW_ACTION_TTL_SECONDS,
    );
  } catch {
    // Malformed record; leave it to expire.
  }
}

export async function claimPendingPrReviewAction(
  nonce: string,
): Promise<PendingPrReviewAction | null> {
  const redis = getRedis();
  const raw = await redis.eval(
    CLAIM_PR_REVIEW_ACTION_LUA,
    1,
    getPrReviewActionKey(nonce),
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

/**
 * Claims every pending offer bound to a conversation — used when a typed
 * reply lands in the thread, which supersedes the offers: the person chose
 * their own response, so the buttons must die. Returns the claimed records
 * so callers can visually retire the posted messages.
 */
export async function claimPendingPrReviewActionsForThread(input: {
  provider: PrReviewActionProvider;
  channelId: string;
  threadId: string | null;
}): Promise<PendingPrReviewAction[]> {
  const redis = getRedis();
  const threadKey = getPrReviewActionThreadKey(input);
  const nonces = await redis.smembers(threadKey);

  if (nonces.length === 0) {
    return [];
  }

  await redis.del(threadKey).catch(() => undefined);

  const claimed: PendingPrReviewAction[] = [];

  for (const nonce of nonces) {
    const raw = await redis.eval(
      CLAIM_PR_REVIEW_ACTION_LUA,
      1,
      getPrReviewActionKey(nonce),
    );

    if (typeof raw !== 'string') {
      continue;
    }

    try {
      claimed.push(JSON.parse(raw) as PendingPrReviewAction);
    } catch {
      // Malformed record; skip.
    }
  }

  return claimed;
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
}): Promise<void> {
  await db
    .update(taskPullRequests)
    .set({ autoHandleFeedbackByUserId: input.userId })
    .where(
      and(
        eq(taskPullRequests.taskId, input.taskId),
        eq(taskPullRequests.repository, input.repository),
        eq(taskPullRequests.prNumber, input.prNumber),
      ),
    );
}
