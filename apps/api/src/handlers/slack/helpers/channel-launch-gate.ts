import {
  evaluateChannelLaunchCriteria,
  type ChannelLaunchGateActivityEntry,
} from '@roomote/cloud-agents/server';
import {
  acquireRedisLock,
  type Redis,
  type RedisLockHandle,
} from '@roomote/redis';

import { apiLogger } from '../../../logging.js';

const LAUNCH_RATE_LIMIT_PER_HOUR = 25;
const LAUNCH_RATE_WINDOW_SECONDS = 60 * 60;

const GATE_HISTORY_MAX_ENTRIES = 20;
const GATE_HISTORY_TTL_SECONDS = 48 * 60 * 60;
const GATE_HISTORY_SNIPPET_LENGTH = 280;

const GATE_LOCK_TTL_SECONDS = 30;
const GATE_LOCK_POLL_INTERVAL_MS = 500;
const GATE_LOCK_MAX_POLL_ATTEMPTS = 20;

const RATE_INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`.trim();

function buildLaunchRateKey(channelId: string) {
  return `slack:launch-gate:rate:${channelId}`;
}

function buildGateHistoryKey(channelId: string) {
  return `slack:launch-gate:history:${channelId}`;
}

function buildGateLockKey(channelId: string) {
  return `slack:launch-gate:lock:${channelId}`;
}

/**
 * Serialize gate evaluations per channel so concurrent top-level messages
 * cannot both read pre-launch history and double-launch on the same incident.
 * Waits up to ~10s for the lock; if it stays held (or Redis errors), the gate
 * proceeds unserialized rather than dropping the alert.
 */
async function acquireChannelGateLock(
  redis: Redis,
  channelId: string,
  logContext: string,
): Promise<RedisLockHandle | null> {
  try {
    for (let attempt = 0; attempt < GATE_LOCK_MAX_POLL_ATTEMPTS; attempt++) {
      const release = await acquireRedisLock(buildGateLockKey(channelId), {
        ttlSeconds: GATE_LOCK_TTL_SECONDS,
        redis,
      });

      if (release) {
        return release;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, GATE_LOCK_POLL_INTERVAL_MS),
      );
    }

    apiLogger.warn(
      `[SlackLaunchGate] Proceeding without the channel gate lock for ${logContext}: lock still held after ${GATE_LOCK_MAX_POLL_ATTEMPTS * GATE_LOCK_POLL_INTERVAL_MS}ms`,
    );
  } catch (error) {
    apiLogger.warn(
      `[SlackLaunchGate] Proceeding without the channel gate lock for ${logContext}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return null;
}

function collapseToSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

type GateHistoryEntry = {
  at: number;
  decision: 'launched' | 'skipped';
  message: string;
};

