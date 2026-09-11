import {
  and,
  attachCanonicalPrReviewActionMessageWithRetirement as attachCanonicalPrReviewActionMessage,
  claimCanonicalPrReviewAction,
  completeCanonicalPrReviewActionDispatch,
  db,
  eq,
  findPrReviewAutoPreference,
  retireCanonicalPrReviewActionsForDestination,
  retireCanonicalPrReviewActionsForPullRequest,
  slackInstallations,
  upsertPrReviewAutoPreference,
  withCanonicalPrReviewSlackThreadActionFence,
} from '@roomote/db/server';
import { getRedis } from '@roomote/redis';
import {
  buildResolvedSlackPrReviewMessageBlocks,
  SlackNotifier,
} from '@roomote/slack';
import type { SourceControlProvider } from '@roomote/types';

import { getCommunicationProviderAdapter } from '../communication-providers';

/** Conversation providers that can render PR review action buttons. */
export type PrReviewActionProvider = 'slack' | 'discord' | 'telegram';

const PR_REVIEW_ACTION_PREFIX = 'pr-review-action:';
const PR_REVIEW_ACTION_ORDER_KEY = `${PR_REVIEW_ACTION_PREFIX}order`;
// The notification stays actionable for a week; after that the buttons report
// the offer as expired and the user falls back to replying in the thread.
const PR_REVIEW_ACTION_TTL_SECONDS = 7 * 24 * 60 * 60;

// A Fast-parent provider post can be retried with the same visible nonce.
// Preserve the first attempt's ordering and retired state instead of reviving
// or reordering it when the retry recreates pending state.
const SET_PENDING_PR_REVIEW_ACTION_LUA = `
if redis.call('exists', KEYS[1]) == 1 then return 0 end
local pending = cjson.decode(ARGV[1])
pending.createdOrder = redis.call('incr', KEYS[3])
redis.call('set', KEYS[1], cjson.encode(pending), 'EX', ARGV[2])
redis.call('sadd', KEYS[2], pending.nonce)
redis.call('expire', KEYS[2], ARGV[2])
return 1
`;

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
  /** Monotonic creation order used by non-Slack attachment arbitration. */
  createdOrder?: number;
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
local pending = cjson.decode(val)
if pending.retired then return nil end
if pending.messageId then
  redis.call('del', KEYS[1])
else
  pending.retired = true
  redis.call('set', KEYS[1], cjson.encode(pending), 'KEEPTTL')
end
return val
`;

// Attaching a message must not revive an offer that a typed reply or button
// click claimed after the notification was posted.
const ATTACH_PR_REVIEW_ACTION_MESSAGE_LUA = `
local val = redis.call('get', KEYS[1])
if not val then return {0, ''} end
local pending = cjson.decode(val)
pending.messageId = ARGV[1]
if pending.retired then
  redis.call('del', KEYS[1])
  redis.call('srem', KEYS[2], pending.nonce)
  local winner = ARGV[3] ~= '' and ARGV[3] or pending.messageId
  return {1, winner, cjson.encode(pending)}
end
redis.call('set', KEYS[1], cjson.encode(pending), 'KEEPTTL')
local nonces = redis.call('smembers', KEYS[2])
local function sameContext(prior)
  local sameSlackTeam = (prior.slackTeamId == pending.slackTeamId)
    or (not prior.slackTeamId and not pending.slackTeamId)
  if pending.provider == 'slack' then
    return prior.provider == 'slack' and sameSlackTeam
  end
  return prior.provider == pending.provider
    and prior.repository == pending.repository
    and prior.prNumber == pending.prNumber
