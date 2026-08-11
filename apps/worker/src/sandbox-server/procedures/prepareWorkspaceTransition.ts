import { publicProcedure } from '../trpc';
import { isActiveTaskPhase } from '../lib/harness-manager';

export const prepareWorkspaceTransition = publicProcedure.mutation(
  ({ ctx }) => {
    // This mutation is serialized by the Node event loop with prompt mutations.
    // Set the fence before reading status so no later prompt can begin between
    // the idle check and Git inspection.
    if (!ctx.workspaceTransitionState) {
      throw new Error('Workspace transition state is not available');
    }

    ctx.workspaceTransitionState.requested = true;
    const phase = ctx.harnessManager?.getStatus().phase ?? 'idle';
    if (isActiveTaskPhase(phase)) {
      ctx.workspaceTransitionState.requested = false;
      return { ready: false as const, phase };
    }
    return { ready: true as const, phase };
  },
);

export const abortWorkspaceTransition = publicProcedure.mutation(({ ctx }) => {
  if (!ctx.workspaceTransitionState) {
    throw new Error('Workspace transition state is not available');
  }

  ctx.workspaceTransitionState.requested = false;
  return { success: true as const };
});
