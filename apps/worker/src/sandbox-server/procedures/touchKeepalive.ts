import { publicProcedure } from '../trpc';

/**
 * Signal user activity (e.g. preview navigation) to extend the keepalive
 * timer without sending a prompt. Only effective while in
 * `waiting_for_prompt` phase — otherwise it's a no-op.
 */
export const touchKeepalive = publicProcedure.mutation(({ ctx }) => {
  ctx.harnessManager?.touchKeepalive();
  return { success: true };
});