end
local claimed = {}
if pending.provider == 'slack' then
  local winner = pending.messageId
  if ARGV[3] ~= '' and ARGV[3] > winner then winner = ARGV[3] end
  for _, nonce in ipairs(nonces) do
    if nonce ~= pending.nonce then
      local previous = redis.call('get', ARGV[2] .. nonce)
      if previous then
        local prior = cjson.decode(previous)
        if sameContext(prior) and prior.messageId and prior.messageId > winner then
          winner = prior.messageId
        end
      end
    end
  end
  for _, nonce in ipairs(nonces) do
    if nonce ~= pending.nonce then
      local previousKey = ARGV[2] .. nonce
      local previous = redis.call('get', previousKey)
      if previous then
        local prior = cjson.decode(previous)
        if sameContext(prior) and prior.messageId and prior.messageId < winner then
          redis.call('srem', KEYS[2], nonce)
          redis.call('del', previousKey)
          table.insert(claimed, previous)
        end
      end
    end
  end
  if pending.messageId < winner then
    redis.call('del', KEYS[1])
    redis.call('srem', KEYS[2], pending.nonce)
    table.insert(claimed, cjson.encode(pending))
  end
  table.insert(claimed, 1, winner)
  table.insert(claimed, 1, 1)
  return claimed
end
for _, nonce in ipairs(nonces) do
  if nonce ~= pending.nonce then
    local previous = redis.call('get', ARGV[2] .. nonce)
    if previous then
      local prior = cjson.decode(previous)
      local priorCreatedOrder = prior.createdOrder or 0
      local pendingCreatedOrder = pending.createdOrder or 0
      if sameContext(prior)
        and priorCreatedOrder > pendingCreatedOrder then
        redis.call('del', KEYS[1])
        redis.call('srem', KEYS[2], pending.nonce)
        return {1, pending.messageId, cjson.encode(pending)}
      end
    end
  end
end
for _, nonce in ipairs(nonces) do
  if nonce ~= pending.nonce then
    local previousKey = ARGV[2] .. nonce
    local previous = redis.call('get', previousKey)
    if previous then
      local prior = cjson.decode(previous)
      if sameContext(prior) then
        redis.call('srem', KEYS[2], nonce)
        if prior.messageId then
          redis.call('del', previousKey)
          table.insert(claimed, previous)
        else
          prior.retired = true
          redis.call('set', previousKey, cjson.encode(prior), 'KEEPTTL')
        end
      end
    end
  end
end
table.insert(claimed, 1, pending.messageId)
table.insert(claimed, 1, 1)
return claimed
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
    local pending = cjson.decode(val)
    if pending.messageId then
      redis.call('del', actionKey)
      table.insert(claimed, val)
    else
      pending.retired = true
      redis.call('set', actionKey, cjson.encode(pending), 'KEEPTTL')
    end
  end
end
return claimed
`;

const RETIRE_LEGACY_PR_REVIEW_ACTIONS_FOR_CONTEXT_LUA = `
local context = cjson.decode(ARGV[2])
local nonces = redis.call('smembers', KEYS[1])
local retired = {}
for _, nonce in ipairs(nonces) do
  local actionKey = ARGV[1] .. nonce
  local val = redis.call('get', actionKey)
  if val then
    local pending = cjson.decode(val)
    local sameSlackTeam = (pending.slackTeamId == context.slackTeamId)
      or (not pending.slackTeamId and not context.slackTeamId)
    local sameContext = false
    if context.provider == 'slack' then
      sameContext = pending.provider == 'slack' and sameSlackTeam
    else
      sameContext = pending.provider == context.provider
        and pending.repository == context.repository
        and pending.prNumber == context.prNumber
    end
    if sameContext then
      redis.call('srem', KEYS[1], nonce)
      if pending.messageId then
        redis.call('del', actionKey)
        table.insert(retired, val)
      else
        pending.retired = true
        redis.call('set', actionKey, cjson.encode(pending), 'KEEPTTL')
      end
    end
  end
end
return retired
`;

const ARBITRATE_LEGACY_SLACK_PR_REVIEW_ACTIONS_LUA = `
local context = cjson.decode(ARGV[2])
local winner = ARGV[3]
local nonces = redis.call('smembers', KEYS[1])
for _, nonce in ipairs(nonces) do
  local val = redis.call('get', ARGV[1] .. nonce)
  if val then
    local pending = cjson.decode(val)
    local sameSlackTeam = (pending.slackTeamId == context.slackTeamId)
      or (not pending.slackTeamId and not context.slackTeamId)
    if pending.provider == 'slack' and sameSlackTeam
      and pending.messageId and pending.messageId > winner then
      winner = pending.messageId
    end
  end
