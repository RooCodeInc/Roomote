import crypto from 'node:crypto';

import { getRedis } from '@roomote/redis';

import {
  getThreadReplyFooterRecord,
  setThreadReplyFooterRecord,
  type ThreadReplyFooterRecord,
} from './thread-reply-footer-state';
import type { CommunicationProvider } from '@roomote/types';

const THREAD_REPLY_FOOTER_LOCK_TTL_SECONDS = 30;
const THREAD_REPLY_FOOTER_LOCK_MAX_ATTEMPTS = 8;
const THREAD_REPLY_FOOTER_LOCK_RETRY_MS = 100;
const RELEASE_LOCK_SCRIPT =
  "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";

export const THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE =
  'Timed out acquiring thread reply footer lock';

export async function withThreadReplyFooterLock<T>(params: {
  lockKey: string;
  maxAcquireAttempts?: number;
  fn: () => Promise<T>;
}): Promise<T> {
  const redis = getRedis();
  const maxAcquireAttempts =
    params.maxAcquireAttempts ?? THREAD_REPLY_FOOTER_LOCK_MAX_ATTEMPTS;

  for (let attempt = 0; attempt < maxAcquireAttempts; attempt += 1) {
    const ownerId = crypto.randomUUID();
    const acquired = await redis.set(
      params.lockKey,
      ownerId,
      'EX',
      THREAD_REPLY_FOOTER_LOCK_TTL_SECONDS,
      'NX',
    );

    if (acquired) {
      try {
        return await params.fn();
      } finally {
        await redis
          .eval(RELEASE_LOCK_SCRIPT, 1, params.lockKey, ownerId)
          .catch(() => {});
      }
    }

    await new Promise((resolve) =>
      setTimeout(resolve, THREAD_REPLY_FOOTER_LOCK_RETRY_MS),
    );
  }

  throw new Error(THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE);
}

type PostedFooterRecord<T extends { messageId: string }> = T & {
  textWithoutFooter: string;
  images?: ThreadReplyFooterRecord['images'];
};

/**
 * Post a reply that becomes the thread's footer-bearing message: read the
 * previous footer record, post the new reply (with footer attached by the
 * caller), rewrite the previous message without its footer, and persist the
 * new record. Managed-provider counterpart of the Slack sticky footer ops.
 *
 * apps/api's MCP thread replies keep their own copy of this flow
 * (handlers/mcp/communication-thread-reply-shared.ts) because its tests mock
 * this package's barrel; keep behavior changes in sync.
 */
export async function deliverManagedThreadReplyFooter<
  TReply extends { messageId: string },
>(params: {
  provider: CommunicationProvider;
  providerLabel: string;
  channelId: string;
  footerStateThreadId: string;
  lockKey: string;
  /** Identifies the subject in failure logs (e.g. "task run 42"). */
  logRef: string;
  logContext: string;
  postReplyWithFooter: () => Promise<PostedFooterRecord<TReply>>;
  clearPreviousFooter: (
    previousFooterRecord: ThreadReplyFooterRecord,
  ) => Promise<void>;
}): Promise<TReply> {
  return withThreadReplyFooterLock({
    lockKey: params.lockKey,
    fn: async () => {
      let previousFooterRecord: ThreadReplyFooterRecord | null = null;
      try {
        previousFooterRecord = await getThreadReplyFooterRecord(
          params.provider,
          params.channelId,
          params.footerStateThreadId,
        );
      } catch (error) {
        console.error(
          `[${params.logContext}] Failed to read previous ${params.providerLabel} footer record for ${params.logRef}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const posted = await params.postReplyWithFooter();

      if (
        previousFooterRecord &&
        previousFooterRecord.messageId !== posted.messageId
      ) {
        try {
          await params.clearPreviousFooter(previousFooterRecord);
        } catch (error) {
          console.error(
            `[${params.logContext}] Failed to clear prior ${params.providerLabel} footer message ${previousFooterRecord.messageId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      try {
        await setThreadReplyFooterRecord(
          params.provider,
          params.channelId,
          params.footerStateThreadId,
          {
            messageId: posted.messageId,
            textWithoutFooter: posted.textWithoutFooter,
            ...(posted.images && posted.images.length > 0
              ? { images: posted.images }
              : {}),
          },
        );
      } catch (error) {
        console.error(
          `[${params.logContext}] Failed to persist latest ${params.providerLabel} footer record ${posted.messageId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      return posted;
    },
  });
}
