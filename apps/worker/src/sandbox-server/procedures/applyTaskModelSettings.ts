import { TRPCError } from '@trpc/server';

import { publicProcedure } from '../trpc';

/**
 * Applies the run's persisted per-task model settings to the live harness.
 * The caller (web/API) persists the settings to `task_runs.payload` first;
 * this procedure re-reads them and restarts the harness so the regenerated
 * OpenCode config takes effect — immediately when no turn is active,
 * otherwise at the next queued-prompt delivery.
 */
export const applyTaskModelSettings = publicProcedure.mutation(
  async ({ ctx }) => {
    if (!ctx.applyTaskModelSettingsUpdate) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Model settings updates are not available for this sandbox',
      });
    }

    const { application } = await ctx.applyTaskModelSettingsUpdate();

    return { success: true as const, application };
  },
);