end
local retired = {}
for _, nonce in ipairs(nonces) do
  local actionKey = ARGV[1] .. nonce
  local val = redis.call('get', actionKey)
  if val then
    local pending = cjson.decode(val)
    local sameSlackTeam = (pending.slackTeamId == context.slackTeamId)
      or (not pending.slackTeamId and not context.slackTeamId)
    if pending.provider == 'slack' and sameSlackTeam
      and pending.messageId and pending.messageId < winner then
      redis.call('srem', KEYS[1], nonce)
      redis.call('del', actionKey)
      table.insert(retired, val)
    end
  end
end
table.insert(retired, 1, winner)
return retired
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

  await redis.eval(
    SET_PENDING_PR_REVIEW_ACTION_LUA,
    3,
    getPrReviewActionKey(pending.nonce),
    threadKey,
    PR_REVIEW_ACTION_ORDER_KEY,
    JSON.stringify(pending),
    String(PR_REVIEW_ACTION_TTL_SECONDS),
  );
}

/**
 * Records the posted notification message id on an already-stored pending
 * offer so retirement can edit the message later. This also atomically claims
 * every older offer for the same Slack thread or provider-specific PR
 * conversation. No-op when the new offer was already claimed.
 */
export async function attachPendingPrReviewActionMessage(
  nonce: string,
  messageId: string,
  options: { leaseToken?: string; context?: PendingPrReviewAction } = {},
): Promise<boolean> {
  const result = await attachPendingPrReviewActionMessageWithRetirement(
    nonce,
    messageId,
    options,
  );
  return result.attached;
}

export async function attachPendingPrReviewActionMessageWithRetirement(
  nonce: string,
  messageId: string,
  options: { leaseToken?: string; context?: PendingPrReviewAction } = {},
): Promise<{
  attached: boolean;
  superseded: RetirablePrReviewActionMessage[];
}> {
  if (isUuid(nonce) && options.leaseToken) {
    const slackContext =
      options.context?.provider === 'slack' &&
      options.context.slackTeamId &&
      options.context.threadId
        ? {
            ...options.context,
            provider: 'slack' as const,
            slackTeamId: options.context.slackTeamId,
            threadId: options.context.threadId,
          }
        : null;
    let legacySuperseded: PendingPrReviewAction[] = [];
    let canonicalResult: Awaited<
      ReturnType<typeof attachCanonicalPrReviewActionMessage>
    >;
    try {
      canonicalResult = await attachCanonicalPrReviewActionMessage(
        nonce,
        messageId,
        options.leaseToken,
        slackContext
          ? {
              arbitrateSlackThread: async (newestCanonicalMessageId) => {
                const result = await arbitrateLegacySlackPrReviewActions(
                  slackContext,
                  newestCanonicalMessageId,
                );
                legacySuperseded = result.superseded;
                return result.newestMessageId;
              },
            }
          : {},
      );
    } catch (error) {
      await retirePrReviewActionMessagesBestEffort(legacySuperseded);
      throw error;
    }
    if (!canonicalResult.attached) {
      return { attached: false, superseded: [] };
    }
    const canonicalSuperseded = toRetirableCanonicalMessages(
      canonicalResult.superseded,
    );
    const nonSlackLegacySuperseded =
      options.context && !slackContext
        ? await retireLegacyPrReviewActionsForContext(options.context)
        : [];
    return {
      attached: true,
      superseded: [
        ...canonicalSuperseded,
        ...legacySuperseded,
        ...nonSlackLegacySuperseded,
      ],
    };
  }

  const redis = getRedis();
  const rawPending = await redis.get(getPrReviewActionKey(nonce));
  if (!rawPending) return { attached: false, superseded: [] };

  let pending: PendingPrReviewAction;
  try {
    pending = JSON.parse(rawPending) as PendingPrReviewAction;
  } catch {
    return { attached: false, superseded: [] };
  }

  const attachRedis = async (newestCanonicalMessageId: string | null) => {
    const rawClaims = await redis.eval(
      ATTACH_PR_REVIEW_ACTION_MESSAGE_LUA,
      2,
      getPrReviewActionKey(nonce),
      getPrReviewActionThreadKey(pending),
      messageId,
      PR_REVIEW_ACTION_PREFIX,
      newestCanonicalMessageId ?? '',
    );
    return parseRedisPrReviewActionRetirement(rawClaims);
  };

  if (pending.provider === 'slack' && pending.slackTeamId && pending.threadId) {
    let redisSuperseded: PendingPrReviewAction[] = [];
    let fenced: {
      result: Awaited<ReturnType<typeof attachRedis>>;
      superseded: Parameters<typeof toRetirableCanonicalMessages>[0];
    };
    try {
      fenced = await withCanonicalPrReviewSlackThreadActionFence(
        {
          slackTeamId: pending.slackTeamId,
          channelId: pending.channelId,
          threadId: pending.threadId,
        },
        async (newestCanonicalMessageId) => {
          const result = await attachRedis(newestCanonicalMessageId);
          redisSuperseded = result.superseded;
          return {
            newestMessageId:
              result.newestMessageId ?? newestCanonicalMessageId ?? messageId,
            retireCanonical: result.attached,
            result,
          };
        },
      );
    } catch (error) {
      await retirePrReviewActionMessagesBestEffort(redisSuperseded);
      throw error;
    }
    return {
      attached: fenced.result.attached,
      superseded: [
        ...toRetirableCanonicalMessages(fenced.superseded),
        ...fenced.result.superseded,
      ],
    };
  }

  const result = await attachRedis(null);
  return { attached: result.attached, superseded: result.superseded };
}

