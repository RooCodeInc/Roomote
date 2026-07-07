import { TRPCError } from '@trpc/server';

import { publicProcedure } from '../trpc';

/**
 * Cancel the current task and leave the sandbox ready to resume.
 */
export const cancelTask = publicProcedure.mutation(async ({ ctx }) => {
  if (!ctx.harnessManager) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Harness manager is not available',
    });
  }

  ctx.harnessManager.cancelTask();

  return { success: true };
});
