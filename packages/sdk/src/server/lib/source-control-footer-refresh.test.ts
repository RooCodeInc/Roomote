const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  context: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  schedule: vi.fn().mockResolvedValue(undefined),
  forget: vi.fn(),
  failRemember: false,
  repositoryAvailable: true,
}));
vi.mock('@roomote/cloud-agents/server', () => ({
  createFastAgentTaskLauncher: () => vi.fn(),
}));
vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    get: async (key: string) => mocks.store.get(key) ?? null,
    set: async (key: string, value: string, ...args: unknown[]) => {
      if (mocks.failRemember && key.startsWith('source_control:footer:'))
        throw new Error('pointer write failed');
      if (
        (args.includes('NX') && mocks.store.has(key)) ||
        (args.includes('XX') && !mocks.store.has(key))
      )
        return null;
      mocks.store.set(key, value);
      return 'OK';
    },
    del: async (key: string) => Number(mocks.store.delete(key)),
    eval: async (
      script: string,
      count: number,
      key: string,
      ...args: string[]
    ) => {
      const owner = args[count - 1];
      if (mocks.store.get(key) !== owner) return 0;
      if (count === 2) {
        const [pointerKey, , value, ttl] = args;
        if (
          mocks.failRemember &&
          pointerKey!.startsWith('source_control:footer:')
        )
          throw new Error('pointer write failed');
        if (ttl === 'keepTtl' && !mocks.store.has(pointerKey!)) return 0;
        mocks.store.set(pointerKey!, value!);
        return 1;
      }
      if (script.includes("'del'")) mocks.store.delete(key);
      return 1;
    },
  }),
}));
vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  repositories: {},
  db: {
    query: {
      repositories: {
        findMany: async () =>
          mocks.repositoryAvailable
            ? [
                {
                  host: 'github.com',
                  githubInstallation: { id: 'installation' },
                },
              ]
            : [],
      },
    },
  },
}));
vi.mock('@roomote/github', () => ({
  getInstallationOctokit: async () => ({
    rest: {
      issues: { updateComment: mocks.update, createComment: mocks.create },
      pulls: { updateReviewComment: mocks.update },
    },
  }),
}));
vi.mock('@roomote/communication', async () => {
  const { withThreadReplyFooterLock } =
    await import('@roomote/communication/thread-reply-footer-delivery');
  return {
    withThreadReplyFooterLock,
    buildFastSessionReplyFooterText: ({
      runningTasks,
      livePreviewUrl,
    }: {
      runningTasks?: { count: number };
      livePreviewUrl?: string;
    }) =>
      `${runningTasks?.count ?? 0} running; preview=${livePreviewUrl ?? 'none'}`,
    resolveFastSessionReplyFooterContext: mocks.context,
    classifyThreadFooterActivity: (context: {
      runningTasks?: { count: number } | null;
      livePreviewUrl?: string | null;
      sessionActivityAt?: number | null;
    }) => {
      const active =
        (context.runningTasks?.count ?? 0) > 0 ||
        Boolean(context.livePreviewUrl);
      return {
        active,
        settled:
          !active &&
          Date.now() - (context.sessionActivityAt ?? 0) > 6 * 60 * 60_000,
      };
    },
    scheduleThreadFooterRefresh: mocks.schedule,
    forgetThreadFooterRefresh: mocks.forget,
  };
});

import {
  buildSourceControlFastAdapter,
  refreshSourceControlThreadFooter,
} from './source-control-fast-delivery';
import {
  getSourceControlFooterRecord,
  sourceControlFooterTarget,
  clearSourceControlFooterRecord,
} from './source-control-thread-comment-state';

const conversation = {
  surface: 'github' as const,
  workspaceId: 'github.com/o/r',
  conversationId: 'pull/42',
  replyTarget: { channelId: 'pull/42' },
};
const target = sourceControlFooterTarget(conversation);
const record = () =>
  getSourceControlFooterRecord(target.channelId, target.threadId);
const adapter = (id: string, post = vi.fn(async () => ({ messageId: id }))) =>
  buildSourceControlFastAdapter({
    conversation,
    sessionId: 'session',
    userId: 'user',
    quote: '> Quoted message',
    delivery: {
      postComment: post,
      updateCommentById: async ({ messageId, body }) => {
        await mocks.update({ messageId, body });
      },
      resolveTarget: async () => ({}),
    },
  });

