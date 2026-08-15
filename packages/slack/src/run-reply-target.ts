import { getRedis } from '@roomote/redis';

const SLACK_RUN_REPLY_TARGET_TTL_SECONDS = 7 * 24 * 60 * 60;
const PENDING_KEY_PREFIX = 'slack:run_reply_target:pending:';
const ACTIVE_KEY_PREFIX = 'slack:run_reply_target:active:';

export type SlackRunReplyTarget = {
  slackTeamId: string;
  channel: string;
  threadTs: string;
  reactionsAllowed?: boolean;
};

function pendingKey(runId: number, messageTs: string) {
  return `${PENDING_KEY_PREFIX}${runId}:${messageTs}`;
}

function activeKey(runId: number) {
  return `${ACTIVE_KEY_PREFIX}${runId}`;
}

function parseTarget(value: string | null): SlackRunReplyTarget | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as Partial<SlackRunReplyTarget>;
    if (
      typeof parsed.slackTeamId === 'string' &&
      parsed.slackTeamId.length > 0 &&
      typeof parsed.channel === 'string' &&
      parsed.channel.length > 0 &&
      typeof parsed.threadTs === 'string' &&
      parsed.threadTs.length > 0
    ) {
      return {
        slackTeamId: parsed.slackTeamId,
        channel: parsed.channel,
        threadTs: parsed.threadTs,
        ...(typeof parsed.reactionsAllowed === 'boolean'
          ? { reactionsAllowed: parsed.reactionsAllowed }
          : {}),
      };
    }
  } catch {
    return null;
  }

  return null;
}

export async function authorizeSlackRunReplyTarget(params: {
  runId: number;
  messageTs: string;
  target: SlackRunReplyTarget;
}): Promise<void> {
  await getRedis().set(
    pendingKey(params.runId, params.messageTs),
    JSON.stringify(params.target),
    'EX',
    SLACK_RUN_REPLY_TARGET_TTL_SECONDS,
  );
}

export async function activateSlackRunReplyTarget(params: {
  runId: number;
  messageTs: string;
}): Promise<SlackRunReplyTarget | false> {
  const redis = getRedis();
  const target = parseTarget(
    await redis.get(pendingKey(params.runId, params.messageTs)),
  );
  if (!target) {
    await redis.del(activeKey(params.runId));
    return false;
  }

  await redis.set(
    activeKey(params.runId),
    JSON.stringify(target),
    'EX',
    SLACK_RUN_REPLY_TARGET_TTL_SECONDS,
  );
  return target;
}

export async function getActiveSlackRunReplyTarget(
  runId: number,
): Promise<SlackRunReplyTarget | null> {
  return parseTarget(await getRedis().get(activeKey(runId)));
}

export async function clearActiveSlackRunReplyTarget(
  runId: number,
): Promise<void> {
  await getRedis().del(activeKey(runId));
}
