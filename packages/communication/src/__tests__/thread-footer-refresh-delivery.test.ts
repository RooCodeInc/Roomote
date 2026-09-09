import { beforeEach, describe, expect, it, vi } from 'vitest';

const { store, get, resolveFooter, schedule, forget, renew, failures } =
  vi.hoisted(() => ({
    store: new Map<string, string>(),
    get: vi.fn(),
    resolveFooter: vi.fn(),
    schedule: vi.fn().mockResolvedValue(undefined),
    forget: vi.fn(),
    renew: vi.fn(),
    failures: { recordWrite: false },
  }));
vi.mock('../thread-footer-refresh', () => ({
  resolveCurrentThreadFooterText: resolveFooter,
  scheduleThreadFooterRefresh: schedule,
  forgetThreadFooterRefresh: forget,
}));
vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    get,
    set: async (key: string, value: string, ...args: unknown[]) => {
      if (failures.recordWrite && key.includes(':thread_reply_footer:'))
        throw new Error('Redis write unavailable');
      if (
        (args.includes('NX') && store.has(key)) ||
        (args.includes('XX') && !store.has(key))
      )
        return null;
      store.set(key, value);
      return 'OK';
    },
    eval: async (
      script: string,
      count: number,
      key: string,
      ...args: string[]
    ) => {
      const owner = args[count - 1];
      if (store.get(key) !== owner) return 0;
      if (count === 2) {
        if (failures.recordWrite) throw new Error('Redis write unavailable');
        const [pointerKey, , value, ttl] = args;
        if (ttl !== 'keepTtl' || store.has(pointerKey!))
          store.set(pointerKey!, value!);
        return 1;
      }
      if (script.includes("'expire'")) renew();
      if (script.includes("'del'")) store.delete(key);
      return 1;
    },
  }),
}));

import {
  deliverManagedThreadReplyFooter,
  refreshManagedThreadReplyFooter,
  rememberThreadReplyFooterAfterEdit,
  withThreadReplyFooterLock,
} from '../thread-reply-footer-delivery';
import {
  getThreadReplyFooterRecord,
  setThreadReplyFooterRecord,
} from '../thread-reply-footer-state';
import { DiscordCommunicationProvider } from '../discord-provider';

const target = {
  provider: 'discord' as const,
  channelId: 'parent',
  threadId: 'thread',
};
const record = {
  messageId: 'current',
  textWithoutFooter: 'Body and quote',
  images: [{ url: 'https://image', altText: 'proof' }],
  refresh: { footerText: 'idle', channelId: 'thread' },
};
const read = () =>
  getThreadReplyFooterRecord(
    target.provider,
    target.channelId,
    target.threadId,
  );
const write = (value = record) =>
  setThreadReplyFooterRecord(
    target.provider,
    target.channelId,
    target.threadId,
    value,
  );
const tick = (edit = vi.fn().mockResolvedValue(undefined)) =>
  refreshManagedThreadReplyFooter({ ...target, edit });

