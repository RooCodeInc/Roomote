import {
  tryThreadReplyFooterLock,
  withThreadReplyFooterLock,
} from './thread-reply-footer-lock';
import type { ThreadReplyFooterLock } from './thread-reply-footer-state';
import type { ThreadFooterRefreshOutcome } from './thread-footer-refresh';

type Carrier = { messageId: string };

export type ThreadFooterCarrierRefresh<TCarrier extends Carrier> = {
  outcome: Exclude<ThreadFooterRefreshOutcome, 'gone'>;
  settled: boolean;
  changed: boolean;
  edit: (carrier: TCarrier) => Promise<boolean | void>;
  remember?: (
    carrier: TCarrier,
    lock: ThreadReplyFooterLock,
  ) => Promise<boolean>;
  recoverAfterLostLease?: (
    carrier: TCarrier,
    assertLock: () => Promise<void>,
  ) => Promise<void>;
};

type ThreadFooterCarrierIdentity<TCarrier extends Carrier> = {
  lockKey: string;
  read: () => Promise<TCarrier | null>;
  sameVersion: (current: TCarrier | null, seen: TCarrier | null) => boolean;
};

type ThreadFooterCarrierAdapter<TCarrier extends Carrier> =
  ThreadFooterCarrierIdentity<TCarrier> & {
    forget: () => Promise<void>;
  };

export async function relocateThreadFooterCarrier<
  TCarrier extends Carrier,
  TResult,
>(
  params: ThreadFooterCarrierIdentity<TCarrier> & {
    publish: () => Promise<{ carrier: TCarrier; result: TResult } | null>;
    remember: (
      carrier: TCarrier,
      lock: ThreadReplyFooterLock,
    ) => Promise<boolean>;
    clearFooter: (carrier: TCarrier) => Promise<void>;
    afterRemember?: (
      carrier: TCarrier,
      assertLock: () => Promise<void>,
    ) => Promise<void>;
    onReadError?: (error: unknown) => void;
    onRememberError?: (carrier: TCarrier, error: unknown) => void;
    onAfterRememberError?: (carrier: TCarrier, error: unknown) => void;
    onClearError?: (carrier: TCarrier, error: unknown) => void;
  },
): Promise<TResult | null> {
  return withThreadReplyFooterLock({
    lockKey: params.lockKey,
    fn: async (assertLock, lock) => {
      let previous: TCarrier | null = null;
      try {
        previous = await params.read();
      } catch (error) {
        params.onReadError?.(error);
      }

      await assertLock();
      const published = await params.publish();
      if (!published) return null;

      try {
        await assertLock();
        if (!(await params.remember(published.carrier, lock))) {
          throw new Error('Thread reply footer lock lease lost');
        }
      } catch (error) {
        params.onRememberError?.(published.carrier, error);
        const current = await params.read().catch(() => undefined);
        if (
          current !== undefined &&
          !params.sameVersion(current, published.carrier)
        ) {
          await params.clearFooter(published.carrier).catch(() => {});
        }
        return published.result;
      }
      if (previous && !params.sameVersion(previous, published.carrier)) {
        try {
          await assertLock();
          await params.clearFooter(previous);
        } catch (error) {
          params.onClearError?.(previous, error);
        }
      }
      try {
        await params.afterRemember?.(published.carrier, assertLock);
      } catch (error) {
        params.onAfterRememberError?.(published.carrier, error);
      }
      return published.result;
    },
  });
}

export async function forgetThreadFooterCarrierIfUnchanged<
  TCarrier extends Carrier,
>(
  params: ThreadFooterCarrierAdapter<TCarrier>,
  seen: TCarrier | null,
): Promise<ThreadFooterRefreshOutcome> {
  const result = await tryThreadReplyFooterLock({
    lockKey: params.lockKey,
    fn: async (assertLock): Promise<ThreadFooterRefreshOutcome> => {
      if (!params.sameVersion(await params.read(), seen)) return 'active';
      await assertLock();
      await params.forget();
      return 'gone';
    },
  });
  return result.acquired ? result.value : 'active';
}

export async function refreshThreadFooterCarrier<TCarrier extends Carrier>(
  params: ThreadFooterCarrierAdapter<TCarrier> & {
    resolve: (
      carrier: TCarrier,
    ) => Promise<ThreadFooterCarrierRefresh<TCarrier> | null>;
    isGoneError: (error: unknown) => boolean;
  },
): Promise<ThreadFooterRefreshOutcome> {
  const seen = await params.read();
  if (!seen) return forgetThreadFooterCarrierIfUnchanged(params, null);

  const refresh = await params.resolve(seen);
  if (!refresh) return forgetThreadFooterCarrierIfUnchanged(params, seen);
  if (!refresh.changed) {
    return refresh.settled
      ? forgetThreadFooterCarrierIfUnchanged(params, seen)
      : refresh.outcome;
  }

  const result = await tryThreadReplyFooterLock({
    lockKey: params.lockKey,
    fn: async (assertLock, lock): Promise<ThreadFooterRefreshOutcome> => {
      const current = await params.read();
      if (!params.sameVersion(current, seen) || !current) return 'active';

      await assertLock();
      try {
        if ((await refresh.edit(current)) === false) return 'active';
      } catch (error) {
        if (!params.isGoneError(error)) throw error;
        await assertLock();
        await params.forget();
        return 'gone';
      }

      let remembered = true;
      if (refresh.remember) {
        remembered = await refresh.remember(current, lock);
      } else {
        try {
          await assertLock();
        } catch {
          remembered = false;
        }
      }
      if (!remembered) {
        await refresh.recoverAfterLostLease?.(current, assertLock);
        return 'active';
      }

      if (refresh.settled) {
        await assertLock();
        await params.forget();
        return 'gone';
      }
      return refresh.outcome;
    },
  });
  return result.acquired ? result.value : 'active';
}
