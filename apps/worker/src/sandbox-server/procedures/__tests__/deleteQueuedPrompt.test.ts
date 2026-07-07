import { TRPCError } from '@trpc/server';

import { appRouter } from '../../routers';
import type { Context } from '../../trpc';

function createCaller(options?: {
  deleteQueuedMessage?: (queuedMessageId: string) => boolean;
  includeHarnessManager?: boolean;
}) {
  const deleteQueuedMessage = vi.fn(
    options?.deleteQueuedMessage ?? (() => true),
  );

  const harnessManager =
    options?.includeHarnessManager === false
      ? undefined
      : {
          deleteQueuedMessage,
        };

  const ctx = {
    workingDirectory: '/tmp',
    harness: { isConnected: true },
    harnessManager,
  } as unknown as Context;

  return {
    caller: appRouter.createCaller(ctx),
    deleteQueuedMessage,
  };
}

describe('deleteQueuedPrompt procedure', () => {
  it('deletes queued prompts through HarnessManager', async () => {
    const { caller, deleteQueuedMessage } = createCaller();

    const result = await caller.commands.deleteQueuedPrompt({
      queuedMessageId: 'runtime-queued-1',
    });

    expect(result).toEqual({ success: true, deleted: true });
    expect(deleteQueuedMessage).toHaveBeenCalledWith('runtime-queued-1');
  });

  it('returns deleted=false when queue item does not exist', async () => {
    const { caller, deleteQueuedMessage } = createCaller({
      deleteQueuedMessage: () => false,
    });

    const result = await caller.commands.deleteQueuedPrompt({
      queuedMessageId: 'missing-id',
    });

    expect(result).toEqual({ success: true, deleted: false });
    expect(deleteQueuedMessage).toHaveBeenCalledWith('missing-id');
  });

  it('throws when HarnessManager is unavailable', async () => {
    const { caller } = createCaller({ includeHarnessManager: false });

    await expect(
      caller.commands.deleteQueuedPrompt({
        queuedMessageId: 'runtime-queued-1',
      }),
    ).rejects.toThrow(TRPCError);
  });
});
