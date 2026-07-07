import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { publicProcedure } from '../trpc';

/**
 * Prioritize an existing queued message to be processed next, then interrupt
 * the current turn without moving the parent task into the stopped/idle
 * state. The existing auto-resume logic will pick up the reordered queue
 * after the turn exits.
 */
export const steerQueuedMessage = publicProcedure
  .input(
    z.object({
      queuedMessageId: z.string().min(1),
    }),
  )
  .mutation(({ input, ctx }) => {
    if (!ctx.harnessManager) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Harness manager is not available',
      });
    }

    if (!ctx.harnessManager.steerQueuedMessage(input.queuedMessageId)) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Queued message not found',
      });
    }

    return { success: true };
  });
