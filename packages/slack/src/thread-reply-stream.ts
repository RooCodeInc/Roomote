import crypto from 'node:crypto';

import { getRedis } from '@roomote/redis';

const SLACK_THREAD_REPLY_STREAM_PREFIX = 'slack:thread_reply_stream:';
const THREAD_REPLY_STREAM_TTL_SECONDS = 60 * 60;
const RELEASE_STREAM_SCRIPT =
  "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";

function getSlackThreadReplyStreamKey(
  channel: string,
  threadTs: string,
): string {
  return `${SLACK_THREAD_REPLY_STREAM_PREFIX}${channel}:${threadTs}`;
}

/** Must be started while holding the thread footer lock. */
export async function beginSlackThreadReplyStream(params: {
  channel: string;
  threadTs: string;
}): Promise<string | null> {
  const token = crypto.randomUUID();
  const started = await getRedis().set(
    getSlackThreadReplyStreamKey(params.channel, params.threadTs),
    token,
    'EX',
    THREAD_REPLY_STREAM_TTL_SECONDS,
    'NX',
  );
  return started ? token : null;
}

export async function isSlackThreadReplyStreamActive(params: {
  channel: string;
  threadTs: string;
}): Promise<boolean> {
  return (
    (await getRedis().get(
      getSlackThreadReplyStreamKey(params.channel, params.threadTs),
    )) !== null
  );
}

export async function endSlackThreadReplyStream(params: {
  channel: string;
  threadTs: string;
  token: string;
}): Promise<void> {
  try {
    await getRedis().eval(
      RELEASE_STREAM_SCRIPT,
      1,
      getSlackThreadReplyStreamKey(params.channel, params.threadTs),
      params.token,
    );
  } catch (error) {
    console.warn(
      `[slackThreadFooter] Failed to clear reply stream marker in thread ${params.threadTs}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
