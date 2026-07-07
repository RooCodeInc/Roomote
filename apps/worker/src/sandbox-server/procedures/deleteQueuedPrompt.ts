import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { publicProcedure } from '../trpc';

/**
 * Delete a queued follow-up prompt by id.
 *
 * This only affects prompts buffered while the runtime is busy.
 */
export const deleteQueuedPrompt = publicProcedure
  .input(
    z.object({
      queuedMessageId: z.string().min(1),
    }),
  )
  .mutation(async ({ input, ctx }) => {
    if (!ctx.harnessManager) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Harness manager is not available',
      });
    }

    const deleted = ctx.harnessManager.deleteQueuedMessage(
      input.queuedMessageId,
    );

    return { success: true, deleted };
  });
