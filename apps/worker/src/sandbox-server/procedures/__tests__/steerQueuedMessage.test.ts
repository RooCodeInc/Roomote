import { appRouter } from '../../routers';
import type { Context } from '../../trpc';

function createCaller(options?: {
  harnessManagerAvailable?: boolean;
  steerQueuedMessage?: (queuedMessageId: string) => boolean;
}) {
  const harnessManagerAvailable = options?.harnessManagerAvailable ?? true;
  const steerQueuedMessage = vi.fn(options?.steerQueuedMessage ?? (() => true));

  const harnessManager = harnessManagerAvailable
    ? {
        steerQueuedMessage,
      }
    : undefined;

  const ctx = {
    workingDirectory: '/tmp',
    harness: { isConnected: true },
    harnessManager,
  } as unknown as Context;

  return {
    caller: appRouter.createCaller(ctx),
    steerQueuedMessage,
  };
}

describe('steerQueuedMessage procedure', () => {
  it('steers the queued message through the harness manager', async () => {
    const { caller, steerQueuedMessage } = createCaller();

    const result = await caller.commands.steerQueuedMessage({
      queuedMessageId: 'runtime-queued-2',
    });

    expect(result).toEqual({ success: true });
    expect(steerQueuedMessage).toHaveBeenCalledWith('runtime-queued-2');
  });

  it('throws PRECONDITION_FAILED when harness manager is unavailable', async () => {
    const { caller } = createCaller({ harnessManagerAvailable: false });

    await expect(
      caller.commands.steerQueuedMessage({
        queuedMessageId: 'runtime-queued-2',
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('throws NOT_FOUND when queued message does not exist', async () => {
    const { caller, steerQueuedMessage } = createCaller({
      steerQueuedMessage: () => false,
    });

    await expect(
      caller.commands.steerQueuedMessage({ queuedMessageId: 'missing-id' }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    expect(steerQueuedMessage).toHaveBeenCalledWith('missing-id');
  });
});
