import { appRouter } from '../../routers';
import type { Context } from '../../trpc';

function createCaller(options?: {
  harnessManagerAvailable?: boolean;
  reorderQueuedMessage?: (
    queuedMessageId: string,
    targetQueuedMessageId: string,
    position: 'before' | 'after',
  ) => boolean;
}) {
  const harnessManagerAvailable = options?.harnessManagerAvailable ?? true;
  const reorderQueuedMessage = vi.fn(
    options?.reorderQueuedMessage ?? (() => true),
  );

  const harnessManager = harnessManagerAvailable
    ? {
        reorderQueuedMessage,
      }
    : undefined;

  const ctx = {
    workingDirectory: '/tmp',
    harness: { isConnected: true },
    harnessManager,
  } as unknown as Context;

  return {
    caller: appRouter.createCaller(ctx),
    reorderQueuedMessage,
  };
}

describe('reorderQueuedMessage procedure', () => {
  it('reorders a queued message relative to the target message', async () => {
    const { caller, reorderQueuedMessage } = createCaller();

    const result = await caller.commands.reorderQueuedMessage({
      queuedMessageId: 'runtime-queued-3',
      targetQueuedMessageId: 'runtime-queued-1',
      position: 'before',
    });

    expect(result).toEqual({ success: true });
    expect(reorderQueuedMessage).toHaveBeenCalledWith(
      'runtime-queued-3',
      'runtime-queued-1',
      'before',
    );
  });

  it('throws PRECONDITION_FAILED when harness manager is unavailable', async () => {
    const { caller } = createCaller({ harnessManagerAvailable: false });

    await expect(
      caller.commands.reorderQueuedMessage({
        queuedMessageId: 'runtime-queued-3',
        targetQueuedMessageId: 'runtime-queued-1',
        position: 'before',
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('throws NOT_FOUND when either queued message does not exist', async () => {
    const { caller, reorderQueuedMessage } = createCaller({
      reorderQueuedMessage: () => false,
    });

    await expect(
      caller.commands.reorderQueuedMessage({
        queuedMessageId: 'missing-id',
        targetQueuedMessageId: 'runtime-queued-1',
        position: 'after',
      }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    expect(reorderQueuedMessage).toHaveBeenCalledWith(
      'missing-id',
      'runtime-queued-1',
      'after',
    );
  });
});