function parseRedisPrReviewActionRetirement(rawResult: unknown): {
  attached: boolean;
  newestMessageId: string | null;
  superseded: PendingPrReviewAction[];
} {
  const values = Array.isArray(rawResult) ? rawResult : [];
  const superseded: PendingPrReviewAction[] = [];
  for (const raw of values.slice(2)) {
    if (typeof raw !== 'string') continue;
    try {
      superseded.push(JSON.parse(raw) as PendingPrReviewAction);
    } catch {
      // Malformed record; skip.
    }
  }
  return {
    attached: values[0] === 1,
    newestMessageId:
      typeof values[1] === 'string' && values[1] ? values[1] : null,
    superseded,
  };
}

function toRetirableCanonicalMessages(
  actions: Array<{
    provider: 'slack' | 'teams' | 'telegram' | 'discord' | null;
    slackTeamId: string | null;
    channelId: string | null;
    threadId: string | null;
    messageId: string | null;
  }>,
): RetirablePrReviewActionMessage[] {
  return actions.flatMap((action) =>
    action.provider && action.provider !== 'teams' && action.channelId
      ? [
          {
            provider: action.provider,
            ...(action.provider === 'slack' && action.slackTeamId
              ? { slackTeamId: action.slackTeamId }
              : {}),
            channelId: action.channelId,
            threadId: action.threadId,
            messageId: action.messageId,
          } satisfies RetirablePrReviewActionMessage,
        ]
      : [],
  );
}

async function arbitrateLegacySlackPrReviewActions(
  context: PendingPrReviewAction & {
    provider: 'slack';
    slackTeamId: string;
    threadId: string;
  },
  newestCanonicalMessageId: string,
): Promise<{
  newestMessageId: string;
  superseded: PendingPrReviewAction[];
}> {
  const redis = getRedis();
  const rawResult = await redis.eval(
    ARBITRATE_LEGACY_SLACK_PR_REVIEW_ACTIONS_LUA,
    1,
    getPrReviewActionThreadKey(context),
    PR_REVIEW_ACTION_PREFIX,
    JSON.stringify(context),
    newestCanonicalMessageId,
  );
  const values = Array.isArray(rawResult) ? rawResult : [];
  const superseded: PendingPrReviewAction[] = [];
  for (const raw of values.slice(1)) {
    if (typeof raw !== 'string') continue;
    try {
      superseded.push(JSON.parse(raw) as PendingPrReviewAction);
    } catch {
      // Malformed record; skip.
    }
  }
  return {
    newestMessageId:
      typeof values[0] === 'string' && values[0]
        ? values[0]
        : newestCanonicalMessageId,
    superseded,
  };
}

