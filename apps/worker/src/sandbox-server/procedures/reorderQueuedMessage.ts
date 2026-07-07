import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { publicProcedure } from '../trpc';

export const reorderQueuedMessage = publicProcedure
  .input(
    z.object({
      queuedMessageId: z.string().min(1),
      targetQueuedMessageId: z.string().min(1),
      position: z.enum(['before', 'after']),
    }),
  )
  .mutation(({ input, ctx }) => {
    if (!ctx.harnessManager) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Harness manager is not available',
      });
    }

    const reordered = ctx.harnessManager.reorderQueuedMessage(
      input.queuedMessageId,
      input.targetQueuedMessageId,
      input.position,
    );

    if (!reordered) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Queued message not found',
      });
    }

    return { success: true };
  });
