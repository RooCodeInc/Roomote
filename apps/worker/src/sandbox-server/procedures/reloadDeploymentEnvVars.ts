import { TRPCError } from '@trpc/server';

import { sdk } from '@roomote/sdk/client';

import { injectEnvVars } from '../../commands/utils/env-vars';
import type { WorkerEnv } from '../../env';
import { runUnlessCredentialWriteBarrier } from '../../lib';
import { splitLegacyModelRuntimeEnv } from '../../run-task/env';

import type { Harness } from '../lib/harness';
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

function envValuesEqual(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftEntries = Object.entries(left);

  return (
    leftEntries.length === Object.keys(right).length &&
    leftEntries.every(([name, value]) => right[name] === value)
  );
}

function isSplitResolvedEnv(value: unknown): value is {
  envVars: Record<string, string>;
  modelRuntimeEnv: Record<string, string>;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'envVars' in value &&
    typeof value.envVars === 'object' &&
    value.envVars !== null &&
    'modelRuntimeEnv' in value &&
    typeof value.modelRuntimeEnv === 'object' &&
    value.modelRuntimeEnv !== null
  );
}

/**
 * Fetch the deployment's current env vars and rewrite the sandbox env
 * (env.sh, runtime env, harness command env) from them. Shared by the live
 * reload mutation and the post-snapshot-failure credential restore. The
 * returned `envVars` carry raw values and must never be returned to RPC
 * callers.
 */
export async function applyDeploymentEnvVarsReload(input: {
  runId: number;
  workerEnv: WorkerEnv;
  harness: Harness;
}): Promise<{ names: string[]; envVars: Record<string, string> }> {
  const { runId, workerEnv, harness } = input;

  const [resolvedEnv, taskRun] = await Promise.all([
    sdk.taskRuns.getResolvedRuntimeEnvVars({ runId, envContractVersion: 2 }),
    sdk.taskRuns.findFirstById(runId),
  ]);

  if (!taskRun) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Task run not found',
    });
  }

  const normalizedEnv = isSplitResolvedEnv(resolvedEnv)
    ? resolvedEnv
    : splitLegacyModelRuntimeEnv(resolvedEnv);
  const { envVars: freshEnvVars, modelRuntimeEnv } = normalizedEnv;

  const currentRuntimeEnv = workerEnv.getRuntimeEnv();
  const currentModelRuntimeEnv = workerEnv.getModelRuntimeEnv();
  const nextRuntimeEnv: Record<string, string> = { ...freshEnvVars };

  await injectEnvVars(nextRuntimeEnv, taskRun, {
    previewProxyBaseUrl: workerEnv.previewProxyBaseUrl,
    previewProxySubdomainSuffix: workerEnv.previewProxySubdomainSuffix,
    syncSourceControlTokenFiles: false,
  });

  workerEnv.setRuntimeEnv(nextRuntimeEnv);
  workerEnv.setModelRuntimeEnv(modelRuntimeEnv);

  const currentCommandEnv = harness.getCommandEnv?.() ?? {};
  const baseCommandEnv = omitKeys(currentCommandEnv, [
    ...Object.keys(currentRuntimeEnv),
    ...Object.keys(currentModelRuntimeEnv),
  ]);

  harness.setCommandEnv?.({
    ...baseCommandEnv,
    ...nextRuntimeEnv,
    ...modelRuntimeEnv,
  });

  if (!envValuesEqual(currentModelRuntimeEnv, modelRuntimeEnv)) {
    if (!harness.requestReconnect) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Model credentials require a reconnectable harness',
      });
    }

    await harness.requestReconnect({
      reason: 'model runtime environment changed',
    });
  }

  return {
    names: Object.keys(freshEnvVars).sort((left, right) =>
      left.localeCompare(right),
    ),
    envVars: freshEnvVars,
  };
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
    const reloadResult = await runUnlessCredentialWriteBarrier(() =>
      applyDeploymentEnvVarsReload({ runId, workerEnv, harness }),
    );

    if (!reloadResult) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'Environment reload is unavailable while the sandbox prepares for a snapshot',
      });
    }

    // Only the names leave the sandbox; the raw values stay in-process.
    return { success: true as const, names: reloadResult.names };
  },
);