describe('current footer refresh serialization', () => {
  it('rejects an initial write when the lease changes after the final check', async () => {
    await write();
    const lockKey = 'discord:thread_reply_footer_lock:parent:thread';
    const competitor = { ...record, messageId: 'competitor' };
    const posted = { ...record, messageId: 'orphan' };
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      deliverManagedThreadReplyFooter({
        provider: 'discord',
        providerLabel: 'Discord',
        channelId: 'parent',
        footerStateThreadId: 'thread',
        lockKey,
        logRef: 'test',
        logContext: 'test',
        clearPreviousFooter: cleanup,
        postReplyWithFooter: async () => {
          get.mockImplementationOnce(async (key: string) => {
            expect(key).toBe(lockKey);
            const owner = store.get(key);
            store.set(key, 'competitor-owner');
            await write(competitor);
            return owner;
          });
          return posted;
        },
      }),
    ).resolves.toEqual(posted);
    expect(await read()).toEqual(competitor);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(posted);
    expect(store.get(lockKey)).toBe('competitor-owner');
    expect(schedule).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });
  it.each(['competitor', 'current'])(
    'cleans a late refresh only when another carrier is current (%s)',
    async (currentId) => {
      await write();
      const edit = vi
        .fn()
        .mockImplementationOnce(async () => {
          store.set(
            'discord:thread_reply_footer_lock:parent:thread',
            'new-owner',
          );
          await write({ ...record, messageId: currentId });
        })
        .mockResolvedValue(undefined);
      await tick(edit);
      expect((await read())?.messageId).toBe(currentId);
      expect((await read())?.refresh?.footerText).toBe('idle');
      expect(edit).toHaveBeenCalledTimes(currentId === 'current' ? 1 : 2);
      if (currentId !== 'current') {
        expect(edit).toHaveBeenLastCalledWith(record, record.textWithoutFooter);
      }
      expect(store.get('discord:thread_reply_footer_lock:parent:thread')).toBe(
        'new-owner',
      );
    },
  );

  it('a post finishing after lease loss cannot overwrite the competing carrier and strips only its own footer', async () => {
    await write();
    const clearOwn = vi.fn().mockResolvedValue(undefined);
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    const params = {
      provider: 'discord' as const,
      providerLabel: 'Discord',
      channelId: 'parent',
      footerStateThreadId: 'thread',
      lockKey: 'discord:thread_reply_footer_lock:parent:thread',
      logRef: 'test',
      logContext: 'test',
    };
    const result = await deliverManagedThreadReplyFooter({
      ...params,
      clearPreviousFooter: clearOwn,
      postReplyWithFooter: async () => {
        store.delete(params.lockKey); // A's lease expires while its provider call is pending.
        await deliverManagedThreadReplyFooter({
          ...params,
          clearPreviousFooter: vi.fn().mockResolvedValue(undefined),
          postReplyWithFooter: async () => ({
            ...record,
            messageId: 'competitor',
            textWithoutFooter: 'B',
          }),
        });
        return { ...record, messageId: 'orphan', textWithoutFooter: 'A' };
      },
    });
    expect(result.messageId).toBe('orphan');
    expect((await read())?.messageId).toBe('competitor');
    expect(clearOwn).toHaveBeenCalledTimes(1);
    expect(clearOwn).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'orphan', textWithoutFooter: 'A' }),
    );
    expect(schedule).toHaveBeenCalledTimes(2); // Original and competitor, never orphan.
    warning.mockRestore();
  });

  it('does not strip a deduplicated post adopted as the competitor current carrier', async () => {
    await write();
    const clearOwn = vi.fn();
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    await deliverManagedThreadReplyFooter({
      provider: 'discord',
      providerLabel: 'Discord',
      channelId: 'parent',
      footerStateThreadId: 'thread',
      lockKey: 'discord:thread_reply_footer_lock:parent:thread',
      logRef: 'test',
      logContext: 'test',
      clearPreviousFooter: clearOwn,
      postReplyWithFooter: async () => {
        store.set(
          'discord:thread_reply_footer_lock:parent:thread',
          'competitor',
        );
        await write({ ...record, messageId: 'deduplicated' });
        return { ...record, messageId: 'deduplicated' };
      },
    });
    expect((await read())?.messageId).toBe('deduplicated');
    expect(clearOwn).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it('an edit finishing after lease loss cannot repoint the carrier', async () => {
    await write({ ...record, messageId: 'competitor' });
    const clearOwnFooter = vi.fn().mockResolvedValue(undefined);
    await rememberThreadReplyFooterAfterEdit({
      ...target,
      record,
      assertLock: async () => {
        throw new Error('lease lost');
      },
      lock: {
        key: 'discord:thread_reply_footer_lock:parent:thread',
        ownerId: 'stale',
      },
      clearOwnFooter,
    });
    expect((await read())?.messageId).toBe('competitor');
    expect(clearOwnFooter).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'rejects a pointer write when ownership changes after a successful assertion (keepTtl=%s)',
    async (keepTtl) => {
      await write();
      const lockKey = 'discord:thread_reply_footer_lock:parent:thread';
      const competitor = { ...record, messageId: 'competitor' };
      const clearOwnFooter = vi.fn().mockResolvedValue(undefined);
      const successfulAssertion = vi.fn();
      await withThreadReplyFooterLock({
        lockKey,
        fn: async (assertLock, lock) => {
          await rememberThreadReplyFooterAfterEdit({
            ...target,
            record,
            lock,
            keepTtl,
            assertLock: async () => {
              await assertLock();
              successfulAssertion();
              // Expire A's lease after GET succeeds, before A's pointer mutation.
              store.set(lockKey, 'competitor-owner');
              await write(competitor);
            },
            clearOwnFooter,
          });
        },
      });
      expect(successfulAssertion).toHaveBeenCalledTimes(1);
      expect(await read()).toEqual(competitor);
      expect(store.get(lockKey)).toBe('competitor-owner');
      expect(clearOwnFooter).toHaveBeenCalledTimes(1);
      expect(schedule).toHaveBeenCalledTimes(2);
    },
  );

  it.each([404, 410])(
    'forgets a provider-deleted carrier (%s) while holding its lock',
    async (status) => {
      await write();
      await tick(vi.fn().mockRejectedValue({ status }));
      expect(forget).toHaveBeenCalledWith(target);
      expect((await read())?.refresh?.footerText).toBe('idle');
    },
  );

  it('does not unsubscribe a competitor when a stale edit reports deletion after losing its lease', async () => {
    await write();
    await expect(
      tick(
        vi.fn(async () => {
          store.set(
            'discord:thread_reply_footer_lock:parent:thread',
            'competitor',
          );
          await write({ ...record, messageId: 'competitor' });
          throw Object.assign(new Error('message deleted'), { status: 404 });
        }),
      ),
    ).rejects.toThrow('lease lost');
    expect(forget).not.toHaveBeenCalled();
    expect((await read())?.messageId).toBe('competitor');
  });
  it('a Discord footer-only PATCH leaves the carrier interactive components untouched', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'current' }), { status: 200 }),
      );
    const provider = new DiscordCommunicationProvider({
      botToken: 'test-token',
      fetch,
    });
    await provider.editMessage({
      channelId: 'thread',
      messageId: 'current',
      text: 'Body\n\nNew footer',
      preserveButtons: true,
    });
    const payload = JSON.parse(fetch.mock.calls[0]![1].body as string);
    expect(payload).toEqual({
      content: 'Body\n\nNew footer',
      allowed_mentions: { parse: [] },
    });
    expect(payload).not.toHaveProperty('components');
  });
  beforeEach(() => {
    get
      .mockReset()
      .mockImplementation(async (key: string) => store.get(key) ?? null);
    store.clear();
    vi.clearAllMocks();
    failures.recordWrite = false;
    resolveFooter.mockResolvedValue('running');
  });

  it('updates start/finish/fail/cancel/wait/resume from each newly resolved state, retaining body and images', async () => {
    await write();
    const edit = vi.fn().mockResolvedValue(undefined);
    for (const footer of [
      '1 running task',
      'No running tasks (finished)',
      '1 running task (new run)',
      'No running tasks (failed)',
      '1 running task (retry)',
      'No running tasks (cancelled)',
      '1 running task (resumed)',
      'No running tasks (waiting)',
    ]) {
      resolveFooter.mockResolvedValueOnce(footer);
      await tick(edit);
      expect(edit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messageId: 'current',
          images: record.images,
        }),
        `${record.textWithoutFooter}\n\n${footer}`,
      );
      expect((await read())?.refresh?.footerText).toBe(footer);
    }
    expect(schedule).toHaveBeenCalledTimes(1); // refresh does not extend the carrier TTL
  });

  it('does not edit unchanged, missing or unresolvable carriers or scan history', async () => {
    const edit = vi.fn();
    await tick(edit);
    expect(forget).toHaveBeenCalledWith(target);
    await write();
    resolveFooter.mockResolvedValueOnce('idle').mockResolvedValueOnce(null);
    await tick(edit);
    await tick(edit);
    expect(edit).not.toHaveBeenCalled();
  });

  it('does not acknowledge a failed edit, so the next tick retries it', async () => {
    await write();
    await expect(
      tick(vi.fn().mockRejectedValue(new Error('provider unavailable'))),
    ).rejects.toThrow('provider unavailable');
    expect((await read())?.refresh?.footerText).toBe('idle');
    const edit = vi.fn().mockResolvedValue(undefined);
    await tick(edit);
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it('holds the delivery lock across resolution and edit; later ticks target only the relocated carrier', async () => {
    await write();
    let release!: () => void;
    let started!: () => void;
    const editing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = tick(
      vi.fn(async () => {
        started();
        await gate;
      }),
    );
    await editing;
    const clear = vi.fn().mockResolvedValue(undefined);
    const post = vi.fn(async () => ({
      ...record,
      messageId: 'new',
      textWithoutFooter: 'New body',
    }));
    const delivery = deliverManagedThreadReplyFooter({
      provider: 'discord',
      providerLabel: 'Discord',
      channelId: 'parent',
      footerStateThreadId: 'thread',
      lockKey: 'discord:thread_reply_footer_lock:parent:thread',
      logRef: 'test',
      logContext: 'test',
      postReplyWithFooter: post,
      clearPreviousFooter: clear,
    });
    expect(post).not.toHaveBeenCalled();
    release();
    await refresh;
    await delivery;
    expect(clear).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'current',
        textWithoutFooter: 'Body and quote',
      }),
    );
    const edit = vi.fn().mockResolvedValue(undefined);
    await tick(edit);
    expect(edit).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'new' }),
      'New body\n\nrunning',
    );
  });

  it('aborts when its lease was lost while resolving instead of overwriting a newer reply', async () => {
    await write();
    resolveFooter.mockImplementationOnce(async () => {
      store.set('discord:thread_reply_footer_lock:parent:thread', 'new-owner');
      return 'running';
    });
    const edit = vi.fn();
    await expect(tick(edit)).rejects.toThrow('lease lost');
    expect(edit).not.toHaveBeenCalled();
    expect(store.get('discord:thread_reply_footer_lock:parent:thread')).toBe(
      'new-owner',
    );
  });

  it('renews its lease across slow resolution/provider work and releases it on completion', async () => {
    vi.useFakeTimers();
    try {
      await write();
      let release!: () => void;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      resolveFooter.mockImplementationOnce(async () => {
        started();
        await gate;
        return 'running';
      });
      const refresh = tick();
      await ready;
      await vi.advanceTimersByTimeAsync(35_000);
      expect(renew).toHaveBeenCalledTimes(3);
      expect(store.has('discord:thread_reply_footer_lock:parent:thread')).toBe(
        true,
      );
      release();
      await refresh;
      expect(store.has('discord:thread_reply_footer_lock:parent:thread')).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not clear the prior carrier if persisting its replacement fails', async () => {
    await write();
    failures.recordWrite = true;
    const clear = vi.fn().mockResolvedValue(undefined);
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    await deliverManagedThreadReplyFooter({
      provider: 'discord',
      providerLabel: 'Discord',
      channelId: 'parent',
      footerStateThreadId: 'thread',
      lockKey: 'discord:thread_reply_footer_lock:parent:thread',
      logRef: 'test',
      logContext: 'test',
      postReplyWithFooter: async () => ({ ...record, messageId: 'new' }),
      clearPreviousFooter: clear,
    });
    expect(clear).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'new' }),
    );
    expect(clear).not.toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'current' }),
    );
    expect((await read())?.messageId).toBe('current');
    warning.mockRestore();
  });
});