describe('source-control current footer refresh', () => {
  beforeEach(() => {
    mocks.store.clear();
    mocks.failRemember = false;
    mocks.repositoryAvailable = true;
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({
      runningTasks: { count: 0 },
      livePreviewUrl: 'https://preview',
    });
    mocks.update.mockResolvedValue(undefined);
  });

  it('refreshes latest lifecycle counts without posting or losing quote/body/preview, and skips unchanged state', async () => {
    const post = vi.fn(async () => ({ messageId: '123' }));
    await adapter('123', post).postReply({ message: 'Body' });
    await refreshSourceControlThreadFooter(target);
    expect(mocks.update).not.toHaveBeenCalled();
    for (const count of [1, 0, 2, 0, 1, 0]) {
      mocks.context.mockResolvedValue({
        runningTasks: { count },
        livePreviewUrl: 'https://preview',
      });
      await refreshSourceControlThreadFooter(target);
      expect(mocks.update).toHaveBeenLastCalledWith({
        owner: 'o',
        repo: 'r',
        comment_id: 123,
        body: `> Quoted message\n\nBody\n\n${count} running; preview=https://preview`,
      });
    }
    expect(post).toHaveBeenCalledTimes(1);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.context).toHaveBeenLastCalledWith({ sessionId: 'session' });
    expect((await record())?.body).toBe('> Quoted message\n\nBody');
  });

  it('a post finishing after lease loss cannot set or clear a competitor pointer and removes only its own footer', async () => {
    await adapter('111').postReply({ message: 'Original' });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const post = vi.fn(async () => {
      mocks.store.delete(
        `source_control:thread_reply_footer_lock:${target.channelId}:${target.threadId}`,
      );
      await adapter('456').postReply({ message: 'Competitor' });
      return { messageId: '123' };
    });
    await expect(
      adapter('123', post).postReply({ message: 'Orphan' }),
    ).resolves.toEqual({ messageId: '123' });
    expect((await record())?.messageId).toBe('456');
    expect((await record())?.body).toContain('Competitor');
    // The competitor stripped the footer it displaced; the orphan stripped its own.
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.update).toHaveBeenCalledWith({
      messageId: '111',
      body: '> Quoted message\n\nOriginal',
    });
    expect(mocks.update).toHaveBeenCalledWith({
      messageId: '123',
      body: '> Quoted message\n\nOrphan',
    });
    expect(mocks.schedule).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });

  it('a replacement finishing after lease loss cannot clear or overwrite a competitor pointer', async () => {
    const first = adapter('123');
    await first.postReply({ message: 'Original' });
    mocks.update.mockImplementationOnce(async () => {
      mocks.store.delete(
        `source_control:thread_reply_footer_lock:${target.channelId}:${target.threadId}`,
      );
      await adapter('456').postReply({ message: 'Competitor' });
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await first.replaceReply!({ messageId: '123' }, { message: 'Updated A' });
    expect((await record())?.messageId).toBe('456');
    expect(mocks.update).toHaveBeenLastCalledWith({
      messageId: '123',
      body: 'Updated A',
    });
    expect(mocks.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ messageId: '456' }),
    );
    warning.mockRestore();
  });

  it('compare-and-delete cleanup cannot delete a newer record even on the same comment', async () => {
    await adapter('123').postReply({ message: 'Original' });
    const expected = (await record())!;
    const newer = { ...expected, body: 'Updated by another owner' };
    mocks.store.set(
      `source_control:footer:${target.channelId}:${target.threadId}`,
      JSON.stringify(newer),
    );
    await clearSourceControlFooterRecord(
      target.channelId,
      target.threadId,
      expected,
    );
    expect(await record()).toEqual(newer);
  });

  it('a relocated footer is removed from the previous comment so it cannot go stale', async () => {
    await adapter('123').postReply({ message: 'First turn' });
    await adapter('456').postReply({ message: 'Second turn' });
    expect(mocks.update).toHaveBeenCalledWith({
      messageId: '123',
      body: '> Quoted message\n\nFirst turn',
    });
    expect((await record())?.messageId).toBe('456');
    mocks.update.mockClear();
    mocks.context.mockResolvedValue({ runningTasks: { count: 3 } });
    await refreshSourceControlThreadFooter(target);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 456 }),
    );
  });

  it('reports idle Sessions and unregisters settled ones without editing', async () => {
    await adapter('123').postReply({ message: 'Body' });
    mocks.update.mockClear();
    const idle = { runningTasks: { count: 0 }, sessionActivityAt: Date.now() };
    mocks.context.mockResolvedValue(idle);
    await refreshSourceControlThreadFooter(target);
    mocks.context.mockResolvedValue(idle);
    expect(await refreshSourceControlThreadFooter(target)).toBe('idle');
    expect(mocks.forget).not.toHaveBeenCalled();
    mocks.context.mockResolvedValue({ ...idle, sessionActivityAt: 0 });
    expect(await refreshSourceControlThreadFooter(target)).toBe('gone');
    expect(mocks.forget).toHaveBeenCalledWith(target);
    expect(mocks.update).toHaveBeenCalledTimes(1); // Only the idle edit itself.
  });

  it('forgets a carrier when the repository no longer has an available updater', async () => {
    await adapter('123').postReply({ message: 'Original' });
    mocks.repositoryAvailable = false;
    mocks.context.mockResolvedValue({ runningTasks: { count: 1 } });
    await refreshSourceControlThreadFooter(target);
    expect(mocks.forget).toHaveBeenCalledWith(target);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('missing carriers or deleted comments never post replacements', async () => {
    await refreshSourceControlThreadFooter(target);
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.forget).toHaveBeenCalled();
    await adapter('123').postReply({ message: 'Body' });
    mocks.context.mockResolvedValue({ runningTasks: { count: 1 } });
    mocks.update.mockRejectedValueOnce({ status: 404 });
    await refreshSourceControlThreadFooter(target);
    expect(mocks.create).not.toHaveBeenCalled();
    expect((await record())?.footerText).toBe(
      '0 running; preview=https://preview',
    );
  });

  it('refresh never edits a carrier a concurrent reply relocated; it follows only the latest carrier', async () => {
    await adapter('123').postReply({ message: 'Old body' });
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.context.mockImplementationOnce(async () => {
      started();
      await gate;
      return { runningTasks: { count: 1 } };
    });
    const refresh = refreshSourceControlThreadFooter(target);
    await ready;
    // Resolution holds no lock, so the reply is never delayed by it.
    const post = vi.fn(async () => ({ messageId: '456' }));
    await adapter('456', post).postReply({ message: 'New body' });
    expect(post).toHaveBeenCalledTimes(1);
    release();
    expect(await refresh).toBe('active');
    expect((await record())?.messageId).toBe('456');
    expect(mocks.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 123 }),
    );
    mocks.update.mockClear();
    mocks.context.mockResolvedValue({ runningTasks: { count: 2 } });
    await refreshSourceControlThreadFooter(target);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 456,
        body: expect.stringContaining('New body'),
      }),
    );
    expect(mocks.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 123 }),
    );
  });

  it('replacing an older reply cannot repoint refresh or restore its footer', async () => {
    const old = adapter('123');
    await old.postReply({ message: 'Old' });
    await adapter('456').postReply({ message: 'Current' });
    await old.replaceReply!(
      { messageId: '123' },
      { message: 'Historical edit' },
    );
    expect(mocks.update).toHaveBeenCalledWith({
      messageId: '123',
      body: 'Historical edit',
    });
    expect((await record())?.messageId).toBe('456');
  });

  it('a long-lived adapter appends to the current body after a resumed turn edited the same carrier', async () => {
    const reviewConversation = {
      ...conversation,
      replyTarget: { channelId: 'pull/42', threadId: 'review-1' },
    };
    const delivery = {
      postComment: async () => ({
        messageId: '123',
        update: async (body: string) => {
          await mocks.update({ messageId: '123', body });
        },
      }),
      updateCommentById: async ({
        messageId,
        body,
      }: {
        messageId: string;
        body: string;
      }) => {
        await mocks.update({ messageId, body });
      },
      resolveTarget: async () => ({}),
    };
    const first = buildSourceControlFastAdapter({
      conversation: reviewConversation,
      sessionId: 'session',
      userId: 'user',
      delivery,
    });
    await first.postReply({ message: 'First' });
    const resumed = buildSourceControlFastAdapter({
      conversation: reviewConversation,
      sessionId: 'session',
      userId: 'user',
      delivery,
      continuesThreadComment: true,
    });
    await resumed.postReply({ message: 'Resumed' });
    await first.postReply({ message: 'Later' });
    expect(mocks.update).toHaveBeenLastCalledWith({
      messageId: '123',
      body: 'First\n\nResumed\n\nLater\n\n0 running; preview=https://preview',
    });
  });

  it('a refresh whose lease lapses during the edit cannot repoint refresh at its comment, and strips the footer it applied', async () => {
    await adapter('123').postReply({ message: 'Old body' });
    mocks.context.mockResolvedValue({ runningTasks: { count: 1 } });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.update.mockImplementationOnce(async () => {
      // The refresh's lease expires mid-edit and a newer reply takes over.
      mocks.store.delete(
        `source_control:thread_reply_footer_lock:${target.channelId}:${target.threadId}`,
      );
      await adapter('456').postReply({ message: 'Newer body' });
    });
    expect(await refreshSourceControlThreadFooter(target)).toBe('active');
    expect((await record())?.messageId).toBe('456');
    // The refresh removes the footer it just applied through its own delivery.
    expect(mocks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        comment_id: 123,
        body: '> Quoted message\n\nOld body',
      }),
    );
    mocks.update.mockClear();
    mocks.context.mockResolvedValue({ runningTasks: { count: 2 } });
    await refreshSourceControlThreadFooter(target);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 456 }),
    );
    warning.mockRestore();
  });

  it('does not fail an accepted reply or refresh an old body when pointer persistence fails', async () => {
    await adapter('123').postReply({ message: 'Old body' });
    mocks.failRemember = true;
    const post = vi.fn(async () => ({ messageId: '456' }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      adapter('456', post).postReply({ message: 'New body' }),
    ).resolves.toEqual({ messageId: '456' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(await record()).toBeNull();
    await refreshSourceControlThreadFooter(target);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith({
      messageId: '456',
      body: '> Quoted message\n\nNew body',
    });
    warning.mockRestore();
  });
});
