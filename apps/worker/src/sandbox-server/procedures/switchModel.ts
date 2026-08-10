import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { publicProcedure } from '../trpc';

/**
 * Change the model used for the running task's subsequent turns.
 *
 * The switch is bounded by the models the generated OpenCode config can
 * already resolve, which the control plane advertises through
 * `R_SWITCHABLE_MODELS`. Validating here (rather than only inside the harness)
 * lets the caller get a real rejection instead of a background command error.
 *
 * An in-flight turn is deliberately not interrupted: it finishes on the
 * previous model and the next prompt carries the new one.
 */
export const switchModel = publicProcedure
  .input(
    z.object({
      model: z.string().trim().min(1),
      userName: z.string().optional(),
    }),
  )
  .mutation(({ input, ctx }) => {
    if (!ctx.harness.isConnected) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Sandbox harness is not connected',
      });
    }

    if (!ctx.harnessManager) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Task runtime is not ready to switch models',
      });
    }

    const userId =
      // Deployment-principal run tokens have a null userId; treat them as no
      // acting user rather than fabricating one.
      ctx.auth && 'userId' in ctx.auth
        ? (ctx.auth.userId ?? undefined)
        : undefined;

    const { activeModel, switchableModels } =
      ctx.harnessManager.getModelState();

    // No advertised set means this run has no capability signal at all — an
    // older control plane, or a runtime that resolved no catalog. Accepting a
    // switch here would be a guess: the model may not be resolvable, and a
    // later reconnect would silently revert to the launch model. Refuse
    // instead of promising a switch that cannot be guaranteed to stick.
    if (switchableModels.length === 0) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'This task run did not advertise any switchable models, so its model cannot be changed while it runs.',
      });
    }

    if (!switchableModels.includes(input.model)) {
      throw new TRPCError({
        // Deliberately not BAD_REQUEST: the model may be perfectly valid and
        // enabled, just not resolvable by this run's generated config.
        code: 'PRECONDITION_FAILED',
        message: `Model "${input.model}" is not available to this task run. Switching is limited to models this run's runtime already resolved.`,
      });
    }

    if (activeModel === input.model) {
      return { success: true, activeModel, changed: false };
    }

    const sent = ctx.harnessManager.switchModel({
      model: input.model,
      reason: 'user',
      ...(userId ? { userId } : {}),
      ...(input.userName ? { userName: input.userName } : {}),
    });

    if (!sent) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Sandbox harness rejected the model switch',
      });
    }

    return { success: true, activeModel: input.model, changed: true };
  });
