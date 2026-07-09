import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { publicProcedure } from '../trpc';

const cancelTaskInputSchema = z
  .object({
    /**
     * Attribution for an explicit user stop. When present, the harness leaves
     * a visible `task_cancelled` marker in the transcript.
     */
    cancelledBy: z
      .object({
        /** Display name of the user who stopped the task. */
        name: z.string().trim().min(1).max(200).optional(),
        /** Surface the stop came from (e.g. 'web', 'slack', 'telegram'). */
        source: z.string().trim().min(1).max(50).optional(),
      })
      .optional(),
  })
  .optional();

/**
 * Cancel the current task and leave the sandbox ready to resume.
 */
export const cancelTask = publicProcedure
  .input(cancelTaskInputSchema)
  .mutation(async ({ ctx, input }) => {
    if (!ctx.harnessManager) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Harness manager is not available',
      });
    }

    ctx.harnessManager.cancelTask(
      input?.cancelledBy ? { cancelledBy: input.cancelledBy } : undefined,
    );

    return { success: true };
  });
