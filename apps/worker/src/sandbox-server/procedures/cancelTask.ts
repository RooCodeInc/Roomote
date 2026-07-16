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
    /**
     * When true, cancel is terminal and the sandbox shuts down. Soft stops (web
     * stop control) omit this and leave the sandbox resumable.
     */
    terminate: z.boolean().optional(),
  })
  .optional();

/**
 * Cancel the current task. Soft cancel stays resumable; `terminate: true` shuts
 * the sandbox down so provider Cancel buttons actually end the run.
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

    ctx.harnessManager.cancelTask({
      ...(input?.cancelledBy ? { cancelledBy: input.cancelledBy } : {}),
      ...(input?.terminate ? { terminate: true } : {}),
    });

    return { success: true };
  });
