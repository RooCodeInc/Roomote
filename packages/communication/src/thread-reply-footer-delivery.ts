import crypto from 'node:crypto';

import { getRedis } from '@roomote/redis';

import {
  getThreadReplyFooterRecord,
  setThreadReplyFooterRecord,
  type ThreadReplyFooterRecord,
} from './thread-reply-footer-state';
import type { CommunicationProvider } from '@roomote/types';
import {
  forgetThreadFooterRefresh,
  resolveCurrentThreadFooterText,
} from './thread-footer-refresh';
import { chunkTelegramMarkdownAsHtml } from './telegram-format';

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
  fn: (assertLock: () => Promise<void>) => Promise<T>;
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
      let lost = false;
      const assertLock = async () => {
        if (lost || (await redis.get(params.lockKey)) !== ownerId) {
          lost = true;
          throw new Error('Thread reply footer lock lease lost');
        }
      };
      // Provider retries can outlive the initial lease. Renew only our own lock.
      let renewal = Promise.resolve();
      const timer = setInterval(
        () => {
          renewal = renewal
            .then(async () => {
              const renewed = await redis.eval(
                "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('expire',KEYS[1],ARGV[2]) else return 0 end",
                1,
                params.lockKey,
                ownerId,
                THREAD_REPLY_FOOTER_LOCK_TTL_SECONDS,
              );
              if (!renewed) lost = true;
            })
            .catch(() => {
              lost = true;
            });
        },
        (THREAD_REPLY_FOOTER_LOCK_TTL_SECONDS * 1000) / 3,
      );
      timer.unref();
      try {
        return await params.fn(assertLock);
      } finally {
        clearInterval(timer);
        await renewal;
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
  refresh?: ThreadReplyFooterRecord['refresh'];
  buttons?: ThreadReplyFooterRecord['buttons'];
};

/**
 * Post a reply that becomes the thread's footer-bearing message: read the
 * previous footer record, post the new reply (with footer attached by the
 * caller), persist the new pointer, then clear the previous message's footer.
 * Managed-provider counterpart of the Slack sticky footer ops.
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
    fn: async (assertLock) => {
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

      await assertLock();
      const posted = await params.postReplyWithFooter();

      try {
        await assertLock();
        await setThreadReplyFooterRecord(
          params.provider,
          params.channelId,
          params.footerStateThreadId,
          {
            messageId: posted.messageId,
            textWithoutFooter: posted.textWithoutFooter,
            ...(posted.refresh ? { refresh: posted.refresh } : {}),
            ...(posted.buttons ? { buttons: posted.buttons } : {}),
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
        // Do not clear the old carrier while its pointer may still be current.
        // Otherwise a later refresh could put a footer back onto history.
        const current = await getThreadReplyFooterRecord(
          params.provider,
          params.channelId,
          params.footerStateThreadId,
        ).catch(() => undefined);
        if (current !== undefined && current?.messageId !== posted.messageId) {
          await params.clearPreviousFooter(posted).catch(() => {});
        }
        return posted;
      }

      if (
        previousFooterRecord &&
        previousFooterRecord.messageId !== posted.messageId
      ) {
        try {
          await assertLock();
          await params.clearPreviousFooter(previousFooterRecord);
        } catch (error) {
          console.error(
            `[${params.logContext}] Failed to clear prior ${params.providerLabel} footer message ${previousFooterRecord.messageId}`,
            error,
          );
        }
      }

      return posted;
    },
  });
}

export async function refreshManagedThreadReplyFooter(params: {
  provider: CommunicationProvider;
  channelId: string;
  threadId: string;
  edit: (record: ThreadReplyFooterRecord, text: string) => Promise<void>;
}): Promise<void> {
  await withThreadReplyFooterLock({
    lockKey: `${params.provider}:thread_reply_footer_lock:${params.channelId}:${params.threadId}`,
    maxAcquireAttempts: 1,
    fn: async (assertLock) => {
      const record = await getThreadReplyFooterRecord(
        params.provider,
        params.channelId,
        params.threadId,
      );
      if (!record?.refresh) {
        await assertLock();
        await forgetThreadFooterRefresh({
          provider: params.provider,
          channelId: params.channelId,
          threadId: params.threadId,
        });
        return;
      }
      const footerText = await resolveCurrentThreadFooterText(
        params.provider,
        record.refresh.footerText,
      );
      if (!footerText || footerText === record.refresh.footerText) return;
      const text = [record.textWithoutFooter, footerText]
        .filter(Boolean)
        .join('\n\n');
      // A refresh cannot split a message or post a replacement carrier.
      if (params.provider === 'discord' && text.length > 2000) return;
      if (
        params.provider === 'telegram' &&
        chunkTelegramMarkdownAsHtml(text).length > 1
      )
        return;
      await assertLock();
      try {
        await params.edit(record, text);
      } catch (error) {
        const status =
          error && typeof error === 'object' && 'status' in error
            ? error.status
            : null;
        const message = error instanceof Error ? error.message : '';
        const missing =
          status === 404 ||
          status === 410 ||
          (params.provider === 'telegram' &&
            /message to edit not found/i.test(message)) ||
          (params.provider === 'teams' &&
            /^Teams updateActivity failed with (404|410):/.test(message));
        if (!missing) throw error;
        await assertLock();
        await forgetThreadFooterRefresh({
          provider: params.provider,
          channelId: params.channelId,
          threadId: params.threadId,
        });
        return;
      }
      await assertLock();
      await setThreadReplyFooterRecord(
        params.provider,
        params.channelId,
        params.threadId,
        { ...record, refresh: { ...record.refresh, footerText } },
        { keepTtl: true },
      );
    },
  });
}

/** An edit may finish after a competing delivery acquired the lease. */
export async function rememberThreadReplyFooterAfterEdit(params: {
  provider: CommunicationProvider;
  channelId: string;
  threadId: string;
  record: ThreadReplyFooterRecord;
  assertLock: () => Promise<void>;
  clearOwnFooter: () => Promise<void>;
}): Promise<void> {
  try {
    await params.assertLock();
  } catch {
    const current = await getThreadReplyFooterRecord(
      params.provider,
      params.channelId,
      params.threadId,
    ).catch(() => undefined);
    if (current !== undefined && current?.messageId !== params.record.messageId)
      await params.clearOwnFooter().catch(() => {});
    return;
  }
  await setThreadReplyFooterRecord(
    params.provider,
    params.channelId,
    params.threadId,
    params.record,
  );
}
