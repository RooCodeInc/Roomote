import { describe, expect, it, vi } from 'vitest';

const lock = { key: 'lock', ownerId: 'owner' };

vi.mock('../thread-reply-footer-lock', () => ({
  withThreadReplyFooterLock: async ({
    fn,
  }: {
    fn: (
      assertLock: () => Promise<void>,
      heldLock: typeof lock,
    ) => Promise<unknown>;
  }) => fn(async () => {}, lock),
  tryThreadReplyFooterLock: async ({
    fn,
  }: {
    fn: (
      assertLock: () => Promise<void>,
      heldLock: typeof lock,
    ) => Promise<unknown>;
  }) => ({
    acquired: true,
    value: await fn(async () => {}, lock),
  }),
}));

import {
  refreshThreadFooterCarrier,
  relocateThreadFooterCarrier,
} from '../thread-footer-carrier-lifecycle';

describe('thread footer carrier lifecycle', () => {
  it('remembers a replacement before clearing the previous carrier', async () => {
    const events: string[] = [];
    let current = { messageId: 'old' };

    await relocateThreadFooterCarrier({
      lockKey: 'lock',
      read: async () => current,
      sameVersion: (left, right) => left?.messageId === right?.messageId,
      publish: async () => ({
        carrier: { messageId: 'new' },
        result: 'posted',
      }),
      remember: async (carrier) => {
        events.push(`remember:${carrier.messageId}`);
        current = carrier;
        return true;
      },
      clearFooter: async (carrier) => {
        events.push(`clear:${carrier.messageId}`);
      },
    });

    expect(events).toEqual(['remember:new', 'clear:old']);
  });

  it('clears only its own carrier when a fenced pointer write loses', async () => {
    const current = { messageId: 'competitor' };
    const clearFooter = vi.fn().mockResolvedValue(undefined);

    await relocateThreadFooterCarrier({
      lockKey: 'lock',
      read: async () => current,
      sameVersion: (left, right) => left?.messageId === right?.messageId,
      publish: async () => ({
        carrier: { messageId: 'orphan' },
        result: 'posted',
      }),
      remember: async () => false,
      clearFooter,
    });

    expect(clearFooter).toHaveBeenCalledExactlyOnceWith({
      messageId: 'orphan',
    });
  });

  it('rechecks the carrier before editing and leaves a replacement active', async () => {
    const seen = { messageId: 'old', footerText: 'idle' };
    let current = seen;
    const edit = vi.fn();
    const forget = vi.fn();

    const outcome = await refreshThreadFooterCarrier({
      lockKey: 'lock',
      read: async () => current,
      sameVersion: (left, right) =>
        left?.messageId === right?.messageId &&
        left?.footerText === right?.footerText,
      forget,
      resolve: async () => {
        current = { messageId: 'new', footerText: 'idle' };
        return {
          outcome: 'active',
          settled: false,
          changed: true,
          edit,
        };
      },
      isGoneError: () => false,
    });

    expect(outcome).toBe('active');
    expect(edit).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
  });

  it('recovers a late edit instead of forgetting after a fenced write loses', async () => {
    const carrier = { messageId: 'old', footerText: 'idle' };
    const recoverAfterLostLease = vi.fn().mockResolvedValue(undefined);
    const forget = vi.fn();

    const outcome = await refreshThreadFooterCarrier({
      lockKey: 'lock',
      read: async () => carrier,
      sameVersion: (left, right) =>
        left?.messageId === right?.messageId &&
        left?.footerText === right?.footerText,
      forget,
      resolve: async () => ({
        outcome: 'idle',
        settled: true,
        changed: true,
        edit: async () => {},
        remember: async () => false,
        recoverAfterLostLease,
      }),
      isGoneError: () => false,
    });

    expect(outcome).toBe('active');
    expect(recoverAfterLostLease).toHaveBeenCalledWith(
      carrier,
      expect.any(Function),
    );
    expect(forget).not.toHaveBeenCalled();
  });

  it('forgets only after a settled edit and its pointer write complete', async () => {
    const events: string[] = [];
    const carrier = { messageId: 'old', footerText: 'idle' };

    const outcome = await refreshThreadFooterCarrier({
      lockKey: 'lock',
      read: async () => carrier,
      sameVersion: (left, right) =>
        left?.messageId === right?.messageId &&
        left?.footerText === right?.footerText,
      forget: async () => {
        events.push('forget');
      },
      resolve: async () => ({
        outcome: 'idle',
        settled: true,
        changed: true,
        edit: async () => {
          events.push('edit');
        },
        remember: async () => {
          events.push('remember');
          return true;
        },
      }),
      isGoneError: () => false,
    });

    expect(outcome).toBe('gone');
    expect(events).toEqual(['edit', 'remember', 'forget']);
  });
});
