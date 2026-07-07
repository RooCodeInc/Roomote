import { getRedis } from '@roomote/redis';
import type { CommunicationProvider } from '@roomote/types';

const THREAD_REPLY_FOOTER_TTL_SECONDS = 30 * 24 * 60 * 60;

export type ThreadReplyFooterRecord = {
  /** Provider message id of the latest footer-bearing reply in the thread. */
  messageId: string;
  /**
   * The reply text without the footer, used to rewrite the previous message
   * when the footer is relocated to a newer reply.
   */
  textWithoutFooter: string;
};

function getThreadReplyFooterKey(
  provider: CommunicationProvider,
  channelId: string,
  threadId: string,
): string {
  return `${provider}:thread_reply_footer:${channelId}:${threadId}`;
}

export async function getThreadReplyFooterRecord(
  provider: CommunicationProvider,
  channelId: string,
  threadId: string,
): Promise<ThreadReplyFooterRecord | null> {
  const redis = getRedis();
  const rawRecord = await redis.get(
    getThreadReplyFooterKey(provider, channelId, threadId),
  );

  if (!rawRecord) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawRecord) as Partial<ThreadReplyFooterRecord>;

    if (
      typeof parsed.messageId === 'string' &&
      parsed.messageId.length > 0 &&
      typeof parsed.textWithoutFooter === 'string'
    ) {
      return {
        messageId: parsed.messageId,
        textWithoutFooter: parsed.textWithoutFooter,
      };
    }

    return null;
  } catch {
    return null;
  }
}

export async function setThreadReplyFooterRecord(
  provider: CommunicationProvider,
  channelId: string,
  threadId: string,
  record: ThreadReplyFooterRecord,
): Promise<void> {
  const redis = getRedis();
  await redis.set(
    getThreadReplyFooterKey(provider, channelId, threadId),
    JSON.stringify(record),
    'EX',
    THREAD_REPLY_FOOTER_TTL_SECONDS,
  );
}
