import crypto from 'node:crypto';

import { getRedis } from '@roomote/redis';

import {
  getThreadReplyFooterRecord,
  setThreadReplyFooterRecord,
  type ThreadReplyFooterRecord,
  type ThreadReplyFooterLock,
} from './thread-reply-footer-state';
import type { CommunicationProvider } from '@roomote/types';
import {
  forgetThreadFooterRefresh,
  resolveCurrentThreadFooter,
  type ThreadFooterRefreshOutcome,
  type ThreadFooterRefreshTarget,
} from './thread-footer-refresh';
import { chunkTelegramMarkdownAsHtml } from './telegram-format';

const THREAD_REPLY_FOOTER_LOCK_TTL_SECONDS = 30;
/**
 * A delivery waits out a concurrent delivery or a refresh's provider edit
 * (which can sit in a rate-limit backoff for a few seconds) rather than
 * failing the reply. Refreshes themselves never wait: they try once.
 */
const THREAD_REPLY_FOOTER_LOCK_MAX_ATTEMPTS = 40;
const THREAD_REPLY_FOOTER_LOCK_RETRY_MS = 100;
const RELEASE_LOCK_SCRIPT =
  "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";

export const THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE =
  'Timed out acquiring thread reply footer lock';

export async function withThreadReplyFooterLock<T>(params: {
  lockKey: string;
  maxAcquireAttempts?: number;
  fn: (
    assertLock: () => Promise<void>,
    lock: ThreadReplyFooterLock,
  ) => Promise<T>;
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
        return await params.fn(assertLock, { key: params.lockKey, ownerId });
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

/**
 * Run `fn` under the destination lock only if it is free right now. Background
 * work (a scheduled refresh) must never delay a reply, so it yields instead of
 * waiting and reports `acquired: false`.
 */
export async function tryThreadReplyFooterLock<T>(params: {
  lockKey: string;
  fn: (
    assertLock: () => Promise<void>,
    lock: ThreadReplyFooterLock,
  ) => Promise<T>;
}): Promise<{ acquired: true; value: T } | { acquired: false }> {
  try {
    const value = await withThreadReplyFooterLock({
      lockKey: params.lockKey,
      maxAcquireAttempts: 1,
      fn: params.fn,
    });
    return { acquired: true, value };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE
    )
      return { acquired: false };
    throw error;
  }
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
    fn: async (assertLock, lock) => {
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
        const written = await setThreadReplyFooterRecord(
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
          { lock },
        );
        if (!written) throw new Error('Thread reply footer lock lease lost');
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

function managedFooterLockKey(target: ThreadFooterRefreshTarget): string {
  return `${target.provider}:thread_reply_footer_lock:${target.channelId}:${target.threadId}`;
}

/**
 * Unregister a destination, but only if its record still matches what this
 * refresh pass read: a delivery that raced in owns the registration now.
 */
async function forgetManagedFooterIfUnchanged(
  target: ThreadFooterRefreshTarget & { provider: CommunicationProvider },
  seen: ThreadReplyFooterRecord | null,
): Promise<ThreadFooterRefreshOutcome> {
  const result = await tryThreadReplyFooterLock({
    lockKey: managedFooterLockKey(target),
    fn: async (assertLock): Promise<ThreadFooterRefreshOutcome> => {
      const current = await getThreadReplyFooterRecord(
        target.provider,
        target.channelId,
        target.threadId,
      );
      const unchanged =
        current?.messageId === seen?.messageId &&
        current?.refresh?.footerText === seen?.refresh?.footerText;
      if (!unchanged) return 'active';
      await assertLock();
      await forgetThreadFooterRefresh(target);
      return 'gone';
    },
  });
  return result.acquired ? result.value : 'active';
}

/**
 * Bring the current carrier's footer up to date. All resolution happens
 * outside the destination lock; the lock is held only for the provider edit
 * and the pointer write, so a concurrent reply is never starved by DB work.
 */
export async function refreshManagedThreadReplyFooter(params: {
  provider: CommunicationProvider;
  channelId: string;
  threadId: string;
  edit: (record: ThreadReplyFooterRecord, text: string) => Promise<void>;
}): Promise<ThreadFooterRefreshOutcome> {
  const target = {
    provider: params.provider,
    channelId: params.channelId,
    threadId: params.threadId,
  };
  const record = await getThreadReplyFooterRecord(
    params.provider,
    params.channelId,
    params.threadId,
  );
  if (!record?.refresh) return forgetManagedFooterIfUnchanged(target, record);
  const refresh = record.refresh;
  const current = await resolveCurrentThreadFooter(
    params.provider,
    refresh.footerText,
  );
  if (!current) {
    // The footer no longer names a Session or task on this deployment (for
    // example the app URL changed). Polling cannot fix that; a new reply
    // registers a fresh footer.
    console.warn('[threadFooter] Retiring a footer that no longer resolves', {
      provider: params.provider,
      channelId: params.channelId,
      threadId: params.threadId,
    });
    return forgetManagedFooterIfUnchanged(target, record);
  }
  const outcome: ThreadFooterRefreshOutcome = current.active
    ? 'active'
    : 'idle';
  if (current.text === refresh.footerText) {
    return current.settled
      ? forgetManagedFooterIfUnchanged(target, record)
      : outcome;
  }
  const text = [record.textWithoutFooter, current.text]
    .filter(Boolean)
    .join('\n\n');
  // A refresh cannot split a message or post a replacement carrier, and the
  // body never shrinks, so this carrier will not fit on later passes either.
  if (
    (params.provider === 'discord' && text.length > 2000) ||
    (params.provider === 'telegram' &&
      chunkTelegramMarkdownAsHtml(text).length > 1)
  ) {
    console.warn('[threadFooter] Retiring a footer whose carrier is full', {
      provider: params.provider,
      channelId: params.channelId,
      threadId: params.threadId,
    });
    return forgetManagedFooterIfUnchanged(target, record);
  }
  const result = await tryThreadReplyFooterLock({
    lockKey: managedFooterLockKey(target),
    fn: async (assertLock, lock): Promise<ThreadFooterRefreshOutcome> => {
      const latest = await getThreadReplyFooterRecord(
        params.provider,
        params.channelId,
        params.threadId,
      );
      // A reply relocated the footer while this pass was resolving; the next
      // pass reads the new carrier.
      if (
        !latest?.refresh ||
        latest.messageId !== record.messageId ||
        latest.refresh.footerText !== refresh.footerText
      )
        return 'active';
      await assertLock();
      try {
        await params.edit(latest, text);
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
        await forgetThreadFooterRefresh(target);
        return 'gone';
      }
      await rememberThreadReplyFooterAfterEdit({
        ...target,
        record: {
          ...latest,
          refresh: { ...latest.refresh, footerText: current.text },
        },
        assertLock,
        lock,
        clearOwnFooter: () => params.edit(latest, latest.textWithoutFooter),
        keepTtl: true,
      });
      if (current.settled) {
        await assertLock();
        await forgetThreadFooterRefresh(target);
        return 'gone';
      }
      return outcome;
    },
  });
  // A delivery holds the lock: it re-registers the destination itself.
  return result.acquired ? result.value : 'active';
}

/** An edit may finish after a competing delivery acquired the lease. */
export async function rememberThreadReplyFooterAfterEdit(params: {
  provider: CommunicationProvider;
  channelId: string;
  threadId: string;
  record: ThreadReplyFooterRecord;
  assertLock: () => Promise<void>;
  lock: ThreadReplyFooterLock;
  clearOwnFooter: () => Promise<void>;
  keepTtl?: boolean;
}): Promise<void> {
  let ownsLock = true;
  try {
    await params.assertLock();
  } catch {
    ownsLock = false;
  }
  if (
    ownsLock &&
    (await setThreadReplyFooterRecord(
      params.provider,
      params.channelId,
      params.threadId,
      params.record,
      { keepTtl: params.keepTtl, lock: params.lock },
    ))
  )
    return;
  const current = await getThreadReplyFooterRecord(
    params.provider,
    params.channelId,
    params.threadId,
  ).catch(() => undefined);
  if (current !== undefined && current?.messageId !== params.record.messageId)
    await params.clearOwnFooter().catch(() => {});
}