function formatEntryAge(nowMs: number, atMs: number): string {
  const minutes = Math.max(1, Math.round((nowMs - atMs) / 60_000));

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * Recent gate decisions give the classifier the context to skip repeat
 * updates about an incident it already launched on. Best effort: an empty
 * history only means the gate evaluates the message on its own.
 */
async function readRecentGateActivity(
  redis: Redis,
  channelId: string,
  logContext: string,
): Promise<ChannelLaunchGateActivityEntry[]> {
  try {
    const rawEntries = await redis.lrange(
      buildGateHistoryKey(channelId),
      0,
      GATE_HISTORY_MAX_ENTRIES - 1,
    );
    const nowMs = Date.now();

    return rawEntries.flatMap((rawEntry) => {
      try {
        const entry = JSON.parse(rawEntry) as GateHistoryEntry;

        if (typeof entry.at !== 'number' || typeof entry.message !== 'string') {
          return [];
        }

        return [
          {
            ageDescription: formatEntryAge(nowMs, entry.at),
            decision: entry.decision === 'launched' ? 'launched' : 'skipped',
            messageSnippet: collapseToSingleLine(entry.message).slice(
              0,
              GATE_HISTORY_SNIPPET_LENGTH,
            ),
          } satisfies ChannelLaunchGateActivityEntry,
        ];
      } catch {
        return [];
      }
    });
  } catch (error) {
    apiLogger.warn(
      `[SlackLaunchGate] Could not read gate history for ${logContext}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

async function recordGateDecision(params: {
  redis: Redis;
  channelId: string;
  decision: GateHistoryEntry['decision'];
  messageText: string;
  logContext: string;
}): Promise<void> {
  try {
    const key = buildGateHistoryKey(params.channelId);
    const entry: GateHistoryEntry = {
      at: Date.now(),
      decision: params.decision,
      // Single-line so the snippet cannot break the one-line-per-decision
      // prompt format or inject pseudo-structure into the classifier context.
      message: collapseToSingleLine(params.messageText).slice(
        0,
        GATE_HISTORY_SNIPPET_LENGTH,
      ),
    };

    await params.redis
      .multi()
      .lpush(key, JSON.stringify(entry))
      .ltrim(key, 0, GATE_HISTORY_MAX_ENTRIES - 1)
      .expire(key, GATE_HISTORY_TTL_SECONDS)
      .exec();
  } catch (error) {
    apiLogger.warn(
      `[SlackLaunchGate] Could not record gate decision for ${params.logContext}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

type ChannelLaunchGateResult =
  | {
      shouldLaunch: true;
      debug: {
        llmDecision: 'launch';
        reason: string;
      };
    }
  | {
      shouldLaunch: false;
      skipReason: 'rate_limited' | 'criteria_not_met' | 'classifier_error';
      debug: {
        llmDecision: 'launch' | 'skip' | 'not_run' | 'error';
        reason: string;
      };
    };

/**
 * Gate a configured-channel auto-start launch behind the channel's launch
 * criteria. Fails closed: any classifier or Redis error skips the launch
 * instead of letting an unvetted message consume a sandbox.
 */
export async function evaluateChannelLaunchGate(params: {
  redis: Redis;
  channelId: string;
  channelName?: string | null;
  messageText: string;
  botMentioned?: boolean;
  launchCriteria: string;
  isBotAuthored: boolean;
  logContext: string;
}): Promise<ChannelLaunchGateResult> {
  const {
    redis,
    channelId,
    channelName,
    messageText,
    botMentioned,
    launchCriteria,
    isBotAuthored,
    logContext,
  } = params;

  const releaseGateLock = await acquireChannelGateLock(
    redis,
    channelId,
    logContext,
  );

  try {
    return await evaluateChannelLaunchGateSerialized({
      redis,
      channelId,
      channelName,
      messageText,
      botMentioned,
      launchCriteria,
      isBotAuthored,
      logContext,
    });
  } finally {
    await releaseGateLock?.();
  }
}

async function evaluateChannelLaunchGateSerialized(params: {
  redis: Redis;
  channelId: string;
  channelName?: string | null;
  messageText: string;
  botMentioned?: boolean;
  launchCriteria: string;
  isBotAuthored: boolean;
  logContext: string;
}): Promise<ChannelLaunchGateResult> {
  const {
    redis,
    channelId,
    channelName,
    messageText,
    botMentioned,
    launchCriteria,
    isBotAuthored,
    logContext,
  } = params;

  try {
    const launchesThisWindow = await redis.get(buildLaunchRateKey(channelId));

    if (Number(launchesThisWindow ?? 0) >= LAUNCH_RATE_LIMIT_PER_HOUR) {
      apiLogger.warn(
        `[SlackLaunchGate] Skipping launch for ${logContext}: channel hit the ${LAUNCH_RATE_LIMIT_PER_HOUR}/hour gated-launch cap`,
      );
      return {
        shouldLaunch: false,
        skipReason: 'rate_limited',
        debug: {
          llmDecision: 'not_run',
          reason: `Channel hit the ${LAUNCH_RATE_LIMIT_PER_HOUR}/hour gated-launch cap before the LLM decision ran.`,
        },
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    apiLogger.warn(
      `[SlackLaunchGate] Skipping launch for ${logContext}: rate-cap check failed: ${message}`,
    );
    return {
      shouldLaunch: false,
      skipReason: 'classifier_error',
      debug: {
        llmDecision: 'not_run',
        reason: `Launch-gate rate-cap check failed before the LLM decision ran: ${message}`,
      },
    };
  }

  const recentGateActivity = await readRecentGateActivity(
    redis,
    channelId,
    logContext,
  );

  const decision = await evaluateChannelLaunchCriteria({
    messageText,
    launchCriteria,
    channelName,
    authorDescription: isBotAuthored
      ? 'an automated app or bot (for example a deploy-notification feed)'
      : 'a human channel member',
    botMentioned,
    recentGateActivity,
    tracking: {},
  });

  if (decision.status === 'error') {
    apiLogger.warn(
      `[SlackLaunchGate] Skipping launch for ${logContext}: classifier failed: ${decision.message}`,
    );
    return {
      shouldLaunch: false,
      skipReason: 'classifier_error',
      debug: {
        llmDecision: 'error',
        reason: `The LLM launch decision failed: ${decision.message}`,
      },
    };
  }

  if (decision.status === 'skip') {
    apiLogger.info(
      `[SlackLaunchGate] Skipping launch for ${logContext}: criteria not met (${decision.reason})`,
    );
    await recordGateDecision({
      redis,
      channelId,
      decision: 'skipped',
      messageText,
      logContext,
    });
    return {
      shouldLaunch: false,
      skipReason: 'criteria_not_met',
      debug: {
        llmDecision: 'skip',
        reason: decision.reason,
      },
    };
  }

  try {
    // INCR and EXPIRE run in one Lua script. MULTI/EXEC is not enough here:
    // a runtime error mid-transaction still commits the earlier commands, so
    // INCR could land without its EXPIRE and the counter would grow forever
    // and permanently rate-limit the channel. A write script is rejected
    // up front (not mid-script) and nothing can interleave, so the counter
    // either gets its TTL or is not incremented at all.
    await redis.eval(
      RATE_INCREMENT_SCRIPT,
      1,
      buildLaunchRateKey(channelId),
      LAUNCH_RATE_WINDOW_SECONDS,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    apiLogger.warn(
      `[SlackLaunchGate] Skipping launch for ${logContext}: rate bookkeeping failed: ${message}`,
    );
    return {
      shouldLaunch: false,
      skipReason: 'classifier_error',
      debug: {
        llmDecision: 'launch',
        reason: `${decision.reason} Rate bookkeeping then failed: ${message}`,
      },
    };
  }

  apiLogger.info(
    `[SlackLaunchGate] Launching for ${logContext}: criteria met (${decision.reason})`,
  );
  await recordGateDecision({
    redis,
    channelId,
    decision: 'launched',
    messageText,
    logContext,
  });

  return {
    shouldLaunch: true,
    debug: {
      llmDecision: 'launch',
      reason: decision.reason,
    },
  };
}
