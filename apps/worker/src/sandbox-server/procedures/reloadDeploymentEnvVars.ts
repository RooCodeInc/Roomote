import { TRPCError } from '@trpc/server';

import { sdk } from '@roomote/sdk/client';

import { injectEnvVars } from '../../commands/utils/env-vars';
import { runUnlessCredentialWriteBarrier } from '../../lib';

import { publicProcedure } from '../trpc';

function omitKeys(
  env: Record<string, string>,
  keys: readonly string[],
): Record<string, string> {
  const nextEnv = { ...env };

  for (const key of keys) {
    delete nextEnv[key];
  }

  return nextEnv;
}

export const reloadDeploymentEnvVars = publicProcedure.mutation(
  async ({ ctx }) => {
    if (!ctx.runId) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Task run context is required',
      });
    }

    if (!ctx.workerEnv) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Worker environment is not available for live reload',
      });
    }

    const { runId, workerEnv, harness } = ctx;

    // Wrapped in the credential write barrier: the reload rewrites env.sh,
    // which must not happen between the pre-snapshot scrub and the provider
    // filesystem snapshot.
    const reloadResult = await runUnlessCredentialWriteBarrier(async () => {
      const [freshEnvVars, taskRun] = await Promise.all([
        sdk.taskRuns.getResolvedRuntimeEnvVars({ runId }),
        sdk.taskRuns.findFirstById(runId),
      ]);

      if (!taskRun) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Task run not found',
        });
      }

      const currentRuntimeEnv = workerEnv.getRuntimeEnv();
      const nextRuntimeEnv: Record<string, string> = { ...freshEnvVars };

      await injectEnvVars(nextRuntimeEnv, taskRun, {
        previewProxyBaseUrl: workerEnv.previewProxyBaseUrl,
        previewProxySubdomainSuffix: workerEnv.previewProxySubdomainSuffix,
        syncSourceControlTokenFiles: false,
      });

      workerEnv.setRuntimeEnv(nextRuntimeEnv);

      const currentCommandEnv = harness.getCommandEnv?.() ?? {};
      const baseCommandEnv = omitKeys(
        currentCommandEnv,
        Object.keys(currentRuntimeEnv),
      );

      harness.setCommandEnv?.({
        ...baseCommandEnv,
        ...nextRuntimeEnv,
      });

      return {
        success: true,
        names: Object.keys(freshEnvVars).sort((left, right) =>
          left.localeCompare(right),
        ),
      };
    });

    if (!reloadResult) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'Environment reload is unavailable while the sandbox prepares for a snapshot',
      });
    }

    return reloadResult;
  },
);
