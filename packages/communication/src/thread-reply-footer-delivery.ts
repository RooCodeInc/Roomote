import {
  getThreadReplyFooterRecord,
  setThreadReplyFooterRecord,
  type ThreadReplyFooterRecord,
  type ThreadReplyFooterLock,
} from './thread-reply-footer-state';
export {
  THREAD_REPLY_FOOTER_LOCK_TIMEOUT_MESSAGE,
  tryThreadReplyFooterLock,
  withThreadReplyFooterLock,
} from './thread-reply-footer-lock';
import {
  refreshThreadFooterCarrier,
  relocateThreadFooterCarrier,
} from './thread-footer-carrier-lifecycle';
import type { CommunicationProvider } from '@roomote/types';
import {
  forgetThreadFooterRefresh,
  resolveCurrentThreadFooter,
  type ThreadFooterRefreshOutcome,
  type ThreadFooterRefreshTarget,
} from './thread-footer-refresh';
import { planTelegramRichMessages } from './telegram-format';

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
 * Managed-provider adapter for the shared carrier lifecycle.
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
  const result = await relocateThreadFooterCarrier({
    lockKey: params.lockKey,
    read: () =>
      getThreadReplyFooterRecord(
        params.provider,
        params.channelId,
        params.footerStateThreadId,
      ),
    sameVersion: (current, seen) => current?.messageId === seen?.messageId,
    publish: async () => {
      const posted = await params.postReplyWithFooter();
      return { carrier: posted, result: posted };
    },
    remember: (posted, lock) =>
      setThreadReplyFooterRecord(
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
      ),
    clearFooter: params.clearPreviousFooter,
    onReadError: (error) => {
      console.error(
        `[${params.logContext}] Failed to read previous ${params.providerLabel} footer record for ${params.logRef}: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
    onRememberError: (posted, error) => {
      console.error(
        `[${params.logContext}] Failed to persist latest ${params.providerLabel} footer record ${posted.messageId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
    onClearError: (previous, error) => {
      console.error(
        `[${params.logContext}] Failed to clear prior ${params.providerLabel} footer message ${previous.messageId}`,
        error,
      );
    },
  });
  return result!;
}

function managedFooterLockKey(target: ThreadFooterRefreshTarget): string {
  return `${target.provider}:thread_reply_footer_lock:${target.channelId}:${target.threadId}`;
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
  const read = () =>
    getThreadReplyFooterRecord(
      params.provider,
      params.channelId,
      params.threadId,
    );
  return refreshThreadFooterCarrier({
    lockKey: managedFooterLockKey(target),
    read,
    sameVersion: (current, seen) =>
      current?.messageId === seen?.messageId &&
      current?.textWithoutFooter === seen?.textWithoutFooter &&
      current?.refresh?.footerText === seen?.refresh?.footerText,
    forget: () => forgetThreadFooterRefresh(target),
    resolve: async (record) => {
      if (!record.refresh) return null;
      const current = await resolveCurrentThreadFooter(
        params.provider,
        record.refresh.footerText,
      );
      if (!current) {
        console.warn(
          '[threadFooter] Retiring a footer that no longer resolves',
          target,
        );
        return null;
      }
      const outcome = current.active ? 'active' : 'idle';
      const text = [record.textWithoutFooter, current.text]
        .filter(Boolean)
        .join('\n\n');
      if (
        (params.provider === 'discord' && text.length > 2000) ||
        (params.provider === 'telegram' &&
          planTelegramRichMessages({
            text: record.textWithoutFooter,
            footerText: current.text,
            textFormat: 'markdown',
          }).length > 1)
      ) {
        console.warn('[threadFooter] Retiring a footer whose carrier is full', {
          ...target,
        });
        return null;
      }
      return {
        outcome,
        settled: current.settled,
        changed: current.text !== record.refresh.footerText,
        edit: (latest) =>
          params.edit(
            latest,
            [latest.textWithoutFooter, current.text]
              .filter(Boolean)
              .join('\n\n'),
          ),
        remember: (latest, lock) =>
          setThreadReplyFooterRecord(
            params.provider,
            params.channelId,
            params.threadId,
            {
              ...latest,
              refresh: { ...latest.refresh!, footerText: current.text },
            },
            { keepTtl: true, lock },
          ),
        recoverAfterLostLease: async (latest) => {
          const carrier = await read().catch(() => undefined);
          if (
            carrier !== undefined &&
            carrier?.messageId !== latest.messageId
          ) {
            await params.edit(latest, latest.textWithoutFooter).catch(() => {});
          }
        },
      };
    },
    isGoneError: (error) => {
      const status =
        error && typeof error === 'object' && 'status' in error
          ? error.status
          : null;
      const message = error instanceof Error ? error.message : '';
      return (
        status === 404 ||
        status === 410 ||
        (params.provider === 'telegram' &&
          /message to edit not found/i.test(message)) ||
        (params.provider === 'teams' &&
          /^Teams updateActivity failed with (404|410):/.test(message))
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