async function retireLegacyPrReviewActionsForContext(
  context: PendingPrReviewAction,
): Promise<PendingPrReviewAction[]> {
  const redis = getRedis();
  const rawRetired = await redis.eval(
    RETIRE_LEGACY_PR_REVIEW_ACTIONS_FOR_CONTEXT_LUA,
    1,
    getPrReviewActionThreadKey(context),
    PR_REVIEW_ACTION_PREFIX,
    JSON.stringify(context),
  );
  const retired: PendingPrReviewAction[] = [];
  for (const raw of Array.isArray(rawRetired) ? rawRetired : []) {
    if (typeof raw !== 'string') continue;
    try {
      retired.push(JSON.parse(raw) as PendingPrReviewAction);
    } catch {
      // Malformed record; skip.
    }
  }
  return retired;
}

/**
 * The subset of a pending action needed to strip controls from its posted
 * message. Retirement must not depend on task linkage: the originating task
 * can be deleted (which nulls the delivery's task id) while the message and
 * its buttons remain live.
 */
export type RetirablePrReviewActionMessage = Pick<
  PendingPrReviewAction,
  'provider' | 'slackTeamId' | 'channelId' | 'threadId' | 'messageId'
>;

/** Removes controls from superseded review offers without failing delivery. */
export async function retirePrReviewActionMessagesBestEffort(
  pendingActions: RetirablePrReviewActionMessage[],
): Promise<void> {
  for (const pending of pendingActions) {
    if (!pending.messageId) continue;

    try {
      if (pending.provider === 'slack') {
        if (!pending.threadId) continue;
        const installation = await db.query.slackInstallations.findFirst({
          where: pending.slackTeamId
            ? and(
                eq(slackInstallations.teamId, pending.slackTeamId),
                eq(slackInstallations.isActive, true),
              )
            : eq(slackInstallations.isActive, true),
          columns: { botAccessToken: true },
        });
        if (!installation?.botAccessToken) continue;

        const slack = new SlackNotifier(installation.botAccessToken);
        const blocks = await slack.getMessageBlocks({
          channel: pending.channelId,
          messageTs: pending.messageId,
          threadTs: pending.threadId,
        });
        await slack.updateMessage({
          channel: pending.channelId,
          ts: pending.messageId,
          message: {
            blocks: buildResolvedSlackPrReviewMessageBlocks(blocks),
          },
        });
        continue;
      }

      const adapter = await getCommunicationProviderAdapter(pending.provider);
      if (!adapter) continue;

      if (pending.provider === 'discord' && adapter.provider === 'discord') {
        const channelId = pending.threadId ?? pending.channelId;
        const message = await adapter.getMessage({
          channelId,
          messageId: pending.messageId,
        });
        if (message) {
          await adapter.editMessage({
            channelId,
            messageId: pending.messageId,
            text: message.text,
          });
        }
      } else if (
        pending.provider === 'telegram' &&
        adapter.provider === 'telegram'
      ) {
        await adapter.editMessageReplyMarkup({
          channelId: pending.channelId,
          messageId: pending.messageId,
        });
      }
    } catch (error) {
      console.warn(
        `[PrReviewAction] Failed to retire superseded ${pending.provider} message ${pending.messageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

export async function retirePendingPrReviewActionsForPullRequest(input: {
  sourceControlProvider: SourceControlProvider;
  repository: string;
  prNumber: number;
  currentHeadSha: string;
}): Promise<void> {
  // Only offers that posted controls carry a follow-up prompt; text-only
  // messages have nothing to retire.
  const pending = (
    await retireCanonicalPrReviewActionsForPullRequest(input)
  ).flatMap((action) =>
    action?.provider &&
    action.provider !== 'teams' &&
    action.channelId &&
    action.followUpPrompt
      ? [
          {
            provider: action.provider,
            ...(action.provider === 'slack' && action.slackTeamId
              ? { slackTeamId: action.slackTeamId }
              : {}),
            channelId: action.channelId,
            threadId: action.threadId,
            messageId: action.messageId,
          } satisfies RetirablePrReviewActionMessage,
        ]
      : [],
  );

  await retirePrReviewActionMessagesBestEffort(pending);
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
