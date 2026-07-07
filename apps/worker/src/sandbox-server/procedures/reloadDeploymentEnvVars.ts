import { TRPCError } from '@trpc/server';

import { sdk } from '@roomote/sdk/client';

import { injectEnvVars } from '../../commands/utils/env-vars';

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
    if (!ctx.cloudJobId) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Cloud job context is required',
      });
    }

    if (!ctx.workerEnv) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Worker environment is not available for live reload',
      });
    }

    const [freshEnvVars, cloudJob] = await Promise.all([
      sdk.cloudJobs.getResolvedRuntimeEnvVars({ cloudJobId: ctx.cloudJobId }),
      sdk.cloudJobs.findFirstById(ctx.cloudJobId),
    ]);

    if (!cloudJob) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Cloud job not found',
      });
    }

    const currentRuntimeEnv = ctx.workerEnv.getRuntimeEnv();
    const nextRuntimeEnv: Record<string, string> = { ...freshEnvVars };

    await injectEnvVars(nextRuntimeEnv, cloudJob, {
      previewProxyBaseUrl: ctx.workerEnv.previewProxyBaseUrl,
      previewProxySubdomainSuffix: ctx.workerEnv.previewProxySubdomainSuffix,
      syncSourceControlTokenFiles: false,
    });

    ctx.workerEnv.setRuntimeEnv(nextRuntimeEnv);

    const currentCommandEnv = ctx.harness.getCommandEnv?.() ?? {};
    const baseCommandEnv = omitKeys(
      currentCommandEnv,
      Object.keys(currentRuntimeEnv),
    );

    ctx.harness.setCommandEnv?.({
      ...baseCommandEnv,
      ...nextRuntimeEnv,
    });

    return {
      success: true,
      names: Object.keys(freshEnvVars).sort((left, right) =>
        left.localeCompare(right),
      ),
    };
  },
);
